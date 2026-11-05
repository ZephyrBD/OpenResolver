import http from 'node:http';
import path from 'node:path';
import { sendJson, apiError } from './http/respond.mjs';
import { readJson, DEFAULT_MAX_BODY_BYTES } from './http/body.mjs';
import { HttpError } from './http/errors.mjs';
import { RouteError, routeModel } from './routing.mjs';
import { AuthError, authorize, extractSecret } from './auth/guard.mjs';
import { estimateTokens } from './tokens.mjs';
import {
  chatCompletionsToMessages,
  anthropicToChatCompletion,
  aggregateAnthropicSseToChatCompletion,
} from './adapters/openai-to-anthropic.mjs';
import { createSseParser } from './adapters/sse-reader.mjs';
import { createUsageRecorder } from './panel/usage.mjs';
import { DEFAULT_SETTINGS } from './pools/settings.mjs';

const EMPTY_DB = { version: 1, keys: [] };

function clientIp(req) {
  return req.socket?.remoteAddress || '';
}

/**
 * 捕获本网关写回客户端的响应体（限 1MB），收尾时取 usage 记用量。
 * Anthropic 非流式与 chat 聚合响应体都带 usage；流式/取不到填 0（§11 尽力而为）。
 */
function tapResponse(res, onEnd) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  const origWrite = res.write.bind(res);
  const origEnd = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk && !truncated) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      total += buf.length;
      if (total > 1_048_576) truncated = true;
      else chunks.push(buf);
    }
    return origWrite(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (chunk && !truncated) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      chunks.push(buf);
    }
    const result = origEnd(chunk, ...rest);
    onEnd(Buffer.concat(chunks).toString('utf8'));
    return result;
  };
}

