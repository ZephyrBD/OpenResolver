import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../http/errors.mjs';
import { sendJson } from '../http/respond.mjs';
import { readJson, DEFAULT_MAX_BODY_BYTES } from '../http/body.mjs';
import { SETTING_KEYS } from '../pools/settings.mjs';
import { loadAccounts, saveAccounts } from '../pools/zcode/accounts.mjs';
import { createLoginFlow as zcCreateLoginFlow, pollLogin as zcPollLogin, persistAccount as persistZcAccount } from '../pools/zcode/onboard.mjs';
import { deviceIdFor, sessionIdFor } from '../fingerprint.mjs';
import { buildLoginUrl, accountFromCallback as traeAccountFromCallback, persistAccount as persistTraeAccount } from '../pools/trae/login-link.mjs';
import { accountFromPat as qoderAccountFromPat, persistAccount as persistQoderAccount } from '../pools/qoder/onboard.mjs';
import { createLoginFlow as wbCreateLoginFlow, pollLoginAccount as wbPollLoginAccount, accountFromPoll as wbAccountFromPoll, persistAccount as persistWbAccount } from '../pools/workbuddy/onboard.mjs';
import {
  createLoginFlow as caCreateLoginFlow,
  exchangeCode as caExchangeCode,
  pollTicket as caPollTicket,
  accountFromToken as caAccountFromToken,
  parseCallback as caParseCallback,
  persistAccount as persistCaAccount,
} from '../pools/codearts/onboard.mjs';
import { LOGIN_CONFIG_DEFAULTS } from '../pools/codearts/auth.mjs';

// CodeArts 登录端点默认值来自 LOGIN_CONFIG_DEFAULTS（生产华为云）；
// 测试可经 createPanelGateway({ caLoginConfig }) 注入桩 host。
import { ENDPOINT_CN as WB_ENDPOINT_CN, ENDPOINT_GLOBAL as WB_ENDPOINT_GLOBAL } from '../pools/workbuddy/constants.mjs';
import { loadIdentitySeed } from '../pools/qoder/identity.mjs';
import { createKey } from '../auth/keys.mjs';
import { saveKeys } from '../auth/store.mjs';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  sessionOf,
  revokeSession,
  revokeOtherSessions,
  verifyPassword,
  saveAdmin,
  lockRemaining,
  recordLoginFailure,
  clearLoginFailures,
  logLockAttemptOnce,
  logLoginAttempt,
  readLoginLog,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  csrfCookie,
  clearCsrfCookie,
} from './admin.mjs';
import { newCsrfToken, csrfOk, sameOrigin } from './csrf.mjs';
import { createStaticHandler } from './static.mjs';
import { readJson as readJsonFile, writeJson as writeJsonFile } from './store.mjs';

/**
 * 面板网关（文档 §9.2 / §10 / §12）：管理员认证 + CSRF + 面板 API + 静态挂载点。
 * 独立于推理面：gateway.mjs 只挂一个 handle(req,res) 分流；推理面（/v1/*）与本模块无关。
 */

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const FLOW_TTL_MS = 10 * 60_000;
const SENSITIVE_FIELDS = ['jwt', 'refreshToken', 'pat', 'jobToken', 'jobRefreshToken'];
const ACCOUNT_PATCH_FIELDS = ['label', 'manualWeight', 'enabled'];

function clampManual(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 10;
  return Math.min(20, Math.max(0, n));
}

/** claimer.status 的字段形状映射（对齐 zcode/claim.mjs / trae/checkin.mjs：checkedIn/credits/message/details）。 */
function claimerCheckinOf(st) {
  const out = {
    checkedIn: st?.checkedIn === true,
    credits: Number(st?.credits) || 0,
    message: st?.message ?? '',
    supported: st?.supported === true,
  };
  const streakDays = Number(st?.details?.streakDays ?? st?.streakDays);
  if (Number.isFinite(streakDays)) out.streakDays = streakDays;
  if (typeof st?.details?.active === 'boolean') out.active = st.details.active;
  return out;
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    throw new HttpError(400, 'URL 编码非法', { type: 'invalid_request_error' });
  }
}

function poolByName(pools, name) {
  if (!/^[a-z0-9-]+$/.test(name || '')) throw new HttpError(404, `未知池 "${name}"`, { type: 'not_found_error' });
  const pool = pools.find((p) => p.name === name);
  if (!pool) throw new HttpError(404, `未知池 "${name}"`, { type: 'not_found_error' });
  return pool;
}

