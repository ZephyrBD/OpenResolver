// 华为云 SDK-HMAC-SHA256 请求签名（AK/SK + 可选 STS security token）。
// 移植自 vendor/codearts2api/internal/upstream/signer.go（MIT © HITZY2002）signRequest :31-124。
//
// 对齐 @huaweicloud/huaweicloud-sdk-core AKSKSigner：
//   - signed headers = 请求里全部头（小写排序），含 x-sdk-content-sha256 与 host
//   - CanonicalURI 每段 percent-encode 且末尾补 "/"
//   - payload hash 取请求体（空体 = 空串的 sha256）

import crypto from 'node:crypto';

export const SIGNING_ALGORITHM = 'SDK-HMAC-SHA256';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmacHex(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

// X-Sdk-Date：UTC `20060102T150405Z`。
export function sdkDateOf(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Go url.QueryEscape： alphanumeric 与 -_.~ 不转义，空格 → '+'。
export function queryEscape(text) {
  return encodeURIComponent(String(text)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  ).replace(/%20/g, '+');
}

// canonicalURI（signer.go:78-88）：每段 percent-encode 且末尾补 "/"。
export function canonicalUri(path) {
  const segments = path.split('/').map((seg) =>
    encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  );
  let out = segments.join('/');
  if (!out.endsWith('/')) out += '/';
  return out;
}

// canonicalQuery（signer.go:91-113）：key/value 各自排序后 QueryEscape 拼接。
export function canonicalQuery(raw) {
  if (!raw) return '';
  const params = new URLSearchParams(raw);
  const keys = [...new Set([...params.keys()])].sort();
  const parts = [];
  for (const key of keys) {
    const values = params.getAll(key).sort();
    for (const value of values) parts.push(`${queryEscape(key)}=${queryEscape(value)}`);
  }
  return parts.join('&');
}

// canonicalHeaders（signer.go:63-75）：全部头小写 key 排序，值仅去首尾空白。
// headers 是普通对象（含 host），遍历时不区分大小写合并。
export function canonicalHeaders(headers) {
  const merged = new Map();
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue;
    const lower = key.toLowerCase();
    const text = Array.isArray(value) ? value.join(', ') : String(value);
    merged.set(lower, text.trim());
  }
  const keys = [...merged.keys()].sort();
  const lines = keys.map((k) => `${k}:${merged.get(k)}\n`);
  return { text: lines.join(''), signed: keys.join(';') };
}

/**
 * signRequest（signer.go:31-60）：给 headers 加 X-Sdk-Date / Host /
 * X-Security-Token / X-Sdk-Content-Sha256 / Authorization 并返回。
 * headers 会被原对象展开（不修改入参），body 为请求体字符串/Buffer（空体传 ''）。
 */
export function signRequest({ method, url, headers = {}, body = '' }, cred, { now = Date.now } = {}) {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : Buffer.from(body ?? '');
  const payloadHash = sha256Hex(payload);

  const allHeaders = { ...headers };
  allHeaders['X-Sdk-Date'] = sdkDateOf(now());
  allHeaders['Host'] = target.host;
  if (cred.securityToken) allHeaders['X-Security-Token'] = cred.securityToken;
  allHeaders['X-Sdk-Content-Sha256'] = payloadHash;

  const { text: canonicalHeadersText, signed: signedHeaders } = canonicalHeaders(allHeaders);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(target.pathname),
    canonicalQuery(target.search.replace(/^\?/, '')),
    canonicalHeadersText,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [SIGNING_ALGORITHM, allHeaders['X-Sdk-Date'], sha256Hex(canonicalRequest)].join('\n');
  const signature = hmacHex(cred.secretAccessKey, stringToSign);

  return {
    ...allHeaders,
    Authorization:
      `${SIGNING_ALGORITHM} Access=${cred.accessKeyID}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
