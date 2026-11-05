// ca.dpop.test.js — DPoP ES256 证明 JWT：结构 / raw R||S 64 字节 / 同密钥对可验签 / JTI。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newDpopPrivateJwk,
  signDpopProof,
  verifyDpopProof,
  publicJwkOf,
  derToRawSignature,
  privateKeyFromJwk,
} from '../pools/codearts/dpop.mjs';
import crypto from 'node:crypto';

test('newDpopPrivateJwk：P-256 JWK 形状（kty/crv/x/y/d，base64url 无 padding）', () => {
  const jwk = newDpopPrivateJwk();
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  for (const field of ['x', 'y', 'd']) {
    assert.match(jwk[field], /^[A-Za-z0-9_-]+$/, `${field} 是 base64url`);
    assert.ok(!jwk[field].includes('='), '无 padding');
  }
  const raw = Buffer.from(jwk.x, 'base64url');
  assert.equal(raw.length, 32, 'x 坐标 32 字节');
});

test('publicJwkOf：只含 kty/crv/x/y（dpop.go:33-38）', () => {
  const jwk = newDpopPrivateJwk();
  assert.deepEqual(publicJwkOf(jwk), { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });
});

test('signDpopProof：头 {typ:dpop+jwt,alg:ES256,jwk}、载荷 {htm,htu,iat,jti}、签名 raw 64 字节、可验签', () => {
  const jwk = newDpopPrivateJwk();
  const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
  const htu = 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens';
  const proof = signDpopProof(jwk, htu, { now: () => NOW });
  const { header, payload, ok, signatureLength } = verifyDpopProof(proof);

  assert.equal(ok, true, 'node crypto.verify 验签通过');
  assert.equal(signatureLength, 64, 'raw R||S 64 字节（非 DER）');
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'ES256');
  assert.equal(header.jwk.x, jwk.x);
  assert.equal(header.jwk.y, jwk.y);
  assert.equal(header.jwk.d, undefined, 'JWT 头不带私钥');
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.htu, htu);
  assert.equal(payload.iat, Math.floor(NOW / 1000));
  assert.equal(payload.jti.length, 64, 'jti = 32 随机字节 hex');
});

test('signDpopProof：同一密钥对两次签名 JTI 不同、JWK 相同（vendor upstream_test.go:239-253）', () => {
  const jwk = newDpopPrivateJwk();
  const a = verifyDpopProof(signDpopProof(jwk, 'https://u'));
  const b = verifyDpopProof(signDpopProof(jwk, 'https://u'));
  assert.notEqual(a.payload.jti, b.payload.jti, '每次证明用新 jti');
  assert.deepEqual(a.header.jwk, b.header.jwk);
});

test('signDpopProof：私钥 JWK 持久化后复用，公钥分量不变（refresh_token 双绑定前提）', () => {
  const jwk = newDpopPrivateJwk();
  const roundTrip = JSON.parse(JSON.stringify(jwk));
  const a = verifyDpopProof(signDpopProof(jwk, 'https://u'));
  const b = verifyDpopProof(signDpopProof(roundTrip, 'https://u'));
  assert.deepEqual(a.header.jwk, b.header.jwk, '恢复出的密钥对公钥一致');
});

test('低 S 归一化：所有签名的 s ≤ n/2（dpop.go:116-122）', () => {
  const jwk = newDpopPrivateJwk();
  const key = privateKeyFromJwk(jwk);
  const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  for (let i = 0; i < 16; i++) {
    const proof = signDpopProof(jwk, 'https://u');
    const raw = Buffer.from(proof.split('.')[2], 'base64url');
    const s = BigInt(`0x${raw.subarray(32).toString('hex')}`);
    assert.ok(s <= N >> 1n, `第 ${i} 次签名 s 为低 S`);
    void key;
  }
});

test('derToRawSignature：标准 DER 双 INTEGER 拆解', () => {
  // 手工 DER：0x30 0x08 0x02 0x01 0xAA 0x02 0x03 0x00BBCC
  const der = Buffer.from([0x30, 0x08, 0x02, 0x01, 0xaa, 0x02, 0x03, 0x00, 0xbb, 0xcc]);
  const { r, s } = derToRawSignature(der);
  assert.deepEqual(Buffer.from(r), Buffer.from([0xaa]));
  assert.deepEqual(Buffer.from(s), Buffer.from([0x00, 0xbb, 0xcc]));
});

test('私钥 JWK 缺字段 / 曲线错 → privateKeyFromJwk 抛错（dpop.go:59）', () => {
  assert.throws(() => privateKeyFromJwk({ kty: 'EC', crv: 'P-256' }), /invalid DPoP JWK curve/);
  assert.throws(() => privateKeyFromJwk(null), /invalid DPoP JWK curve/);
});
