import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/errors.mjs';
import { sendJson } from '../http/respond.mjs';
import { readJson, DEFAULT_MAX_BODY_BYTES } from '../http/body.mjs';
import { SETTING_KEYS } from '../pools/settings.mjs';
import { loadAccounts, saveAccounts } from '../pools/zcode/accounts.mjs';
import { deviceIdFor, sessionIdFor } from '../fingerprint.mjs';

// CodeArts 登录端点默认值来自 LOGIN_CONFIG_DEFAULTS（生产华为云）；
// 测试可经 createPanelGateway({ caLoginConfig }) 注入桩 host。
import { BILLING_ENDPOINT_CN, BILLING_ENDPOINT_GLOBAL } from '../pools/workbuddy/constants.mjs';
import { ZCODE_ORIGIN } from '../pools/zcode/constants.mjs';
import { createKey } from '../auth/keys.mjs';
import { saveKeys } from '../auth/store.mjs';
import { SESSION_TTL_MS, logLoginAttempt, readLoginLog, parseCookies } from './admin.mjs';
import { csrfOk } from './csrf.mjs';
import { LOGIN_CONFIG_DEFAULTS } from '../pools/codearts/oauth.mjs';
import { createStaticHandler } from './static.mjs';
import { createOnboardHandlers } from './onboard-handlers.mjs';
import { createAuthHandlers } from './auth-handlers.mjs';
import {
  SECURITY_HEADERS,
  SENSITIVE_FIELDS,
  ACCOUNT_PATCH_FIELDS,
  FLOW_TTL_MS,
  clampManual,
  claimerCheckinOf,
  safeDecode,
  poolByName,
  sched,
  keyView,
  runtimeAccount,
  upsertRuntimeAccount,
  accountView,
  displayNameOf,
} from './shared.mjs';
import { readJson as readJsonFile, writeJson as writeJsonFile } from './store.mjs';

// 兼容既有导入方（test/quota.route.test.js 等从 api.mjs 取视图函数）
export { accountView, displayNameOf };

/**
 * 面板网关（文档 §9.2 / §10 / §12）：管理员认证 + CSRF + 面板 API + 静态挂载点。
 * 独立于推理面：gateway.mjs 只挂一个 handle(req,res) 分流；推理面（/v1/*）与本模块无关。
 */

