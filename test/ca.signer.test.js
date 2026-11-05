// ca.signer.test.js — SDK-HMAC-SHA256 签名字节级锁定。
// vendor Go 测试（upstream_test.go TestSigner）只断言前缀；这里把 CanonicalRequest
// 拼装在测试里独立重写一遍（顺序/编码/排序全手工展开），Authorization 必须 deepEqual。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signRequest, canonicalUri, canonicalQuery, sdkDateOf } from '../pools/codearts/signer.mjs';

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (k, m) => crypto.createHmac('sha256', k).update(m, 'utf8').digest('hex');

test('sdkDateOf：UTC 20060102T150405Z 格式', () => {
  assert.equal(sdkDateOf(Date.UTC(2026, 0, 2, 15, 4, 5)), '20260102T150405Z');
  assert.equal(sdkDateOf(Date.UTC(2026, 10, 5, 0, 0, 0)), '20261105T000000Z');
});

test('canonicalUri：末尾补 / + 每段 percent-encode（signer.go:78-88）', () => {
  assert.equal(canonicalUri('/v1/chat/chat'), '/v1/chat/chat/');
  assert.equal(canonicalUri('/v1/chat/chat/'), '/v1/chat/chat/');
  assert.equal(canonicalUri('/'), '/');
  assert.equal(canonicalUri('/v1/model/builtin'), '/v1/model/builtin/');
  // 保留字符不转义；空格/中文转义
  assert.equal(canonicalUri('/a b/中'), '/a%20b/%E4%B8%AD/');
});

test('canonicalQuery：key/value 各自排序，空格按 Go QueryEscape 为 +（signer.go:91-113）', () => {
  assert.equal(canonicalQuery(''), '');
  assert.equal(canonicalQuery('b=2&a=1'), 'a=1&b=2');
  assert.equal(canonicalQuery('a=2&a=1&b=x y'), 'a=1&a=2&b=x+y');
  assert.equal(canonicalQuery('k=%E4%B8%AD'), 'k=%E4%B8%AD');
});

test('signRequest：固定样例 Authorization 字节级 deepEqual（独立重算 CanonicalRequest）', () => {
  const NOW = Date.UTC(2026, 0, 2, 15, 4, 5);
  const headers = signRequest(
    {
      method: 'POST',
      url: 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/chat/chat',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
    { accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: 'ST' },
    { now: () => NOW },
  );

  // 测试侧独立拼装：payload hash（sha256("{}")）、canonical headers 全小写排序
  const payloadHash = sha256Hex('{}');
  const canonicalHeadersText =
    'content-type:application/json\n' +
    'host:snap-access.cn-north-4.myhuaweicloud.com\n' +
    `x-sdk-content-sha256:${payloadHash}\n` +
    'x-sdk-date:20260102T150405Z\n' +
    'x-security-token:ST\n';
  const signedHeaders = 'content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token';
  const canonicalRequest = [
    'POST',
    '/v1/chat/chat/',
    '',
    canonicalHeadersText,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = ['SDK-HMAC-SHA256', '20260102T150405Z', sha256Hex(canonicalRequest)].join('\n');
  const expected =
    `SDK-HMAC-SHA256 Access=AK, SignedHeaders=${signedHeaders}, Signature=${hmacHex('SK', stringToSign)}`;
  assert.equal(headers.Authorization, expected);

  assert.equal(headers['X-Sdk-Date'], '20260102T150405Z');
  assert.equal(headers.Host, 'snap-access.cn-north-4.myhuaweicloud.com');
  assert.equal(headers['X-Security-Token'], 'ST');
  assert.equal(headers['X-Sdk-Content-Sha256'], payloadHash);
});

test('signRequest：GET 空体 payloadHash = sha256("")；无 securityToken 不加 X-Security-Token 头', () => {
  const emptyHash = sha256Hex('');
  const headers = signRequest(
    { method: 'GET', url: 'https://sts.example/v1/x' },
    { accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: '' },
  );
  assert.equal(headers['X-Sdk-Content-Sha256'], emptyHash);
  assert.equal(headers['X-Security-Token'], undefined);
  assert.ok(headers.Authorization.startsWith('SDK-HMAC-SHA256 Access=AK, SignedHeaders='));
  // signed headers 必含 x-sdk-content-sha256 与 host
  const signed = headers.Authorization.match(/SignedHeaders=([^,]+)/)[1].split(';');
  assert.ok(signed.includes('host'));
  assert.ok(signed.includes('x-sdk-content-sha256'));
});

test('signRequest：头值首尾空白被 trim（signer.go:72）', () => {
  const opts = { now: () => Date.UTC(2026, 0, 2, 15, 4, 5) };
  const cred = { accessKeyID: 'A', secretAccessKey: 'B', securityToken: 'C' };
  const raw = signRequest(
    { method: 'POST', url: 'https://h/p', headers: { 'Content-Type': '  application/json  ' }, body: '' },
    cred,
    opts,
  );
  const trimmed = signRequest(
    { method: 'POST', url: 'https://h/p', headers: { 'Content-Type': 'application/json' }, body: '' },
    cred,
    opts,
  );
  // 签名值只在 CanonicalRequest 里出现：trim 前后签名一致即证明用了 trim 后的值
  assert.equal(raw.Authorization, trimmed.Authorization);
  assert.equal(raw['Content-Type'], '  application/json  ', '原始头不改动');
});
