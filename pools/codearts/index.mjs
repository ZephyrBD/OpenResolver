// 华为 CodeArts 池（第 7 个池）。契约与 pools/workbuddy/index.mjs 同形：
// send / sendCollect 共用 dispatch，classifyUpstreamError 同名同形状导出。
//
// 上游 POST {SnapEngineApiHost}/api/v2/chat/completions 已是 OpenAI 兼容形状
// （vendor client.go:441-582），请求/响应转换复用 M2 adapters：
//   messagesToChatCompletions（Anthropic→chat 请求）+ openaiSseToAnthropicEvents（SSE→Anthropic）。
// 鉴权双因子：x-auth-token（STS security_token）+ SDK-HMAC-SHA256 AK/SK 签名
// （signRequest 在签名前写入全部业务头，maas_type: benefit 计入 SignedHeaders）。
//
// 错误分类（简报 §6）：
// - 401/凭证失效 → auth（base 标 needs_login，与可重试分开）；
// - 流内 error_code 信封按 embeddedSseError 状态分类（429/TPM→rate_limit、
//   4004.200/param invalid→client 该请求级、其余→server）；
// - 5xx/网络 → server；其余 → client。

import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../../http/errors.mjs';
import { createPoolScheduler, sessionKeyOf } from '../base.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';
import { messagesToChatCompletions } from '../../adapters/anthropic-to-openai.mjs';
import { SNAP_ENGINE_API_HOST, BENEFIT_HOST, EP_CHAT_V2 } from './constants.mjs';
import { signRequest } from './signer.mjs';
import { consumeCaSse, embeddedSseStatus, CaStreamError } from './stream.mjs';
import { createTokenManager } from './auth.mjs';
import { createCodeartsModelCatalog, accountKeyOf } from './models.mjs';
import { fetchCreditCampaigns } from './checkin.mjs';
import { createCodeartsQuotaCache } from './quota.mjs';

/** HTTP 层错误分类。error_code 信封（HTTP 200 内嵌）也落到这里（合成 status）。 */
export function classifyUpstreamError(status, bodyText) {
  let errorCode = '';
  let msg = '';
  try {
    const json = JSON.parse(bodyText);
    if (typeof json?.error_code === 'string' && json.error_code && json.error_code !== '0') {
      errorCode = json.error_code;
      msg = String(json.error_msg ?? '');
    } else {
      msg = String(json?.msg ?? json?.error?.message ?? json?.error_msg ?? '');
    }
  } catch {
    // 非 JSON 体按 HTTP 状态分类
  }
  if (errorCode === 'TM.000010051') {
    return {
      kind: 'client',
      code: errorCode,
      retryable: false,
      message: 'CodeArts 模型未开通：请在 CodeArts 控制台开通该模型，或改用 /v1/models 中列出的模型',
    };
  }
  if (errorCode && status !== 401 && status !== 403) {
    const synthetic = embeddedSseStatus(errorCode, msg);
    const kind = synthetic === 429 ? 'rate_limit' : synthetic === 400 ? 'client' : 'server';
    return {
      kind,
      code: errorCode,
      retryable: kind !== 'client',
      message: `CodeArts 上游业务错误 ${errorCode}${msg ? `：${msg}` : ''}`,
    };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: status, retryable: false, message: 'CodeArts 凭证失效，需要重新登录' };
  }
  if (status === 429) return { kind: 'rate_limit', code: 429, retryable: true, message: 'CodeArts 上游限流' };
  if (status >= 500) return { kind: 'server', code: status, retryable: true, message: `CodeArts 上游错误 ${status}` };
  return { kind: 'client', code: status, retryable: false, message: `CodeArts 上游拒绝了请求 ${status}${msg ? `：${msg}` : ''}` };
}

function errorFrom(cls, status) {
  const httpStatus =
    cls.kind === 'rate_limit' ? 429 : cls.kind === 'server' ? 502 : cls.kind === 'client' ? 400 : status || 502;
  const err = new HttpError(httpStatus, cls.message, {
    type:
      cls.kind === 'auth'
        ? 'authentication_error'
        : cls.kind === 'rate_limit'
          ? 'rate_limit_error'
          : cls.kind === 'client'
            ? 'invalid_request_error'
            : 'api_error',
  });
  return err;
}

