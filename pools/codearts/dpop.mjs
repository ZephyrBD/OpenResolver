// DPoP（RFC 9449）证明 JWT：ES256 + P-256，供 oauth2/tokens 请求头使用。
// 移植自 vendor/codearts2api/internal/upstream/dpop.go（MIT © HITZY2002）
// newDpopKeyPair :26-40 / signDpopProof :96-124 / dpopKeyPairFromPrivateJWK :57-93。
//
// 华为 STS 把 refresh_token 绑定到首次换取时的 DPoP 公钥：私钥 JWK 必须随账号
// 持久化，刷新必须复用同一对密钥（否则 InvalidDPoPHeader）。
// node:crypto 的 crypto.sign 对 EC 返回 ASN.1 DER；JWT 要求 raw R||S 64 字节，
// 这里统一转 raw 并做低 S 归一化（dpop.go:116-122）。

import crypto from 'node:crypto';

// secp256r1 阶 n（低 S 归一化用）。
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function b64url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** DER（0x30 … 0x02 r 0x02 s）→ {r, s}。 */
export function derToRawSignature(der) {
  let offset = 2; // 0x30 totalLen
  if (der[1] & 0x80) offset += der[1] & 0x7f;
  offset += 1; // 第一个 INTEGER 的 0x02 tag
  const rLen = der[offset];
  const r = der.subarray(offset + 1, offset + 1 + rLen);
  offset += 1 + rLen + 1; // 第二个 INTEGER 的 0x02 tag
  const sLen = der[offset];
  const s = der.subarray(offset + 1, offset + 1 + sLen);
  return { r: new Uint8Array(r), s: new Uint8Array(s) };
}

/** raw R||S → DER（verifyDpopProof 用；INTEGER 高位为 1 时需补 0x00 前缀）。 */
export function rawToDerSignature(r, s) {
  const part = (buf) => {
    const trimmed = buf[0] === 0 ? buf.subarray(1) : buf;
    const needsPad = trimmed[0] & 0x80 ? Buffer.from([0x00]) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from([0x02, trimmed.length + needsPad.length]), needsPad, trimmed]);
  };
  const body = Buffer.concat([part(r), part(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

function padded(bignum) {
  return Uint8Array.from(Buffer.from(bignum.toString(16).padStart(64, '0'), 'hex'));
}

// r/s → 64 字节，s > n/2 时取 n-s（低 S）。
function rawSignatureTo64(r, s) {
  let sVal = BigInt(`0x${Buffer.from(s).toString('hex') || '0'}`);
  if (sVal > P256_N >> 1n) sVal = P256_N - sVal;
  const rVal = BigInt(`0x${Buffer.from(r).toString('hex') || '0'}`);
  const out = new Uint8Array(64);
  out.set(padded(rVal), 0);
  out.set(padded(sVal), 32);
  return out;
}

/** newDpopPrivateJWK（dpop.go:43-55）：生成可持久化的 P-256 私钥 JWK（kty/crv/x/y/d）。 */
export function newDpopPrivateJwk() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

/** jwk → node KeyObject（dpopKeyPairFromPrivateJWK 等价物，node 自带曲线校验）。 */
export function privateKeyFromJwk(jwk) {
  if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error('invalid DPoP JWK curve');
  }
  return crypto.createPrivateKey({ key: { ...jwk }, format: 'jwk' });
}

/** publicJwkOf（dpop.go:33-38）：只含 kty/crv/x/y 的公开 JWK，随 JWT 头发出。 */
export function publicJwkOf(jwk) {
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

/**
 * signDpopProof（dpop.go:96-124）：生成 DPoP JWT（htm=POST，htu=token 端点）。
 * jti = 32 随机字节 hex（64 字符，与 vendor 一致）；iat 秒级时间戳。
 */
export function signDpopProof(jwk, htu, { now = Date.now } = {}) {
  const key = privateKeyFromJwk(jwk);
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwkOf(jwk) };
  const payload = {
    htm: 'POST',
    htu,
    iat: Math.floor(now() / 1000),
    jti: crypto.randomBytes(32).toString('hex'),
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const der = crypto.sign('sha256', Buffer.from(input, 'utf8'), key);
  const { r, s } = derToRawSignature(der);
  const sig = rawSignatureTo64(r, s);
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
}

/** 测试辅助：拆 JWT 三段并用头里的 JWK 公钥验签（node crypto.verify）。 */
export function verifyDpopProof(proof) {
  const [h, p, sig] = proof.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const raw = Buffer.from(sig, 'base64url');
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: header.jwk.x, y: header.jwk.y },
    format: 'jwk',
  });
  const der = rawToDerSignature(new Uint8Array(raw.subarray(0, 32)), new Uint8Array(raw.subarray(32, 64)));
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`, 'utf8'), key, der);
  return { header, payload, ok, signatureLength: raw.length };
}
