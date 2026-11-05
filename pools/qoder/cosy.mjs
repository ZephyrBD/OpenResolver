// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :12-130（MIT）
// COSY 请求签名：AES-128-CBC 加密用户信息、RSA 包裹 AES key，
// md5 签名对【编码后字节】算：payloadB64 \n cosyKey \n ts \n bodyBytes \n sigPath。
// 裁决（简报 §14.7）：Cosy-Machineos 恒用 x86_64_linux，不随运行平台变化。

import crypto from 'node:crypto';

export const qoderRSAPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

export const QODER_GATEWAY_COSY_VERSION = '1.1.38';
export const QODER_OPENAPI_COSY_VERSION = '1.0.1';
export const QODER_CLIENT_TYPE = '5';
export const QODER_MACHINE_OS = 'x86_64_linux';
const QODER_MACHINE_TYPE_MAGIC = '5';
const QODER_DATA_POLICY = 'disagree';
const QODER_LOGIN_VERSION = 'v2';

function rsaEncryptBase64(data) {
  const encrypted = crypto.publicEncrypt(
    { key: qoderRSAPublicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    typeof data === 'string' ? Buffer.from(data) : data,
  );
  return encrypted.toString('base64');
}

function aesEncryptCBCBase64(plaintext, keyStr) {
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyStr), Buffer.from(keyStr));
  return cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64');
}

export function computeSigPath(urlStr) {
  let sigPath = new URL(urlStr).pathname;
  if (sigPath.startsWith('/algo')) sigPath = sigPath.substring('/algo'.length);
  return sigPath;
}

/**
 * 构造 18 个 Cosy-* 头 + Authorization。body 是【已编码】的请求体字节。
 * randomUUID/now 可注入，测试用来固定 aesKey、requestId、时间戳。
 */
export function buildAuthHeaders(body, requestURL, creds, { randomUUID = crypto.randomUUID, now = Date.now } = {}) {
  if (!creds.userID) throw new Error('cosy: user id is empty');
  if (!creds.authToken) throw new Error('cosy: auth token is empty');

  const aesKey = randomUUID().replace(/-/g, '').slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || '',
    aid: '',
    email: creds.email || '',
  };
  const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
  const cosyKey = rsaEncryptBase64(aesKey);
  const timestamp = Math.floor(now() / 1e3).toString();
  const requestId = randomUUID();
  const cosyPayload = {
    version: 'v1',
    requestId,
    info: infoB64,
    cosyVersion: QODER_GATEWAY_COSY_VERSION,
    ideVersion: '',
  };
  const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString('base64');
  const sigPath = computeSigPath(requestURL);
  const bodyBytes = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  const sig = crypto
    .createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(cosyKey)
    .update('\n')
    .update(timestamp)
    .update('\n')
    .update(bodyBytes)
    .update('\n')
    .update(sigPath)
    .digest('hex');
  const bodyHash = crypto.createHash('md5').update(bodyBytes).digest('hex');
  const machineID = creds.machineID;
  if (!machineID) throw new Error('cosy: machine id is empty');

  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': creds.userID,
    'Cosy-Date': timestamp,
    'Cosy-Version': QODER_GATEWAY_COSY_VERSION,
    'Cosy-Machineid': machineID,
    'Cosy-Machinetoken': machineID,
    'Cosy-Machinetype': QODER_MACHINE_TYPE_MAGIC,
    'Cosy-Machineos': QODER_MACHINE_OS,
    'Cosy-Clienttype': QODER_CLIENT_TYPE,
    'Cosy-Clientip': '127.0.0.1',
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': bodyBytes.length.toString(),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': QODER_DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': QODER_LOGIN_VERSION,
    'X-Request-Id': randomUUID(),
  };
}