export function createPanelGateway({
  config = {},
  pools = [],
  db,
  keysFile,
  dataDir,
  now = Date.now,
  fetchImpl = fetch,
  secureCookie = false,
  publicDir = path.join(import.meta.dirname, '..', 'frontend', 'dist'),
  usage = null,
  traeApiHost,
  qoderExchangeUrl,
  qoderUserinfoUrl,
  wbEndpointCn = process.env.UGW_WB_ENDPOINT_CN || BILLING_ENDPOINT_CN,
  wbEndpointGlobal = process.env.UGW_WB_ENDPOINT_GLOBAL || BILLING_ENDPOINT_GLOBAL,
  caLoginConfig,
  sessionTtlMs = SESSION_TTL_MS,
  zcodeOrigin = process.env.UGW_ZCODE_ORIGIN || ZCODE_ORIGIN,
  claimers = {},
  claimScheduler = null,
} = {}) {
  const adminFile = path.join(dataDir, 'admin.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const securityFile = path.join(dataDir, 'security.json');
  const loginLogFile = path.join(dataDir, 'login-log.jsonl');
  const flowsFile = path.join(dataDir, 'onboard-flows.json');
  const LOGIN_CONFIG = caLoginConfig || LOGIN_CONFIG_DEFAULTS;
  const serveStatic = createStaticHandler({ publicDir });

  const clientIp = (req) => req.socket?.remoteAddress || '';

  // 认证处理块拆分至 auth-handlers.mjs（02 §4）：登录/登出/会话校验/改密
  const { requireSession, handleAuth } = createAuthHandlers({
    adminFile,
    sessionsFile,
    securityFile,
    loginLogFile,
    sessionTtlMs,
    now,
    config,
    secureCookie,
    clientIp,
  });

  // ---- /api/* ----

  function overview() {
    const poolStats = pools.map((p) => {
      const accounts = p.accounts || [];
      const t = now();
      return {
        name: p.name,
        type: p.type ?? 'pool',
        accounts: accounts.length,
        ok: accounts.filter((a) => a.state === 'ok').length,
        cooling: accounts.filter((a) => (a.cooldownUntil ?? 0) > t).length,
        needsLogin: accounts.filter((a) => a.state === 'needs_login').length,
      };
    });
    return {
      pools: poolStats,
      totalKeys: db?.keys?.length ?? 0,
      today: usage ? usage.today() : { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 },
      usageDegraded: usage ? usage.degraded : false,
    };
  }

  function accountsDirOf(pool) {
    return path.join(dataDir, 'pools', pool.name);
  }

  async function handleAccounts(req, res, pool) {
    if (req.method === 'GET') {
      return sendJson(res, 200, { pool: pool.name, accounts: (pool.accounts || []).map(accountView) });
    }
    if (req.method === 'POST') {
      if (pool.type !== 'pool') {
        throw new HttpError(405, '该池不是 Pool 型，不支持手动新增账号', { type: 'api_error' });
      }
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (typeof body !== 'object' || Array.isArray(body) || !body) {
        throw new HttpError(400, '账号必须是 JSON 对象', { type: 'invalid_request_error' });
      }
      const dir = accountsDirOf(pool);
      if (typeof body.id === 'string' && body.id) {
        const exists = loadAccounts(dir).some((a) => a.id === body.id) || (pool.accounts || []).some((a) => a.id === body.id);
        if (exists) {
          throw new HttpError(409, `账号 id "${body.id}" 已存在，不能覆盖`, { type: 'invalid_request_error' });
        }
      }
      // 凭证/元数据字段按池自由携带，但调度运行态（内部字段）不允许客户端注入
      const RUNTIME_ONLY_FIELDS = ['inFlight', 'cooldownUntil', 'cooldownKind', 'consecutiveFails', 'outcomes', 'state', 'lastUsedAt'];
      const { ...clean } = body;
      for (const f of RUNTIME_ONLY_FIELDS) delete clean[f];
      const account = {
        ...clean,
        id: typeof body.id === 'string' && body.id ? body.id : `${pool.name}-${crypto.randomUUID().slice(0, 8)}`,
        createdAt: body.createdAt ?? Date.now(),
        enabled: body.enabled !== false,
      };
      const disk = loadAccounts(dir).filter((a) => a.id !== account.id);
      disk.push(account);
      saveAccounts(dir, disk);
      const acc = upsertRuntimeAccount(pool, account);
      return sendJson(res, 200, { account: accountView(acc) });
    }
    throw new HttpError(405, `${req.method} 不支持`, { type: 'api_error' });
  }

  function persistRuntimeToDisk(pool) {
    // 以运行态为准回写磁盘（编辑场景运行态即真相）
    saveAccounts(
      accountsDirOf(pool),
      (pool.accounts || []).map((a) => {
        const { inFlight, cooldownUntil, cooldownKind, consecutiveFails, outcomes, ...persisted } = a;
        return persisted;
      }),
    );
  }

  async function handleAccountById(req, res, pool, id, action) {
    const acc = (pool.accounts || []).find((a) => a.id === id);
    if (!acc) throw new HttpError(404, `账号 "${id}" 不存在`, { type: 'not_found_error' });

    if (action === 'reset' && req.method === 'POST') {
      sched(pool).updateAccount(id, { cooldownUntil: 0, cooldownKind: null, consecutiveFails: 0, state: 'ok' });
      return sendJson(res, 200, { account: accountView(pool.accounts.find((a) => a.id === id)) });
    }

    if (req.method === 'PATCH' && !action) {
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      const unknown = Object.keys(body).filter((k) => !ACCOUNT_PATCH_FIELDS.includes(k));
      if (unknown.length) {
        throw new HttpError(400, `不允许修改字段：${unknown.join(', ')}`, { type: 'invalid_request_error' });
      }
      const patch = {};
      for (const field of ACCOUNT_PATCH_FIELDS) if (field in body) patch[field] = body[field];
      sched(pool).updateAccount(id, patch);
      persistRuntimeToDisk(pool);
      return sendJson(res, 200, { account: accountView(pool.accounts.find((a) => a.id === id)) });
    }

    if (req.method === 'DELETE' && !action) {
      const idx = pool.accounts.findIndex((a) => a.id === id);
      pool.accounts.splice(idx, 1); // pick() 遍历 runtime 数组，删除后 sticky 由 stickyGet 自清理
      const dir = accountsDirOf(pool);
      saveAccounts(dir, loadAccounts(dir).filter((a) => a.id !== id));
      return sendJson(res, 200, { ok: true });
    }

    throw new HttpError(405, `${req.method} 不支持`, { type: 'api_error' });
  }

  // onboard/领取公共块拆分至 onboard-handlers.mjs（02 §4）：闭包状态经 ctx 穿线
  const { pruneFlows, claimerCheckin, claimAndInvalidate, handleOnboard } = createOnboardHandlers({
    flowsFile,
    now,
    fetchImpl,
    config,
    dataDir,
    zcodeOrigin,
    traeApiHost,
    qoderExchangeUrl,
    qoderUserinfoUrl,
    wbEndpointCn,
    wbEndpointGlobal,
    loginConfig: LOGIN_CONFIG,
    pools,
    claimers,
    accountsDirOf,
    upsertRuntimeAccount,
    accountView,
  });

  async function handleKeys(req, res, url) {
    if (!db) throw new HttpError(503, '密钥库未加载', { type: 'api_error' });

    if (url.pathname === '/api/keys') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { keys: db.keys.map(keyView) });
      }
      if (req.method === 'POST') {
        const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
        const { full, key } = createKey(db, {
          name: body.name,
          pools: Array.isArray(body.pools) ? body.pools : [],
          expiresAt: body.expiresAt ?? 0,
          tokenQuota: body.tokenQuota ?? 0,
          rpm: body.rpm ?? 0,
          ipAllowlist: Array.isArray(body.ipAllowlist) ? body.ipAllowlist : [],
        });
        saveKeys(keysFile, db);
        return sendJson(res, 200, { key: keyView(key), secret: full });
      }
    }

    let m = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
    if (m && req.method === 'DELETE') {
      const idx = db.keys.findIndex((k) => k.id === m[1]);
      if (idx < 0) throw new HttpError(404, '密钥不存在', { type: 'not_found_error' });
      db.keys.splice(idx, 1);
      saveKeys(keysFile, db);
      return sendJson(res, 200, { ok: true });
    }

    m = url.pathname.match(/^\/api\/keys\/([^/]+)\/rotate$/);
    if (m && req.method === 'POST') {
      const idx = db.keys.findIndex((k) => k.id === m[1]);
      if (idx < 0) throw new HttpError(404, '密钥不存在', { type: 'not_found_error' });
      const old = db.keys[idx];
      const { full, key } = createKey(db, {
        name: old.name,
        pools: old.enabledPools,
        expiresAt: old.expiresAt,
        tokenQuota: old.tokenQuota,
        rpm: old.rpm,
        ipAllowlist: old.ipAllowlist,
      });
      key.usedTokens = old.usedTokens;
      key.id = old.id; // 原位替换：用量记录与面板引用按 id 追踪，轮换不改 id
      const appendedIdx = db.keys.indexOf(key);
      if (appendedIdx >= 0) db.keys.splice(appendedIdx, 1); // createKey 是追加语义，撤掉
      db.keys[idx] = key;
      saveKeys(keysFile, db);
      return sendJson(res, 200, { key: keyView(key), secret: full });
    }

    throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/models' && req.method === 'GET') {
      // 面板侧模型清单（session 鉴权，无需 zsk_ 密钥）：与 /v1/models 同形状，含全部池
      return sendJson(res, 200, {
        object: 'list',
        data: pools.flatMap((p) => {
          const hasAccount = (p.accounts || []).some((a) => a.enabled !== false && a.state !== 'needs_login');
          return (p.models?.() || []).map((m) => ({
            id: `${p.name}/${m.id}`,
            display_name: m.display_name || m.id,
            pool: p.name,
            upstream_model: m.upstream_model ?? m.id,
            available: hasAccount && !m.degraded,
            pool_accounts: (p.accounts || []).length,
            context_window: m.context_window ?? null,
            max_tokens: m.max_tokens ?? null,
            supports_tools: m.supports_tools ?? false,
            supports_thinking: m.supports_thinking ?? false,
            verified: m.verified !== false,
            degraded: !!m.degraded,
            ...(m.benefit ? { benefit: true } : {}),
          }));
        }),
      });
    }
    if (url.pathname === '/api/settings' && (req.method === 'GET' || req.method === 'PATCH')) {
      // WHATWG URL 会把 %2E%2E 归一化成 .. 再折叠路径（/api/pools/%2E%2E/settings → /api/settings），
      // 这里必须校验原始 req.url，否则路径穿越会绕过池名白名单命中全局设置。
      if (!/^\/api\/settings(\?|$)/.test(req.url)) {
        throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
      }
      // 全局设置：所有池共享 pool-settings.json；PATCH 广播到每个池的调度器
      if (req.method === 'GET') {
        return sendJson(res, 200, { settings: pools.length ? sched(pools[0]).settings : {} });
      }
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      const unknown = Object.keys(body).filter((k) => !SETTING_KEYS.includes(k));
      if (unknown.length) {
        throw new HttpError(400, `不允许修改字段：${unknown.join(', ')}`, { type: 'invalid_request_error' });
      }
      let settings = null;
      for (const pool of pools) {
        settings = sched(pool).patchSettings(body);
      }
      return sendJson(res, 200, { settings: settings ?? {}, applied: pools.length });
    }
    if (url.pathname === '/api/claims' && req.method === 'GET') {
      const claims = readJsonFile(path.join(dataDir, 'claims.json'), { entries: [] });
      return sendJson(res, 200, { entries: (claims.entries ?? []).slice(-100).reverse() });
    }
    if (url.pathname === '/api/overview' && req.method === 'GET') {
      return sendJson(res, 200, overview());
    }
    if (url.pathname === '/api/pools' && req.method === 'GET') {
      return sendJson(res, 200, {
        pools: pools.map((p) => ({
          name: p.name,
          type: p.type ?? 'pool',
          settings: sched(p).settings,
          accounts: typeof sched(p).snapshot === 'function' ? sched(p).snapshot() : [],
        })),
      });
    }

    let m = url.pathname.match(/^\/api\/pools\/([^/]+)\/settings$/);
    if (m && req.method === 'PATCH') {
      const pool = poolByName(pools, safeDecode(m[1]));
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      const unknown = Object.keys(body).filter((k) => !SETTING_KEYS.includes(k));
      if (unknown.length) {
        throw new HttpError(400, `不允许修改字段：${unknown.join(', ')}`, { type: 'invalid_request_error' });
      }
      sched(pool).patchSettings(body);
      return sendJson(res, 200, { settings: sched(pool).settings });
    }

    m = url.pathname.match(/^\/api\/pools\/([^/]+)\/accounts$/);
    if (m) return handleAccounts(req, res, poolByName(pools, safeDecode(m[1])));

    m = url.pathname.match(/^\/api\/pools\/([^/]+)\/accounts\/([^/]+)$/);
    if (m) return handleAccountById(req, res, poolByName(pools, safeDecode(m[1])), safeDecode(m[2]), '');

    m = url.pathname.match(/^\/api\/pools\/([^/]+)\/accounts\/([^/]+)\/reset$/);
    if (m) return handleAccountById(req, res, poolByName(pools, safeDecode(m[1])), safeDecode(m[2]), 'reset');

    // 每账号额度明细：现场回源（缓存 TTL 在各池 quota 模块内），单账号失败不拖垮整批。
    // 签到列以 claimer.status（领取真实链路）覆盖 quota 自带的签到查询，见 claimerCheckin。
    m = url.pathname.match(/^\/api\/pools\/([^/]+)\/quota$/);
    if (m && req.method === 'GET') {
      const pool = poolByName(pools, safeDecode(m[1]));
      if (!pool.quota?.get) throw new HttpError(501, `池 ${pool.name} 没有额度模块`, { type: 'api_error' });
      const claimer = claimers[pool.name];
      const out = [];
      for (const acc of pool.accounts || []) {
        try {
          const q = await pool.quota.get(acc);
          out.push({ account: acc.id, ...q, label: displayNameOf(acc), checkin: await claimerCheckin(claimer, acc, q.checkin) });
        } catch (err) {
          out.push({ account: acc.id, label: displayNameOf(acc), supported: true, ratio: null, source: 'unknown', details: [], checkin: null, error: err?.message || String(err) });
        }
      }
      return sendJson(res, 200, { pool: pool.name, accounts: out });
    }

    // 手动领取：单账号或整池
    m = url.pathname.match(/^\/api\/pools\/([^/]+)\/claim$/);
    if (m && req.method === 'POST') {
      const pool = poolByName(pools, safeDecode(m[1]));
      const claimer = claimers[pool.name];
      if (!claimer) throw new HttpError(501, `池 ${pool.name} 没有领取模块`, { type: 'api_error' });
      const results = [];
      for (const acc of pool.accounts || []) {
        if (acc.enabled === false) continue;
        try {
          results.push({ account: acc.id, ...(await claimAndInvalidate(pool, claimer, acc)), label: displayNameOf(acc) });
        } catch (err) {
          results.push({ account: acc.id, label: displayNameOf(acc), ok: false, status: 'failed', claimed: [], credits: 0, message: err?.message || String(err) });
        }
      }
      return sendJson(res, 200, { pool: pool.name, results });
    }

    if (url.pathname === '/api/claim-all' && req.method === 'POST') {
      if (!claimScheduler?.runAll) throw new HttpError(501, '领取调度器未启用', { type: 'api_error' });
      const entries = await claimScheduler.runAll();
      return sendJson(res, 200, { entries });
    }

    if (url.pathname.startsWith('/api/onboard/')) return handleOnboard(req, res, url);
    if (url.pathname.startsWith('/api/keys')) return handleKeys(req, res, url);

    if (url.pathname === '/api/stats' && req.method === 'GET') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 14));
      return sendJson(res, 200, { days, stats: usage ? usage.series(days) : [] });
    }
    if (url.pathname === '/api/logs' && req.method === 'GET') {
      return sendJson(res, 200, { logs: readLoginLog(loginLogFile, 200) });
    }

    throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    try {
      const cookies = parseCookies(req);
      if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url, cookies);
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/panel' || url.pathname.startsWith('/panel/'))) {
        return serveStatic(req, res, url);
      }
      if (url.pathname.startsWith('/api/')) {
        requireSession(cookies);
        if (req.method !== 'GET' && !csrfOk(req, cookies)) {
          throw new HttpError(403, 'CSRF 校验失败', { type: 'forbidden' });
        }
        return await handleApi(req, res, url);
      }
      throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
    } catch (err) {
      const known = err instanceof HttpError;
      if (!known) console.error('[panel] 未捕获错误:', err);
      // 响应已开始（如流式回源中途抛错）时不能再写信封，只能断开，参照 gateway.mjs 的对称防护
      if (res.headersSent) return res.destroy();
      const status = known ? err.status : 500;
      return sendJson(res, status, {
        error: { type: known ? err.type : 'api_error', message: known ? err.message : '面板内部错误' },
      });
    }
  }

  return { handle, claimers, claimScheduler };
}