function usageOfJson(text) {
  let usage = {};
  try {
    usage = JSON.parse(text)?.usage ?? {};
  } catch {
    usage = {}; // 流式/不可解析 → 0
  }
  return {
    inputTokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function toGatewayModel(pool, model) {
  return {
    id: `${pool.name}/${model.id}`,
    object: 'model',
    display_name: model.display_name || model.id,
    upstream_model: model.id,
    pool: pool.name,
    context_window: model.context_window ?? null,
    supports_tools: model.supports_tools ?? false,
    supports_thinking: model.supports_thinking ?? false,
    created: 0,
  };
}

function visiblePools(pools, key) {
  const allow = key?.enabledPools;
  if (!Array.isArray(allow) || !allow.length) return pools;
  return pools.filter((p) => allow.includes(p.name));
}

export function createGateway({ config = {}, pools = [], db = EMPTY_DB, panel = null, usage = null } = {}) {
  const version = config.version ?? '';
  const poolNames = pools.map((p) => p.name);
  const byName = new Map(pools.map((p) => [p.name, p]));
  const usageRecorder =
    usage ??
    createUsageRecorder({
      dataDir: config.dataDir ? path.resolve(config.dataDir) : null,
      maxFileBytes: config.maxUsageFileBytes,
    });

  const handleModels = (req, res) => {
    const key = authorize({
      secret: extractSecret(req.headers),
      ip: clientIp(req),
      db,
      config,
    }).key;
    const data = visiblePools(pools, key).flatMap((p) => p.models().map((m) => toGatewayModel(p, m)));
    return sendJson(res, 200, { object: 'list', data });
  };

  /**
   * 池名 → 折算比率（credits→token）。zcode/trae 明细本身就是 token（×1）；
   * workbuddy/qoder/codearts 的明细是 credit，各自可配折算率。
   */
  const creditRateOf = (poolName, settings) => {
    if (poolName === 'codearts')
      return settings.codeartsCreditTokensRate ?? DEFAULT_SETTINGS.codeartsCreditTokensRate;
    if (poolName === 'workbuddy' || poolName === 'workbuddy-cn')
      return settings.wbCreditTokensRate ?? DEFAULT_SETTINGS.wbCreditTokensRate;
    if (poolName === 'qoder' || poolName === 'qoder-cn')
      return settings.qoderCreditTokensRate ?? DEFAULT_SETTINGS.qoderCreditTokensRate;
    return 1;
  };

  /** GET /user/balance：全池折算 token 剩余（cc-switch 轮询余额用）。 */
  const handleBalance = async (req, res) => {
    authorize({ secret: extractSecret(req.headers), ip: clientIp(req), db, config });
    // 比率取自池设置全局（面板 PATCH /api/settings 广播到所有池，读任意一份即可）
    const head = pools[0];
    const scheduler = head?.scheduler ?? head;
    const settings = scheduler && typeof scheduler === 'object' && scheduler.settings ? scheduler.settings : {};
    const credited = {};
    let balance = 0;
    for (const pool of pools) {
      let tokens = 0;
      const rate = creditRateOf(pool.name, settings);
      if (rate > 0 && typeof pool.quota?.get === 'function') {
        let credits = 0;
        for (const acc of pool.accounts || []) {
          if (acc?.enabled === false) continue;
          try {
            const q = await pool.quota.get(acc);
            for (const d of q?.details ?? []) {
              const remaining = Number(d?.remaining); // null → 0，NaN → 跳过
              if (Number.isFinite(remaining)) credits += remaining;
            }
          } catch {
            // 单账号回源失败贡献 0：绝不拖垮路由，也绝不外泄秘钥
          }
        }
        if (Number.isFinite(credits)) tokens = Math.round(credits * rate);
      }
      credited[pool.name] = tokens;
      balance += tokens;
    }
    return sendJson(res, 200, {
      is_active: true,
      balance,
      unit: 'token',
      fetched_at: Date.now(),
      pools: credited,
    });
  };

  const handleMessages = async (req, res, url) => {
    const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const { pool: poolName, model } = routeModel(body.model, poolNames);
    const { key } = authorize({
      secret: extractSecret(req.headers),
      ip: clientIp(req),
      db,
      config,
      pool: poolName,
      model,
    });

    const pool = byName.get(poolName);
    if (typeof pool.send !== 'function') {
      throw new HttpError(501, `池 "${poolName}" 暂时不支持 /v1/messages`, { type: 'api_error' });
    }

    const startedAt = Date.now();
    if (usageRecorder.active) {
      tapResponse(res, (text) => {
        usageRecorder.record({
          pool: poolName,
          model,
          keyId: key?.id ?? null,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          ...usageOfJson(text),
        });
      });
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    return pool.send({ req, res, body: { ...body, model }, key, signal: controller.signal, url });
  };

  const handleCountTokens = async (req, res) => {
    const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const { pool: poolName, model } = routeModel(body.model, poolNames);
    authorize({
      secret: extractSecret(req.headers),
      ip: clientIp(req),
      db,
      config,
      pool: poolName,
      model,
    });
    return sendJson(res, 200, { input_tokens: estimateTokens(body) });
  };

  const handleChatCompletions = async (req, res, url) => {
    const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    if (body.stream === true) {
      throw new HttpError(400, '/v1/chat/completions 暂不支持流式，请设 stream:false', {
        type: 'invalid_request_error',
      });
    }
    const { pool: poolName, model } = routeModel(body.model, poolNames);
    const { key } = authorize({
      secret: extractSecret(req.headers),
      ip: clientIp(req),
      db,
      config,
      pool: poolName,
      model,
    });

    const pool = byName.get(poolName);
    if (typeof pool.sendCollect !== 'function') {
      throw new HttpError(501, `池 "${poolName}" 暂不支持 /v1/chat/completions`, { type: 'api_error' });
    }

    const requestedModel = typeof body.model === 'string' ? body.model : model;
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const startedAt = Date.now();
    if (usageRecorder.active) {
      tapResponse(res, (text) => {
        usageRecorder.record({
          pool: poolName,
          model: requestedModel,
          keyId: key?.id ?? null,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          ...usageOfJson(text),
        });
      });
    }
    const collected = await pool.sendCollect({
      req,
      res,
      body: { ...chatCompletionsToMessages(body), model },
      key,
      signal: controller.signal,
      url,
    });
    if (!collected) return; // 客户端已断开

    const contentType = collected.contentType || '';
    let completion;
    if (contentType.includes('text/event-stream')) {
      const parser = createSseParser();
      const events = [...parser.push(collected.bodyText), ...parser.drain()];
      completion = await aggregateAnthropicSseToChatCompletion(events, requestedModel);
    } else {
      let upstream;
      try {
        upstream = JSON.parse(collected.bodyText);
      } catch {
        throw new HttpError(502, '上游返回了无法解析的 JSON', { type: 'api_error' });
      }
      completion = anthropicToChatCompletion(upstream, requestedModel);
    }
    return sendJson(res, 200, completion);
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, version, pools: pools.map((p) => p.name) });
      }
      // /user/balance 是推理面路由（Bearer zsk_ 认证），必须放在面板分支之前：
      // 面板分支按 `!pathname.startsWith('/v1/')` 抢占，放进去会被面板 404 吞掉。
      if (req.method === 'GET' && url.pathname === '/user/balance') {
        return await handleBalance(req, res);
      }
      if (panel && !url.pathname.startsWith('/v1/')) {
        // 面板面：/、/panel/*、/auth/*、/api/*，其余由面板侧统一 404
        return panel.handle(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return handleModels(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        return await handleCountTokens(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        return await handleMessages(req, res, url);
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await handleChatCompletions(req, res, url);
      }
      throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
    } catch (err) {
      if (res.headersSent) return res.destroy();
      const known = err instanceof HttpError || err instanceof RouteError || err instanceof AuthError;
      const status = known ? err.status : 500;
      if (!known) console.error('[gateway] 未捕获错误:', err);
      const payload = apiError(status, known ? err.message : '网关内部错误', known ? err.type : 'api_error');
      if (known && err.code) payload.error.code = err.code;
      return sendJson(res, status, payload);
    }
  });
}
