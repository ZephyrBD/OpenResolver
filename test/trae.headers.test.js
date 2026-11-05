import test from 'node:test';
import assert from 'node:assert/strict';
import {
  soloHeaders,
  ugHeaders,
  oauthHeaders,
  newRequestId,
  ttTraceId,
  UG_USER_AGENT,
} from '../pools/trae/headers.mjs';
import {
  APP_ID,
  IDE_VERSION,
  IDE_VERSION_CODE,
  DEVICE_BRAND,
  OS_VERSION,
  CLIENT_UA,
} from '../pools/trae/constants.mjs';

const ACCOUNT = {
  jwt: 'jwt-abc',
  uid: 'u-42',
  machineId: 'm-1',
  deviceId: 'd-1',
};

test('soloHeaders：对话请求头逐头对齐 vendor/cpa-trae/trae/upstream/headers.go SOLOHeaders', () => {
  const h = soloHeaders(ACCOUNT, true);
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h.Accept, 'text/event-stream', '流式 Accept');
  assert.equal(soloHeaders(ACCOUNT, false).Accept, 'application/json', '非流式 Accept');
  assert.equal(h['User-Agent'], CLIENT_UA);
  assert.equal(h.Authorization, 'Cloud-IDE-JWT jwt-abc');
  assert.equal(h['X-Cloudide-Token'], 'jwt-abc');
  assert.equal(h['X-Ide-Token'], 'jwt-abc');
  assert.equal(h['X-Uid'], 'u-42');
  assert.equal(h['X-App-Id'], APP_ID);
  assert.equal(h['X-App-Version'], 'default');
  assert.equal(h['X-Ide-Version'], IDE_VERSION);
  assert.equal(h['X-Ide-Version-Code'], IDE_VERSION_CODE);
  assert.equal(h['X-App-Version-Code'], IDE_VERSION_CODE);
  assert.equal(h['X-Ide-Version-Type'], 'stable');
  assert.equal(h['X-Device-Type'], 'windows');
  assert.equal(h['X-OS-Version'], OS_VERSION);
  assert.equal(h['X-Device-Brand'], DEVICE_BRAND);
  assert.equal(h['Request-Traffic-Type'], 'prod');
  assert.equal(h['X-Machine-Id'], 'm-1');
  assert.equal(h['X-Device-Id'], 'd-1');
});

test('soloHeaders：缺 uid/machineId/deviceId 时对应头省略（源码仅在非空时 Set）', () => {
  const h = soloHeaders({ jwt: 'j' }, true);
  assert.equal('X-Uid' in h, false);
  assert.equal('X-Machine-Id' in h, false);
  assert.equal('X-Device-Id' in h, false);
  assert.equal(h.Authorization, 'Cloud-IDE-JWT j');
});

test('ugHeaders：VSCode 插件进程 UA 指纹（v0.12.45 抓包），与对话 UA 完全不同', () => {
  const h = ugHeaders(ACCOUNT);
  assert.equal(h['User-Agent'], UG_USER_AGENT);
  assert.equal(UG_USER_AGENT, 'VSCode 1.107.1 (TRAE SOLO CN)');
  assert.equal(h.Accept, '*/*');
  assert.equal(h['X-User-Region'], 'CN');
  assert.equal(h['X-Market-Client-Id'], 'VSCode 1.107.1');
  assert.equal(h['App-Version'], IDE_VERSION);
  assert.equal(h.Authorization, 'Cloud-IDE-JWT jwt-abc');
  assert.equal(h['X-Device-Id'], 'd-1');
  // 抓包实证：真实客户端不带 WebView 画像头
  assert.equal('Origin' in h, false);
  assert.equal('Referer' in h, false);
  assert.equal('x-app-type' in h, false);
  assert.equal('X-App-Type' in h, false);
});

test('ugHeaders：X-Request-Id 是 uuid-v4，X-TT-Trace-Id 格式 00-<32hex>-<16hex>-01 且尾段取自请求 id', () => {
  const h = ugHeaders(ACCOUNT);
  assert.match(h['X-Request-Id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(h['X-TT-Trace-Id'], /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(h['X-TT-Trace-Id'].split('-')[2], h['X-Request-Id'].replace(/-/g, '').slice(0, 16));
});

test('ugHeaders：每请求新生成 Request-Id/Trace-Id；Bearer 回退方案', () => {
  const a = ugHeaders(ACCOUNT);
  const b = ugHeaders(ACCOUNT);
  assert.notEqual(a['X-Request-Id'], b['X-Request-Id']);
  const bearer = ugHeaders(ACCOUNT, { scheme: 'Bearer' });
  assert.equal(bearer.Authorization, 'Bearer jwt-abc');
});

test('newRequestId / ttTraceId 纯函数形状', () => {
  const rid = newRequestId();
  assert.match(rid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const trace = ttTraceId(rid);
  assert.match(trace, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(trace.split('-')[2], rid.replace(/-/g, '').slice(0, 16));
});

test('oauthHeaders：ExchangeToken / GetUserInfo 只带 UA 指纹，无签名', () => {
  const h = oauthHeaders();
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h.Accept, 'application/json');
  assert.equal(h['User-Agent'], CLIENT_UA);
  assert.equal('Authorization' in h, false);
});
