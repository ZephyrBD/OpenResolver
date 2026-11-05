import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_ID, IDE_VERSION, DEFAULT_API_HOST, EP_EXCHANGE, EP_USER_INFO } from './constants.mjs';
import { decodeCallback, exchangeToken, fetchUserInfo } from './auth.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';

/**
 * Trae 登录链接 + 回调落账号，tools/trae-login.mjs 与面板 /api/onboard/trae 共用。
 * 9074 缓解：登录与对话共用同一对 machine/device id——链接生成时定死，落账号时用同一对。
 */

export function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function buildLoginUrl({
  machineId,
  deviceId,
  clientId = CLIENT_ID,
  appVersion = process.env.UGW_TRAE_APP_VERSION || IDE_VERSION,
  traceId = crypto.randomBytes(8).toString('hex'),
} = {}) {
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: '2.3.62834',
    auth_type: 'local',
    client_id: clientId,
    redirect: '0',
    login_trace_id: traceId,
    auth_callback_url: 'http://127.0.0.1:18080/authorize',
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: appVersion,
    x_app_type: 'stable',
  });
  return `https://www.trae.cn/authorization?${params.toString()}`;
}

/** 生成链接并把 machine/device id 写进 pending-login.json（CLI 流程用；面板流程走 flows 存储，不经此文件）。 */
export function generateLoginLink({ dataDir } = {}) {
  const machineId = crypto.randomBytes(16).toString('hex');
  const deviceId = crypto.randomBytes(16).toString('hex');
  const url = buildLoginUrl({ machineId, deviceId });
  const pendingFile = path.join(dataDir, 'pending-login.json');
  atomicWriteJson(pendingFile, { machineId, deviceId, createdAt: new Date().toISOString() });
  return { url, machineId, deviceId, pendingFile };
}

/** 回调 → 账号对象。machine/device id 由调用方给出（CLI 从 pending 取，面板从 flow 取）。 */
export async function accountFromCallback(
  callbackUrl,
  {
    machineId,
    deviceId,
    apiHost = process.env.UGW_TRAE_API_HOST || DEFAULT_API_HOST,
    fetchImpl = fetch,
    now = Date.now,
  } = {},
) {
  const decoded = decodeCallback(callbackUrl);
  if (!decoded.refreshToken) throw new Error('回调链接里没有 refreshToken，确认粘贴的是登录完成后的完整回调地址');

  const exchanged = await exchangeToken(decoded.refreshToken, { fetchImpl, now, url: `${apiHost}${EP_EXCHANGE}` });
  const info = await fetchUserInfo(exchanged.token, { fetchImpl, url: `${apiHost}${EP_USER_INFO}` });

  const uid = info.userID || decoded.uid;
  const nickname = info.nickname || decoded.nickname;
  return {
    id: `trae-${uid || crypto.randomUUID().slice(0, 8)}`,
    label: nickname || uid || 'trae',
    uid,
    nickname,
    jwt: exchanged.token,
    refreshToken: exchanged.refreshToken,
    expiresAt: exchanged.expiresAt,
    machineId,
    deviceId,
    state: 'ok',
    weight: 10,
    enabled: true,
    createdAt: Date.now(),
  };
}

/** 落账号（追加去重：同 id 覆盖），返回写入后的列表。 */
export function persistAccount(account, { dataDir } = {}) {
  const accounts = loadAccounts(dataDir).filter((a) => a.id !== account.id);
  accounts.push(account);
  saveAccounts(dataDir, accounts);
  return accounts;
}
