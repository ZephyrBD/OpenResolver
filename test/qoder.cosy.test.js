import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { qoderEncodeBody, qoderStdAlphabet, qoderCustomAlphabet } from '../pools/qoder/encode.mjs';
import { buildAuthHeaders, computeSigPath, QODER_MACHINE_OS } from '../pools/qoder/cosy.mjs';
import { machineIdFor } from '../pools/qoder/identity.mjs';
import { chatUrl } from '../pools/qoder/region.mjs';

test('qoderEncodeBody: 已知输入手算期望字节（"ab" → base64 YWI= → 尾/中/头重排 + 自定义字母表）', () => {
  // "ab" → std base64 "YWI="（n=4, a=1）→ tail "=" + middle "WI" + head "Y"
  // （"=" → "$"，"W" 标准表 22 → 自定义表 "S"，"I" → 8 → "B"，"Y" → 24 → "#"）→ "$SB#"
  assert.equal(qoderEncodeBody('ab').toString('binary'), '$SB#');
});

test('qoderEncodeBody: "abc" → std "YWJj"（n=4,a=1）→ tail "j" + middle "WJ" + head "Y" → "MSK#"', () => {
  assert.equal(qoderEncodeBody('abc').toString('binary'), 'MSK#');
});

test('qoderEncodeBody: "a" → std "YQ==" → tail "=" + middle "Q=" + head "Y" → "$p$#"', () => {
  assert.equal(qoderEncodeBody('a').toString('binary'), '$p$#');
});

test('qoderEncodeBody: 输出长度等于 std base64 长度；空输入得空输出', () => {
  const json = JSON.stringify({ hello: 'world', n: 42 });
  assert.equal(qoderEncodeBody(json).length, Buffer.from(json).toString('base64').length);
  assert.equal(qoderEncodeBody('').length, 0);
});

test('computeSigPath: /algo 前缀剥掉，其余路径原样', () => {
  assert.equal(computeSigPath('https://x.example/algo/api/v2/service/pro/sse/agent_chat_generation?a=1'), '/api/v2/service/pro/sse/agent_chat_generation');
  assert.equal(computeSigPath('https://x.example/api/v1/jobToken/exchange'), '/api/v1/jobToken/exchange');
});

const FIXED_UUID = '11111111-1111-4111-8111-111111111111';
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const FIXED_CREDS = { userID: 'u-1', authToken: 'tok-1', name: 'n', email: 'e@x', machineID: 'mach-1' };

test('buildAuthHeaders: 18 个头全部存在且值符合固定时间/uuid 注入', () => {
  const body = Buffer.from('encoded-bytes');
  const headers = buildAuthHeaders(body, chatUrl('global'), FIXED_CREDS, {
    randomUUID: () => FIXED_UUID,
    now: () => FIXED_NOW,
  });

  const expectedKeys = [
    'Authorization', 'Cosy-Key', 'Cosy-User', 'Cosy-Date', 'Cosy-Version',
    'Cosy-Machineid', 'Cosy-Machinetoken', 'Cosy-Machinetype', 'Cosy-Machineos',
    'Cosy-Clienttype', 'Cosy-Clientip', 'Cosy-Bodyhash', 'Cosy-Bodylength',
    'Cosy-Sigpath', 'Cosy-Data-Policy', 'Cosy-Organization-Id', 'Cosy-Organization-Tags',
    'Login-Version', 'X-Request-Id',
  ];
  for (const key of expectedKeys) assert.ok(headers[key] !== undefined, `缺少头 ${key}`);
  assert.equal(Object.keys(headers).length, expectedKeys.length);

  assert.match(headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/);
  assert.equal(headers['Cosy-User'], 'u-1');
  assert.equal(headers['Cosy-Date'], Math.floor(FIXED_NOW / 1e3).toString());
  assert.equal(headers['Cosy-Machineid'], 'mach-1');
  assert.equal(headers['Cosy-Machinetoken'], 'mach-1');
  assert.equal(headers['Cosy-Machineos'], 'x86_64_linux', '简报裁决：恒为 x86_64_linux');
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/service/pro/sse/agent_chat_generation');
  assert.equal(headers['X-Request-Id'], FIXED_UUID);
});

test('buildAuthHeaders: Bodyhash 是对编码后字节的 md5；sig 对编码后字节算（可用头部里的 cosyKey 复算）', () => {
  const body = Buffer.from('qoder-encoded-payload');
  const headers = buildAuthHeaders(body, chatUrl('global'), FIXED_CREDS, {
    randomUUID: () => FIXED_UUID,
    now: () => FIXED_NOW,
  });

  assert.equal(headers['Cosy-Bodyhash'], crypto.createHash('md5').update(body).digest('hex'));
  assert.equal(headers['Cosy-Bodylength'], String(body.length));

  const authParts = headers.Authorization.split('.');
  const payloadB64 = authParts[1];
  const sig = authParts[2];
  const recomputed = crypto
    .createHash('md5')
    .update(payloadB64)
    .update('\n')
    .update(headers['Cosy-Key'])
    .update('\n')
    .update(headers['Cosy-Date'])
    .update('\n')
    .update(body)
    .update('\n')
    .update(headers['Cosy-Sigpath'])
    .digest('hex');
  assert.equal(sig, recomputed, 'sig 必须是对编码后字节的 md5');
});

test('buildAuthHeaders: 缺 userID / authToken / machineID 直接抛错', () => {
  assert.throws(() => buildAuthHeaders(null, chatUrl('global'), { authToken: 't', machineID: 'm' }));
  assert.throws(() => buildAuthHeaders(null, chatUrl('global'), { userID: 'u', machineID: 'm' }));
  assert.throws(() => buildAuthHeaders(null, chatUrl('global'), { userID: 'u', authToken: 't' }));
});

test('machineIdFor(seed): 稳定、UUIDv4 形状、不同 seed 不同', () => {
  const a1 = machineIdFor('seed-a');
  assert.equal(a1, machineIdFor('seed-a'));
  assert.match(a1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a1, machineIdFor('seed-b'));
});
