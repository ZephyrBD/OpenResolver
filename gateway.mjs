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

  /** 池子自身的额度单位：明细就是 token 的池，其余按 credit 原样输出。 */
  const unitOf = (poolName) => (poolName === 'zcode' || poolName === 'trae' ? 'token' : 'credit');

  /** GET /v1/pool/balance：按池汇总 enabled 账号的原始剩余/总额度（不折算，只遍历 key 可见的池）。 */
  const handleBalance = async (req, res) => {
    const key = authorize({ secret: extractSecret(req.headers), ip: clientIp(req), db, config }).key;
    const list = [];
    for (const pool of visiblePools(pools, key)) {
      let balance = 0;
      let total = null;
      let accounts = 0;
      let ok = 0;
      if (typeof pool.quota?.get === 'function') {
        for (const acc of pool.accounts || []) {
          if (acc?.enabled === false) continue;
          accounts++;
          try {
            const q = await pool.quota.get(acc);
            for (const d of q?.details ?? []) {
              const remaining = Number(d?.remaining); // null → 0，NaN → 跳过
              if (Number.isFinite(remaining)) balance += remaining;
              const raw = d?.total; // null/undefined → 缺失；非有限数 → 不计入
              if (raw != null) {
                const t = Number(raw);
                if (Number.isFinite(t)) total = (total ?? 0) + t;
              }
            }
            ok++;
          } catch {
            // 单账号回源失败贡献 0：绝不拖垮路由，也绝不外泄秘钥
          }
        }
      }
      list.push({ name: pool.name, unit: unitOf(pool.name), balance, total, accounts, ok });
    }
    return sendJson(res, 200, { fetched_at: Date.now(), pools: list });
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
      if (panel && !url.pathname.startsWith('/v1/')) {
        // 面板面：/、/panel/*、/auth/*、/api/*，其余由面板侧统一 404
        return panel.handle(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return handleModels(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/v1/pool/balance') {
        return await handleBalance(req, res);
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