/** 各池把 base 调度器包在 `.scheduler` 子对象里（snapshot/settings/patchSettings/updateAccount 在其上）。 */
function sched(pool) {
  return pool.scheduler ?? pool;
}

/** 凭证只回显尾 4 位；敏感字段绝不出现在面板响应里。 */
export function accountView(acc) {
  const view = {
    id: acc.id,
    label: acc.label ?? '',
    enabled: acc.enabled,
    state: acc.state ?? 'ok',
    manualWeight: acc.manualWeight,
    weight: acc.weight ?? acc.manualWeight ?? 10,
    email: acc.email ?? '',
    userID: acc.userID ?? '',
    uid: acc.uid ?? '',
    nickname: acc.nickname ?? '',
    machineID: acc.machineID ?? acc.machineId ?? '',
    deviceId: acc.deviceId ?? '',
    expiresAt: acc.expiresAt ?? 0,
    jobTokenExpiresAt: acc.jobTokenExpiresAt ?? 0,
    createdAt: acc.createdAt ?? 0,
    lastUsedAt: acc.lastUsedAt ?? 0,
    inFlight: acc.inFlight ?? 0,
    cooldownUntil: acc.cooldownUntil ?? 0,
    cooldownRemainingMs: Math.max(0, (acc.cooldownUntil ?? 0) - Date.now()),
    cooldownKind: acc.cooldownKind ?? null,
    consecutiveFails: acc.consecutiveFails ?? 0,
    quotaRatio: typeof acc.quotaRatio === 'number' ? acc.quotaRatio : null,
  };
  for (const field of SENSITIVE_FIELDS) {
    if (acc[field]) view[field] = `***${String(acc[field]).slice(-4)}`;
  }
  return view;
}

/** 名称主显示：label → nickname → email → id（面板用它做主标识，id 退居次级）。 */
export function displayNameOf(acc) {
  return String(acc?.label || acc?.nickname || acc?.email || acc?.id || '');
}

function keyView(key) {
  // keyHash 不回显：面板只需要元数据
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    tokenQuota: key.tokenQuota,
    usedTokens: key.usedTokens,
    rpm: key.rpm,
    ipAllowlist: key.ipAllowlist,
    enabledPools: key.enabledPools,
    enabled: key.enabled,
  };
}

/**
 * 运行态账号对象（对齐 pools/base.mjs runtimeOf 的字段）：pick/weightOf/snapshot 依赖
 * inFlight/outcomes 等字段，直接 push 裸账号对象会坏调度。
 */
function runtimeAccount(pool, account) {
  const acc = {
    ...account,
    id: account.id,
    manualWeight: clampManual(account.manualWeight ?? account.weight ?? 10),
    enabled: account.enabled !== false && account.enabled !== 0,
    state: account.state ?? 'ok',
    inFlight: 0,
    cooldownUntil: 0,
    cooldownKind: null,
    consecutiveFails: 0,
    lastUsedAt: account.lastUsedAt ?? 0,
    outcomes: [],
  };
  if (pool.name === 'zcode' && (!acc.deviceId || !acc.sessionId) && acc.uid != null) {
    acc.deviceId = acc.deviceId || deviceIdFor(acc.uid);
    acc.sessionId = acc.sessionId || sessionIdFor(acc.uid);
  }
  return acc;
}

/** 运行态与磁盘同步：同 id 先删再插（新增/覆盖），返回插入后的运行态对象。 */
function upsertRuntimeAccount(pool, account) {
  const idx = pool.accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) pool.accounts.splice(idx, 1);
  const acc = runtimeAccount(pool, account);
  pool.accounts.push(acc);
  return acc;
}

