// 移植自 vendor/wb-whl/codebuddy_proxy/codebuddy_client_demo.py（MIT）：
// auth_headers（:260-292 逐头）、_domain_for_token（:299-307）、_request 基础头
//（:226-229：UA + X-Product-Code）与 login 的 no_auth 头（:335-340）。
// machineIdFor 复用 pools/qoder/identity.mjs 的确定性派生模式（不读真实
// VSCode machineId），seed 存 data/identity/workbuddy-<region>.json。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_UA, IDE_TYPE, IDE_NAME, IDE_VERSION, PRODUCT_VERSION, PRODUCT_CODE } from './constants.mjs';

/**
 * machineIdFor：确定性派生，形状为 UUIDv5。注意 namespace 是 "DNS UUID 字符串" 的
 * MD5（UTF-8），不是 Python uuid.NAMESPACE_DNS 的原始 16 字节——与 wheel
 * uuid5(NAMESPACE_DNS, seed)（:309-332）的输出不同，但同为确定性派生，行为保留。
 */
export function machineIdFor(seed) {
  const ns = crypto.createHash('md5').update('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'utf8').digest();
  const raw = crypto.createHash('sha1').update(ns).update(String(seed || ''), 'utf8').digest();
  raw[6] = (raw[6] & 0x0f) | 0x50;
  raw[8] = (raw[8] & 0x3f) | 0x80;
  const hex = raw.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 读（或生成）region 级 identity seed：data/identity/workbuddy-<region>.json。 */
export function loadIdentitySeed(dataDir, region) {
  const dir = path.join(dataDir, 'identity');
  const file = path.join(dir, `workbuddy-${region}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data?.seed === 'string' && data.seed) return data.seed;
  } catch {
    // 首次生成
  }
  const seed = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ seed }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return seed;
}

/** token.domain 优先，回退端点 host（_domain_for_token :299-307）。 */
export function domainFor(acc, endpoint) {
  if (acc?.domain) return String(acc.domain);
  try {
    return endpoint ? new URL(endpoint).host : '';
  } catch {
    return '';
  }
}

/**
 * authHeaders：对话/管理请求的完整头族（auth_headers :260-292）。
 * a = {uid?, jwt(=accessToken), refreshToken?, domain?, enterpriseId?, departmentInfo?, machineId?}。
 * opts = {access=true, refresh=false, endpoint?, seed?}：seed 用于派生 X-Machine-Id。
 */
export function authHeaders(a = {}, { access = true, refresh = false, endpoint, seed } = {}) {
  const h = {
    'User-Agent': BASE_UA,
    'X-Product-Code': PRODUCT_CODE,
    'X-IDE-Type': IDE_TYPE,
    'X-IDE-Name': IDE_NAME,
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': PRODUCT_VERSION,
    'X-Machine-Id': a.machineId || machineIdFor(`${seed ?? ''}:${a.id ?? a.uid ?? 'anon'}`),
  };
  if (a.uid != null && a.uid !== '') h['X-User-Id'] = String(a.uid);
  if (access && a.jwt) h['Authorization'] = `Bearer ${a.jwt}`;
  if (refresh && a.refreshToken) h['X-Refresh-Token'] = String(a.refreshToken);
  if (a.enterpriseId) {
    h['X-Enterprise-Id'] = String(a.enterpriseId);
    h['X-Tenant-Id'] = String(a.enterpriseId);
  }
  if (a.departmentInfo) h['X-Department-Info'] = String(a.departmentInfo);
  const domain = domainFor(a, endpoint);
  if (domain) h['X-Domain'] = domain;
  return h;
}

/** 登录链路的无鉴权头（login() :335-340 no_auth + _enterprise_headers）。 */
export function loginHeaders(a = {}, { endpoint } = {}) {
  const h = {
    'User-Agent': BASE_UA,
    'X-Product-Code': PRODUCT_CODE,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  };
  const domain = domainFor(a, endpoint);
  if (domain) h['X-Domain'] = domain;
  return h;
}
