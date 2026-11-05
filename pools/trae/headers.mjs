// 移植自 vendor/cpa-trae/trae/upstream/headers.go（MIT，mmqz/cpa-multi-plugins）。
// 三类请求头：对话（soloHeaders ↔ SOLOHeaders）、积分/签到（ugHeaders ↔ UgHeaders+ugBaseHeaders）、
// oauth（oauthHeaders ↔ OAuthHeaders）。
//
// 风控画像（v0.12.45 抓包实证）：对话走 IDE 主进程 UA "Trae/0.1.61"；积分/签到走
// VSCode 插件进程 UA "VSCode 1.107.1 (TRAE SOLO CN)"——两套指纹绝不能混（headers.go:62-73）。

import crypto from 'node:crypto';
import {
  APP_ID,
  IDE_VERSION,
  IDE_VERSION_CODE,
  DEVICE_BRAND,
  OS_VERSION,
  CLIENT_UA,
} from './constants.mjs';

// ugMarketClientID 与 ug UA 同源但不带平台后缀（headers.go:76）。
export const UG_MARKET_CLIENT_ID = 'VSCode 1.107.1';
export const UG_USER_AGENT = `${UG_MARKET_CLIENT_ID} (TRAE SOLO CN)`;
export const UG_PACKAGE_TYPE = 'stable_cn';

/** newRequestId：uuid-v4 形请求标识（headers.go:98-105）。 */
export function newRequestId() {
  return crypto.randomUUID();
}

/** ttTraceId：00-<32hex>-<16hex>-01，16hex 取自请求 id 去连字符（headers.go:108-112）。 */
export function ttTraceId(requestId) {
  const hex = crypto.randomBytes(16).toString('hex');
  return `00-${hex}-${String(requestId).replace(/-/g, '').slice(0, 16)}-01`;
}

/**
 * soloHeaders：llm_utils_chat 所需 SOLO 专属头（headers.go:17-48 SOLOHeaders）。
 * a = {jwt, uid?, machineId?, deviceId?}；stream 决定 Accept。
 */
export function soloHeaders(a, stream) {
  const h = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': CLIENT_UA,
    Authorization: `Cloud-IDE-JWT ${a.jwt}`,
    'X-Cloudide-Token': a.jwt,
    'X-Ide-Token': a.jwt,
    'X-App-Id': APP_ID,
    'X-App-Version': 'default',
    'X-Ide-Version': IDE_VERSION,
    'X-Ide-Version-Code': IDE_VERSION_CODE,
    'X-App-Version-Code': IDE_VERSION_CODE,
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': OS_VERSION,
    'X-Device-Brand': DEVICE_BRAND,
    'Request-Traffic-Type': 'prod',
  };
  if (a.uid) h['X-Uid'] = a.uid;
  if (a.machineId) h['X-Machine-Id'] = a.machineId;
  if (a.deviceId) h['X-Device-Id'] = a.deviceId;
  return h;
}

/**
 * ugHeaders：积分/签到请求头（headers.go:54-57 UgHeaders + :116-138 ugBaseHeaders）。
 * 每请求新生成 X-Request-Id + X-TT-Trace-Id；不带 Origin/Referer/x-app-type。
 * 鉴权双方案：Cloud-IDE-JWT（默认，官方客户端实证）优先、Bearer 回退（client.go ugCheckinRequest）。
 */
export function ugHeaders(a, { scheme = 'Cloud-IDE-JWT' } = {}) {
  const rid = newRequestId();
  const h = {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'User-Agent': UG_USER_AGENT,
    'X-User-Region': 'CN',
    'Accept-Language': 'zh-CN',
    'Package-Type': UG_PACKAGE_TYPE,
    'X-Lgw-Req-Sdk-Type': '3',
    'X-Market-Client-Id': UG_MARKET_CLIENT_ID,
    'X-Device-Brand': DEVICE_BRAND,
    'X-Device-Type': 'windows',
    'X-OS-Version': OS_VERSION,
    'App-Version': IDE_VERSION,
    'X-Request-Id': rid,
    'X-TT-Trace-Id': ttTraceId(rid),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
    Authorization: `${scheme} ${a.jwt}`,
  };
  if (a.deviceId) h['X-Device-Id'] = a.deviceId;
  return h;
}

/** oauthHeaders：ExchangeToken / GetUserInfo 所需头（headers.go:141-145，无签名仅 UA）。 */
export function oauthHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': CLIENT_UA,
  };
}
