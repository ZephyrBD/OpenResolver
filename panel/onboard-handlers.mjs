/**
 * 面板 onboard/领取处理块（02 §4 拆分自 api.mjs）：五池两段式 onboard、flow 存取、
 * 签到列覆盖与登录即领取。闭包状态经 ctx 穿线，本模块无自身可变全局。
 */

import crypto from 'node:crypto';
import { HttpError } from '../http/errors.mjs';
import { sendJson } from '../http/respond.mjs';
import { readJson, DEFAULT_MAX_BODY_BYTES } from '../http/body.mjs';
import { readJson as readJsonFile, writeJson as writeJsonFile } from './store.mjs';
import { FLOW_TTL_MS, claimerCheckinOf, poolByName } from './shared.mjs';
import { createLoginFlow as zcCreateLoginFlow, pollLogin as zcPollLogin, persistAccount as persistZcAccount } from '../pools/zcode/onboard.mjs';
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
import { ENDPOINT_CN as WB_ENDPOINT_CN, ENDPOINT_GLOBAL as WB_ENDPOINT_GLOBAL } from '../pools/workbuddy/constants.mjs';
import { loadIdentitySeed } from '../pools/qoder/identity.mjs';

export function createOnboardHandlers(ctx) {
  const {
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
  } = ctx;

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

  return { pruneFlows, claimerCheckin, claimAndInvalidate, handleOnboard };
}