export function createPanelGateway({
  config = {},
  pools = [],
  db,
  keysFile,
  dataDir,
  now = Date.now,
  fetchImpl = fetch,
  secureCookie = false,
  publicDir = path.join(import.meta.dirname, 'public'),
  usage = null,
  traeApiHost,
  qoderExchangeUrl,
  qoderUserinfoUrl,
  wbEndpointCn = process.env.UGW_WB_ENDPOINT_CN,
  wbEndpointGlobal = process.env.UGW_WB_ENDPOINT_GLOBAL,
  caLoginConfig,
  sessionTtlMs = SESSION_TTL_MS,
  zcodeOrigin = process.env.UGW_ZCODE_ORIGIN || 'https://zcode.z.ai',
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

  function requireSession(cookies) {
    const session = sessionOf(sessionsFile, cookies[SESSION_COOKIE], { now, ttl: sessionTtlMs });
    if (!session) throw new HttpError(401, '未登录或会话已过期', { type: 'authentication_error' });
    return session;
  }

  function loadAdminOr503() {
    const admin = readJsonFile(adminFile);
    if (!admin?.hash) {
      throw new HttpError(503, '面板管理员密码未设置，先运行 node tools/admin-passwd.mjs', { type: 'api_error' });
    }
    return admin;
  }

  async function handleLogin(req, res, cookies) {
    if (!sameOrigin(req)) {
      // 登录没有 token 可双提交，但跨 Origin 依然必须拒绝
      throw new HttpError(403, '跨站请求被拒绝', { type: 'forbidden' });
    }
    const ip = clientIp(req);
    const lockedUntil = lockRemaining(securityFile, ip, { now });
    if (lockedUntil) {
      logLockAttemptOnce(securityFile, loginLogFile, ip, lockedUntil);
      throw new HttpError(429, `失败次数过多，已锁定，请 ${Math.ceil((lockedUntil - now()) / 60_000)} 分钟后再试`, {
        type: 'rate_limit_error',
      });
    }
    const admin = loadAdminOr503();
    const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    if (!verifyPassword(admin, body.password)) {
      recordLoginFailure(securityFile, ip, { now });
      logLoginAttempt(loginLogFile, { ip, ok: false, reason: 'bad_password' });
      throw new HttpError(401, '密码错误', { type: 'authentication_error' });
    }
    clearLoginFailures(securityFile, ip);
    const sessionId = createSession(sessionsFile, { now });
    const csrfToken = newCsrfToken();
    res.setHeader('Set-Cookie', [sessionCookie(sessionId, { secure: secureCookie }), csrfCookie(csrfToken)]);
    logLoginAttempt(loginLogFile, { ip, ok: true, reason: '' });
    return sendJson(res, 200, { ok: true, csrfToken });
  }

  async function handleLogout(req, res, cookies) {
    const session = requireSession(cookies);
    if (req.method !== 'GET' && !csrfOk(req, cookies)) {
      throw new HttpError(403, 'CSRF 校验失败', { type: 'forbidden' });
    }
    revokeSession(sessionsFile, cookies[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', [clearSessionCookie({ secure: secureCookie }), clearCsrfCookie()]);
    return sendJson(res, 200, { ok: true });
  }

  async function handleAuth(req, res, url, cookies) {
    if (url.pathname === '/auth/login' && req.method === 'POST') return handleLogin(req, res, cookies);
    if (url.pathname === '/auth/logout' && req.method === 'POST') return handleLogout(req, res, cookies);
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const session = sessionOf(sessionsFile, cookies[SESSION_COOKIE], { now, ttl: sessionTtlMs });
      if (!session) return sendJson(res, 200, { authenticated: false, csrfToken: null });
      return sendJson(res, 200, { authenticated: true, csrfToken: cookies['ugw_csrf'] ?? null });
    }
    if (url.pathname === '/auth/password' && req.method === 'POST') {
      const session = requireSession(cookies);
      if (!csrfOk(req, cookies)) throw new HttpError(403, 'CSRF 校验失败', { type: 'forbidden' });
      const admin = loadAdminOr503();
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (!verifyPassword(admin, body.currentPassword)) {
        throw new HttpError(401, '当前密码不正确', { type: 'authentication_error' });
      }
      if (typeof body.newPassword !== 'string' || !body.newPassword) {
        throw new HttpError(400, 'newPassword 不能为空', { type: 'invalid_request_error' });
      }
      if (body.newPassword.length < 8) throw new HttpError(400, 'newPassword 至少 8 位', { type: 'invalid_request_error' });
      saveAdmin(adminFile, { password: body.newPassword });
      revokeOtherSessions(sessionsFile, cookies[SESSION_COOKIE]);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
  }

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
      const account = {
        ...body,
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

  function pruneFlows() {
    const flows = readJsonFile(flowsFile, { flows: {} });
    const kept = {};
    for (const [id, flow] of Object.entries(flows?.flows || {})) {
      if (now() - flow.createdAt < FLOW_TTL_MS) kept[id] = flow;
    }
    return { flows: kept, dirty: Object.keys(kept).length !== Object.keys(flows?.flows || {}).length };
  }

  /**
   * 签到列以领取链路（claimer.status）为准 —— claimer.run 是领取实际走的那条链路，
   * quota 模块自带的签到查询与之矛盾（trae 已废弃 GET 契约、workbuddy 打错上游域）：
   * - status 成功且 supported=true → 用它覆盖 quota 自带值；
   * - status 抛错 → 保留 quota 自带 checkin 不覆盖；
   * - supported=false（如"国际版无每日签到"）→ quota 自带值优先，其缺 checkin
   *   时用 claimer 的 message 兜底（否则该提示永远显示不出来）。
   */
  async function claimerCheckin(claimer, acc, base) {
    if (!claimer?.status) return base ?? null;
    let st = null;
    try {
      st = await claimer.status(acc);
    } catch {
      return base ?? null;
    }
    const mapped = claimerCheckinOf(st);
    if (st && st.supported === true) return mapped;
    return base ? base : { ...mapped };
  }

  /** 登录即领取共用：run 之后必须清该账号 quota 缓存，额度明细才不会回显旧值。 */
  async function claimAndInvalidate(pool, claimer, acc) {
    const claim = await claimer.run(acc);
    pool.quota?.invalidate?.(acc);
    return claim;
  }

  async function handleOnboard(req, res, url) {
    if (url.pathname === '/api/onboard/zcode' && req.method === 'POST') {
      // 两段式：link 生成 authorize_url（flow 存 pollToken）；poll 轮询至 ready 入库
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (body.action === 'link') {
        const flow = await zcCreateLoginFlow({ origin: zcodeOrigin, fetchImpl, now });
        const { flows, dirty } = pruneFlows();
        if (dirty) writeJsonFile(flowsFile, { flows });
        const flowId = flow.flowId;
        flows[flowId] = { pollToken: flow.pollToken, kind: 'zcode', createdAt: now() };
        writeJsonFile(flowsFile, { flows });
        return sendJson(res, 200, { authorizeUrl: flow.authorizeUrl, flowId, pollIntervalSec: flow.pollIntervalSec ?? 2, expiresAt: flow.expiresAt });
      }
      if (body.action === 'poll') {
        if (!body.flowId) throw new HttpError(400, '缺少 flowId：请先生成登录链接', { type: 'invalid_request_error' });
        const { flows } = pruneFlows();
        const flow = flows[body.flowId];
        if (!flow || flow.kind !== 'zcode') throw new HttpError(404, 'onboard flow 不存在或已过期（10 分钟有效期，请重新生成登录链接）', { type: 'not_found_error' });
        const out = await zcPollLogin({ origin: zcodeOrigin, flowId: body.flowId, pollToken: flow.pollToken, fetchImpl, now });
        if (out.status !== 'ready') return sendJson(res, 200, { status: out.status, flowId: body.flowId });
        const pool = poolByName(pools, 'zcode');
        persistZcAccount(accountsDirOf(pool), out.account);
        delete flows[body.flowId];
        writeJsonFile(flowsFile, { flows });
        const acc = upsertRuntimeAccount(pool, out.account);
        // 登录即领取（best-effort）：结果随响应带回，失败不阻断入库
        let claim = null;
        const claimer = claimers.zcode;
        if (claimer && acc.enabled !== false) {
          try {
            claim = await claimAndInvalidate(pool, claimer, acc);
          } catch (err) {
            claim = { ok: false, status: 'failed', message: err?.message || String(err) };
          }
        }
        return sendJson(res, 200, { status: 'ready', account: accountView(acc), claim });
      }
      throw new HttpError(400, 'action 必须是 link 或 poll', { type: 'invalid_request_error' });
    }
    if (url.pathname === '/api/onboard/trae/link' && req.method === 'GET') {
      const { flows, dirty } = pruneFlows();
      if (dirty) writeJsonFile(flowsFile, { flows });
      const machineId = crypto.randomBytes(16).toString('hex');
      const deviceId = crypto.randomBytes(16).toString('hex');
      const flowId = crypto.randomUUID();
      flows[flowId] = { machineId, deviceId, createdAt: now() };
      writeJsonFile(flowsFile, { flows });
      return sendJson(res, 200, { url: buildLoginUrl({ machineId, deviceId }), machineId, deviceId, flowId });
    }
    if (url.pathname === '/api/onboard/trae/callback' && req.method === 'POST') {
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (!body.flowId) {
        throw new HttpError(400, '缺少 flowId：请先点「生成登录链接」再登录粘贴回调', { type: 'invalid_request_error' });
      }
      const { flows } = pruneFlows();
      const flow = flows[body.flowId];
      if (!flow) throw new HttpError(404, 'onboard flow 不存在或已过期（10 分钟有效期，请重新生成登录链接）', { type: 'not_found_error' });
      if (typeof body.callbackUrl !== 'string' || !body.callbackUrl) {
        throw new HttpError(400, 'callbackUrl 不能为空', { type: 'invalid_request_error' });
      }
      const account = await traeAccountFromCallback(body.callbackUrl, {
        machineId: flow.machineId,
        deviceId: flow.deviceId,
        apiHost: traeApiHost,
        fetchImpl,
      });
      const pool = poolByName(pools, 'trae');
      const dir = accountsDirOf(pool);
      persistTraeAccount(account, { dataDir: dir });
      delete flows[body.flowId]; // flow 一次性
      writeJsonFile(flowsFile, { flows });
      return sendJson(res, 200, { account: accountView(upsertRuntimeAccount(pool, account)) });
    }
    if (url.pathname === '/api/onboard/qoder' && req.method === 'POST') {
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (body.region !== 'cn' && body.region !== 'global') {
        throw new HttpError(400, 'region 必须是 cn 或 global', { type: 'invalid_request_error' });
      }
      if (typeof body.pat !== 'string' || !body.pat) {
        throw new HttpError(400, 'pat 不能为空', { type: 'invalid_request_error' });
      }
      const { account } = await qoderAccountFromPat(body.pat, body.region, {
        identitySeed: loadIdentitySeed(dataDir),
        fetchImpl,
        exchangeUrl: qoderExchangeUrl,
        userinfoUrl: qoderUserinfoUrl,
      });
      if (!account) {
        throw new HttpError(400, 'userinfo 未返回 userID，PAT 可能无效或权限不足', { type: 'invalid_request_error' });
      }
      const pool = poolByName(pools, body.region === 'cn' ? 'qoder-cn' : 'qoder');
      persistQoderAccount(accountsDirOf(pool), account, { force: true });
      return sendJson(res, 200, { account: accountView(upsertRuntimeAccount(pool, account)) });
    }
    if (url.pathname === '/api/onboard/workbuddy' && req.method === 'POST') {
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (body.region !== 'cn' && body.region !== 'global') {
        throw new HttpError(400, 'region 必须是 cn 或 global', { type: 'invalid_request_error' });
      }
      const endpoint = (body.region === 'cn' ? wbEndpointCn : wbEndpointGlobal) || (body.region === 'cn' ? WB_ENDPOINT_CN : WB_ENDPOINT_GLOBAL);
      if (body.action === 'link') {
        // 两段式第一段：生成登录链接，state 存 flow（onboard-flows 复用 trae 存储）
        const { flows, dirty } = pruneFlows();
        if (dirty) writeJsonFile(flowsFile, { flows });
        const flow = await wbCreateLoginFlow({ endpoint, fetchImpl })();
        const flowId = crypto.randomUUID();
        flows[flowId] = { state: flow.state, region: body.region, endpoint, createdAt: now() };
        writeJsonFile(flowsFile, { flows });
        return sendJson(res, 200, { loginUrl: flow.loginUrl, state: flow.state, flowId });
      }
      if (body.action === 'poll') {
        // 两段式第二段：轮询 login/account → 落账号
        if (!body.flowId) {
          throw new HttpError(400, '缺少 flowId：请先点「生成登录链接」', { type: 'invalid_request_error' });
        }
        const { flows } = pruneFlows();
        const flow = flows[body.flowId];
        if (!flow) throw new HttpError(404, 'onboard flow 不存在或已过期（10 分钟有效期，请重新生成登录链接）', { type: 'not_found_error' });
        const result = await wbPollLoginAccount({ state: flow.state, region: flow.region, endpoint: flow.endpoint, fetchImpl });
        if (!result) return sendJson(res, 200, { pending: true, flowId: body.flowId });
        const account = wbAccountFromPoll(result);
        const pool = poolByName(pools, flow.region === 'cn' ? 'workbuddy-cn' : 'workbuddy');
        if (!pool) {
          throw new HttpError(503, `WorkBuddy ${flow.region} 池未启用（boot 需 UGW_WB=1）`, { type: 'api_error' });
        }
        persistWbAccount(account, { dataDir: accountsDirOf(pool) });
        delete flows[body.flowId]; // flow 一次性
        writeJsonFile(flowsFile, { flows });
        return sendJson(res, 200, { account: accountView(upsertRuntimeAccount(pool, account)) });
      }
      throw new HttpError(400, 'action 必须是 link 或 poll', { type: 'invalid_request_error' });
    }
    if (url.pathname === '/api/onboard/codearts' && req.method === 'POST') {
      // 两段式：link 生成 PKCE+DPoP+ticket 授权链接（flow 存 onboard-flows，含
      // dpopJwk 私钥——data/ 是机密目录，与 accounts.json 同级安全边界）；
      // callback 粘贴回跳 URL（带 code）或 poll 走 ticket 轮询兜底。
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (body.action === 'link') {
        const { flows, dirty } = pruneFlows();
        if (dirty) writeJsonFile(flowsFile, { flows });
        const flow = caCreateLoginFlow({ cfg: LOGIN_CONFIG, port: Number(body.port) || 1455 });
        const flowId = crypto.randomUUID();
        flows[flowId] = { ...flow, createdAt: now() };
        writeJsonFile(flowsFile, { flows });
        return sendJson(res, 200, { authorizeUrl: flow.authorizeUrl, flowId });
      }
      const finishWithToken = async (flow, token) => {
        const account = caAccountFromToken(token, { codeVerifier: flow.codeVerifier, dpopJwk: flow.dpopJwk });
        const pool = poolByName(pools, 'codearts');
        if (!pool) {
          throw new HttpError(503, 'CodeArts 池未启用（boot 组装失败）', { type: 'api_error' });
        }
        persistCaAccount(account, { dataDir: accountsDirOf(pool) });
        return { account: accountView(upsertRuntimeAccount(pool, account)) };
      };
      if (body.action === 'callback') {
        if (!body.flowId) {
          throw new HttpError(400, '缺少 flowId：请先点「生成授权链接」', { type: 'invalid_request_error' });
        }
        if (typeof body.callbackUrl !== 'string' || !body.callbackUrl) {
          throw new HttpError(400, 'callbackUrl 不能为空：请粘贴浏览器回跳的完整 URL', { type: 'invalid_request_error' });
        }
        const { flows } = pruneFlows();
        const flow = flows[body.flowId];
        if (!flow) throw new HttpError(404, 'onboard flow 不存在或已过期（10 分钟有效期，请重新生成授权链接）', { type: 'not_found_error' });
        const { code, port } = caParseCallback(body.callbackUrl);
        if (!code) throw new HttpError(400, '回调 URL 未包含 code 参数', { type: 'invalid_request_error' });
        const token = await caExchangeCode({ cfg: LOGIN_CONFIG, code, codeVerifier: flow.codeVerifier, port, dpopJwk: flow.dpopJwk, fetchImpl });
        const out = await finishWithToken(flow, token);
        delete flows[body.flowId]; // flow 一次性
        writeJsonFile(flowsFile, { flows });
        return sendJson(res, 200, out);
      }
      if (body.action === 'poll') {
        if (!body.flowId) {
          throw new HttpError(400, '缺少 flowId：请先点「生成授权链接」', { type: 'invalid_request_error' });
        }
        const { flows } = pruneFlows();
        const flow = flows[body.flowId];
        if (!flow) throw new HttpError(404, 'onboard flow 不存在或已过期（10 分钟有效期，请重新生成授权链接）', { type: 'not_found_error' });
        const token = await caPollTicket({ cfg: LOGIN_CONFIG, ticketId: flow.ticketId, secret: flow.secret, fetchImpl });
        if (!token) return sendJson(res, 200, { pending: true, flowId: body.flowId });
        const out = await finishWithToken(flow, token);
        delete flows[body.flowId]; // flow 一次性
        writeJsonFile(flowsFile, { flows });
        return sendJson(res, 200, out);
      }
      throw new HttpError(400, 'action 必须是 link、callback 或 poll', { type: 'invalid_request_error' });
    }
    throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
  }

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
      const status = known ? err.status : 500;
      return sendJson(res, status, {
        error: { type: known ? err.type : 'api_error', message: known ? err.message : '面板内部错误' },
      });
    }
  }

  return { handle, claimers, claimScheduler };
}