/** Anthropic 事件序列 → 完整 message JSON（非流式出站 / sendCollect 用）。 */
export function anthropicMessageFromEvents(events) {
  let message = null;
  const blocks = [];
  let stopReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const ev of events) {
    if (ev.type === 'message_start') {
      message = ev.message;
    } else if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block, __parts: [] };
    } else if (ev.type === 'content_block_delta') {
      const block = blocks[ev.index];
      if (!block) continue;
      if (ev.delta?.type === 'text_delta') block.__parts.push(ev.delta.text ?? '');
      else if (ev.delta?.type === 'input_json_delta') block.__parts.push(ev.delta.partial_json ?? '');
    } else if (ev.type === 'message_delta') {
      stopReason = ev.delta?.stop_reason ?? stopReason;
      usage = { ...usage, ...(ev.usage ?? {}) };
    }
  }
  const base = message ?? {
    id: 'msg_codearts',
    type: 'message',
    role: 'assistant',
    model: 'unknown',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const content = blocks.filter(Boolean).map((b) => {
    const text = b.__parts.join('');
    if (b.type === 'tool_use') {
      let input = {};
      try {
        input = text ? JSON.parse(text) : {};
      } catch {
        input = {};
      }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    }
    if (b.type === 'thinking') return { type: 'thinking', thinking: text };
    return { type: 'text', text };
  });
  return { ...base, content, stop_reason: stopReason ?? base.stop_reason, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } };
}

/** chatBodyV2（client.go:476-506）：OpenAI 形状 + CodeArts 亲和字段。 */
export function buildCaPayload(body, model, chatId) {
  const payload = messagesToChatCompletions(body);
  payload.model = model;
  payload.stream = true;
  payload.prompt_cache_key = chatId;
  payload.tool_stream = true;
  if (chatId) payload.chat_id = chatId;
  return payload;
}

// sessionIDFor（client.go:536-539）：chatID 派生的稳定会话标识（prompt cache 亲和）。
export function sessionIdFor(chatId) {
  return crypto.createHash('sha256').update(`codearts-session:${chatId}`, 'utf8').digest('hex').slice(0, 32);
}

// ChatHeadersV2（client.go:442-458 + baseHeaders）：x-auth-token + AK/SK 签名。
// 上游按 x-ot-session-id 统计并发会话（每账号 3 个），必须按凭证复用稳定 ID；
// model-id / model-name 必须与请求体 model 完全一致（上游会校验，且区分大小写）。
export function upstreamSessionId(acc, cred) {
  const key = `${acc?.domainId || ''}|${cred?.accessKeyID || ''}` || String(acc?.id || '');
  return 'ses_' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function chatHeadersV2(token, traceID, { model, sessionId, language = 'zh-cn' } = {}) {
  const span = crypto.randomBytes(8).toString('hex');
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'x-auth-token': token,
    'x-snap-traceid': `${traceID}_${span}`,
    'X-Language': language,
    'app-id': 'CodeAgent3.0',
    is_confidential: 'false',
    'x-ot-function': 'agent-general',
    'x-ot-trace-id': traceID,
    'x-ot-span-id': span,
    'x-ot-client-type': 'IDE',
    'x-ot-client-version': '26.9.902',
    'plugin-name': 'snap_AIIDE',
    'plugin-version': '26.9.902',
    'ide-name': 'VSCode',
    'ide-version': '26.9.902',
    'created-time': new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    'user-msg-id': `msg_${crypto.randomBytes(6).toString('hex')}`,
    'x-ot-session-id': sessionId,
    'x-ot-parent-session-id': '',
    'user-session-id': sessionId,
    ...(model ? { 'model-id': model, 'model-name': model } : {}),
  };
}

export function createCodeartsPool({
  accounts = [],
  config = {},
  fetchImpl = fetch,
  rng = Math.random,
  now = Date.now,
} = {}) {
  const name = 'codearts';
  const dataDir = config.dataDir || '.';
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 600_000;
  const snapBase = config.snapBase || SNAP_ENGINE_API_HOST;
  const benefitBase = config.benefitBase || BENEFIT_HOST;
  const chatUrl = config.endpoints?.chat || `${snapBase}${EP_CHAT_V2}`;
  const accountsFile = config.accountsFile || path.join(dataDir, 'pools', name, 'accounts.json');
  const claimAuto = config.claimAuto ?? true;

  const catalog = createCodeartsModelCatalog({
    now,
    fetchImpl,
    snapBase: config.endpoints?.models || snapBase,
    benefitBase: config.endpoints?.benefit || benefitBase,
    claimAuto,
  });

  /**
   * 额度/签到回源前的凭证解析：STS 只有 ~2h，过期就用 token 管理器刷新并整组落盘。
   * quota 模块把它当 async provider（cred=null 时抛「凭证不可用」走 stale/unknown）。
   */
  async function credsOf(acc) {
    const { cred, patch } = await tokens.accessFor(acc);
    if (patch) {
      scheduler.updateAccount(acc.id, patch);
      persistTokenPatch(acc.id, patch);
      Object.assign(acc, patch);
    }
    return cred; // null 表示登录真失效
  }

  const quota =
    config.quota ||
    createCodeartsQuotaCache({ snapBase: config.endpoints?.biz || snapBase, fetchImpl, now, credsOf });

  const scheduler = createPoolScheduler({
    name,
    accounts,
    settings: {
      ...(config.poolSettings || {}),
      // 上游硬限制：每个账号最多 3 个并发会话（TM.00001041）。超过只会排队失败。
      maxInFlight: config.maxInFlight ?? Math.min(config.poolSettings?.maxInFlight ?? 3, 3),
      ...(config.maxAttempts != null ? { maxAttempts: config.maxAttempts } : {}),
    },
    settingsFile: config.settingsFile,
    quotaRatio: (acc) => quota.peek(acc),
    rng,
    now,
  });

  const state = scheduler.accounts;
  const maxAttempts = Math.max(1, config.maxAttempts ?? scheduler.settings.maxAttempts);
  const tokens = createTokenManager({ fetchImpl, now, cfg: config.loginConfig });

  /** 刷新出的新 STS 凭证整组立即原子落盘（refresh_token 与 DPoP 公钥双绑定）。 */
  function persistTokenPatch(accId, patch) {
    if (!accountsFile) return;
    try {
      const dir = path.dirname(accountsFile);
      const list = loadAccounts(dir);
      const row = list.find((a) => a.id === accId);
      if (!row) return;
      Object.assign(row, patch);
      saveAccounts(dir, list);
    } catch (err) {
      console.error(`[ca] token patch 落盘失败（${accId}）：${err?.message}`);
    }
  }

  function writeAnthropicError(res, err) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: err.type, message: err.message } })}\n\n`);
  }

  function unavailable(cause) {
    const info = scheduler.unavailableInfo();
    if (!info.pool) {
      return new HttpError(429, '没有可用账号，请检查账号状态', { type: 'rate_limit_error' });
    }
    if (!info.cooling && info.saturated) {
      return new HttpError(429, '当前并发已满，请稍后重试', { type: 'rate_limit_error' });
    }
    const waitMs = Math.max(0, (info.soonestRecovery || scheduler.soonestRecovery()) - scheduler.now());
    const suffix = cause ? `（最后错误：${cause}）` : '';
    return new HttpError(429, `所有 CodeArts 账号暂不可用，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后恢复${suffix}`, {
      type: 'rate_limit_error',
    });
  }

  async function dispatch({ req, res, body, key, signal, collect }) {
    let lastError = null;
    const tried = new Set();
    const stickyKey = sessionKeyOf({ req, body, keyId: key?.id });
    const upstreamModel = catalog.canonicalModel(body.model);
    const chatId = crypto.randomUUID();

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let acc = null;
      if (stickyKey) {
        if (attempt === 0) {
          const bound = scheduler.stickyGet(stickyKey, { readyOnly: true });
          if (bound && !tried.has(bound.id)) acc = bound;
          else scheduler.stickyClear(stickyKey);
        } else {
          scheduler.stickyClear(stickyKey);
        }
      }
      if (!acc) acc = scheduler.pick({ exclude: tried, allowFallback: attempt > 0 });
      if (!acc) throw unavailable(lastError?.message);
      tried.add(acc.id);

      const { cred, patch, expired } = await tokens.accessFor(acc);
      if (!cred) {
        // 终态失效 → needs_login；可重试失败只记错误换下一个账号
        scheduler.onUpstreamError(acc, {
          kind: 'auth',
          code: 0,
          retryable: false,
          message: expired ? 'refresh_token 已失效，需要重新登录' : '无可用凭证',
        });
        lastError = errorFrom(
          { kind: 'auth', message: expired ? `账号 ${acc.id} 的登录已失效，请在面板重新 onboard` : `账号 ${acc.id} 缺少可用凭证` },
          401,
        );
        continue;
      }
      if (patch) {
        scheduler.updateAccount(acc.id, patch);
        persistTokenPatch(acc.id, patch);
        Object.assign(acc, patch);
      }

      const payload = buildCaPayload(body, upstreamModel, chatId);
      const sessionId = upstreamSessionId(acc, cred);
      const headers = chatHeadersV2(cred.securityToken, crypto.randomUUID(), {
        model: upstreamModel,
        sessionId,
      });
      const signed = signRequest({ method: 'POST', url: chatUrl, headers, body: JSON.stringify(payload) }, cred);
      // vendor client.go:566-571：签名之后设置，不进 SignedHeaders；prompt cache 亲和 + 会话标识
      signed['chat-id'] = chatId;
      signed['session-id'] = sessionIdFor(chatId);

      const timeout = AbortSignal.timeout(upstreamTimeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      acc.inFlight += 1;

      let upstream;
      try {
        upstream = await fetchImpl(chatUrl, { method: 'POST', headers: signed, body: JSON.stringify(payload), signal: sig });
      } catch (err) {
        if (signal?.aborted) return;
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err.message });
        lastError = timeout.aborted
          ? new HttpError(504, `CodeArts 上游 ${upstreamTimeoutMs}ms 内无响应`, { type: 'api_error' })
          : new HttpError(502, `连接 CodeArts 上游失败：${err.message}`, { type: 'api_error' });
        continue;
      } finally {
        acc.inFlight -= 1;
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        const cls = classifyUpstreamError(upstream.status, text);
        if (cls.kind === 'client' && !cls.retryable) throw errorFrom(cls, upstream.status);
        scheduler.onUpstreamError(acc, cls);
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (!cls.retryable) throw errorFrom(cls, upstream.status);
        lastError = errorFrom(cls, upstream.status);
        continue;
      }

      // HTTP 200：OpenAI SSE（流内 error_code 信封也在 consumeCaSse 冒出）。
      const streaming = !collect && body.stream === true;
      let wrote = false;
      const events = [];
      try {
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          wrote = true;
        }
        await consumeCaSse(upstream, {
          model: upstreamModel,
          signal,
          onEvents: (batch) => {
            events.push(...batch);
            if (streaming) {
              for (const ev of batch) {
                res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
              }
            }
          },
        });
      } catch (err) {
        if (err instanceof CaStreamError) {
          const cls = classifyUpstreamError(200, JSON.stringify({ error_code: err.biz.code, error_msg: err.biz.msg }));
          // 请求级客户端错误（如 TM.000010051 模型未开通）不重试、不惩罚账号：
          // 换号/冷却都救不了，惩罚只会让同账号其它模型一起不可用 6 小时。
          if (cls.kind === 'client' && !cls.retryable) {
            if (streaming && wrote) {
              writeAnthropicError(res, errorFrom(cls, 400));
              res.end();
              return;
            }
            throw errorFrom(cls, 400);
          }
          // 流内业务错误照 Trae 坑位处理：先分类记账再决定客户端出口
          scheduler.onUpstreamError(acc, cls);
          if (stickyKey) scheduler.stickyClear(stickyKey);
          if (streaming && wrote) {
            writeAnthropicError(res, errorFrom(cls, cls.kind === 'client' ? 400 : 502));
            res.end();
            return;
          }
          lastError = errorFrom(cls, cls.kind === 'client' ? 400 : 502);
          continue;
        }
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err?.message || 'SSE 解码失败' });
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (streaming && wrote) {
          writeAnthropicError(res, new HttpError(502, `CodeArts 上游流中断：${err?.message}`, { type: 'api_error' }));
          res.end();
          return;
        }
        lastError = new HttpError(502, `CodeArts 上游流中断：${err?.message}`, { type: 'api_error' });
        continue;
      }

      scheduler.onSuccess(acc);
      if (stickyKey) scheduler.stickySet(stickyKey, acc);
      // 额度感知调度：fire-and-forget（cache 内部 5min TTL + 失败退避），
      // 让 peek() 喂给 scheduler 与 /api/pools 均值，但不增加本次响应延迟。
      quota.get(acc).catch(() => {});

      if (streaming) {
        res.end();
        return;
      }
      const messageJson = anthropicMessageFromEvents(events);
      const bodyText = JSON.stringify(messageJson);
      if (collect) return { status: 200, contentType: 'application/json', bodyText };
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(bodyText);
      return;
    }

    if (signal?.aborted) return;
    throw lastError ?? unavailable();
  }

  function send(args) {
    return dispatch({ ...args, collect: false });
  }

  function sendCollect(args) {
    return dispatch({ ...args, collect: true });
  }

  /** 签到状态（只读，checkin.go FetchCreditCampaigns）。 */
  async function checkinStatus(acc) {
    return fetchCreditCampaigns({
      cred: { accessKeyID: acc.accessKeyID, secretAccessKey: acc.secretAccessKey, securityToken: acc.securityToken },
      snapBase: config.endpoints?.biz || snapBase,
      fetchImpl,
    });
  }

  return {
    name,
    type: 'pool',
    accounts: state,
    scheduler,
    catalog,
    models: () => {
      const acc = state.find((a) => a.securityToken) ?? null;
      return catalog.models(acc ? accountKeyOf(acc) : '').map((m) => ({
        id: m.id,
        display_name: m.display_name || m.id,
        upstream_model: m.id,
        context_window: m.context_window ?? null,
        max_tokens: m.max_tokens ?? null,
        supports_tools: m.supports_tools !== false,
        supports_thinking: m.supports_thinking !== false,
        benefit: Boolean(m.benefit),
      }));
    },
    refreshModels: async () => {
      const acc = state.find((a) => a.securityToken) ?? null;
      return acc ? catalog.refreshModels(acc) : false;
    },
    checkin: checkinStatus,
    quota,
    // 供 claimer/scheduler 使用：领取前刷新 STS（内部已整组落盘 + 回写运行态）
    credsOf,
    send,
    sendCollect,
  };
}
