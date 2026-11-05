import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolScheduler, sessionKeyOf } from '../pools/base.mjs';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const MIN = 60_000;

function makeScheduler(accounts, { settings = {}, rng = () => 0, quotaRatio } = {}) {
  let clock = NOW;
  const scheduler = createPoolScheduler({
    name: 'test',
    accounts,
    settings: { stickyTtlMs: 30 * MIN, ...settings },
    rng,
    now: () => clock,
    quotaRatio,
  });
  return { scheduler, advance: (ms) => (clock += ms), at: () => clock };
}

test('manualWeight 0 is a hard filter even when it is the only account', () => {
  const { scheduler } = makeScheduler([{ id: 'a', manualWeight: 0 }]);
  assert.equal(scheduler.pick(), null);
  assert.equal(scheduler.snapshot()[0].manualWeight, 0);
});

test('weight formula matches the documented constants exactly', () => {
  const { scheduler } = makeScheduler(
    [{ id: 'a', manualWeight: 2, lastUsedAt: NOW - 2 * HOUR }],
    { quotaRatio: () => 1 },
  );
  const acc = scheduler.accounts[0];
  // 最近 4 次全成功 → successFactor = 3
  acc.outcomes = [1, 1, 1, 1];
  // (quota 1.0×10) + (闲置 2h×0.5) + (100%×3) = 14；× manualWeight 2 = 28
  assert.equal(scheduler.weightOf(acc), 28);
});

test('a null quotaRatio borrows the candidate-set mean instead of being punished', () => {
  const ratios = { known: 0.5, nullish: null };
  const { scheduler } = makeScheduler(
    [
      { id: 'known', manualWeight: 1, lastUsedAt: NOW },
      { id: 'nullish', manualWeight: 1, lastUsedAt: NOW },
    ],
    { quotaRatio: (acc) => ratios[acc.id] },
  );
  scheduler.accounts.forEach((acc) => {
    acc.outcomes = [0];
  });
  const known = scheduler.accounts[0];
  const nullish = scheduler.accounts[1];
  assert.equal(scheduler.weightOf(known), 5, '已知 0.5 → quotaFactor 5');
  assert.equal(scheduler.weightOf(nullish), 5, 'null 账号与已知账号权重相等');
});

test('null quota uses the mean of known values in the candidate set', () => {
  const ratios = { low: 0.2, mid: null, high: 0.8 };
  const { scheduler } = makeScheduler(
    [
      { id: 'low', manualWeight: 1, lastUsedAt: NOW },
      { id: 'mid', manualWeight: 1, lastUsedAt: NOW },
      { id: 'high', manualWeight: 1, lastUsedAt: NOW },
    ],
    { quotaRatio: (acc) => ratios[acc.id] },
  );
  scheduler.accounts.forEach((acc) => {
    acc.outcomes = [0];
  });
  const [low, mid, high] = scheduler.accounts;
  assert.equal(scheduler.weightOf(low), 2);
  assert.equal(scheduler.weightOf(mid), 5, '均值 (0.2+0.8)/2 = 0.5');
  assert.equal(scheduler.weightOf(high), 8);
  assert.ok(scheduler.weightOf(mid) > scheduler.weightOf(low));
  assert.ok(scheduler.weightOf(mid) < scheduler.weightOf(high));

  // 候选集里没有已知值时按 0 处理，彼此相等
  assert.equal(scheduler.weightOf(mid, [mid]), 0);
  assert.equal(scheduler.weightOf(mid, [mid]), scheduler.weightOf(mid, [mid]));
  // 候选集缩小后均值随候选集变化
  assert.equal(scheduler.weightOf(mid, [low, mid]), 2, '只剩 low 一个已知值 → 0.2');
});

test('all-zero weights pick uniformly across every candidate, not a fixed fallback', () => {
  const seq = [0, 0.999];
  let call = 0;
  const { scheduler } = makeScheduler(
    [
      { id: 'a', manualWeight: 1, lastUsedAt: NOW },
      { id: 'b', manualWeight: 1, lastUsedAt: NOW },
    ],
    { settings: { topN: 1 }, rng: () => seq[call++ % seq.length] },
  );
  scheduler.accounts.forEach((acc) => {
    acc.outcomes = [0]; // 权重全为 0
  });
  const seen = new Set();
  for (let i = 0; i < 10; i++) seen.add(scheduler.pick().id);
  assert.deepEqual([...seen].sort(), ['a', 'b'], '不能钉死在 top-N 的某一个账号');
});

test('Top-N truncation keeps low-weight accounts out when N=1', () => {
  const { scheduler } = makeScheduler(
    [
      { id: 'high', manualWeight: 1, lastUsedAt: NOW },
      { id: 'low', manualWeight: 1, lastUsedAt: NOW },
    ],
    { settings: { topN: 1 }, rng: () => 0.999, quotaRatio: (acc) => (acc.id === 'high' ? 1 : 0.1) },
  );
  scheduler.accounts.forEach((acc) => {
    acc.outcomes = [1];
  });
  for (let i = 0; i < 20; i++) assert.equal(scheduler.pick().id, 'high');
});

test('success rate only counts the most recent 50 attempts', () => {
  const { scheduler } = makeScheduler([{ id: 'a', manualWeight: 1, lastUsedAt: NOW }]);
  const acc = scheduler.accounts[0];
  for (let i = 0; i < 10; i++) scheduler.onUpstreamError(acc, { kind: 'client' });
  for (let i = 0; i < 50; i++) scheduler.onSuccess(acc);
  assert.equal(acc.outcomes.length, 50);
  assert.equal(scheduler.weightOf(acc), 3, '窗口内 100% 成功 → successFactor 3');
});

test('breaker starts at the threshold: 30/60/120 min, capped at 6h', () => {
  const { scheduler, advance, at } = makeScheduler([{ id: 'a', manualWeight: 1 }]);
  const acc = scheduler.accounts[0];
  const cooldowns = [];
  for (let i = 0; i < 8; i++) {
    advance(1);
    scheduler.onUpstreamError(acc, { kind: 'server' });
    cooldowns.push(acc.cooldownUntil - at());
  }
  assert.equal(cooldowns[0], 60_000, '第 1 次仍用 server 基数');
  assert.equal(cooldowns[1], 60_000, '第 2 次仍用 server 基数');
  assert.equal(cooldowns[2], 30 * MIN, '第 3 次（阈值）= 30min');
  assert.equal(cooldowns[3], 60 * MIN, '第 4 次 = 60min');
  assert.equal(cooldowns[4], 120 * MIN, '第 5 次 = 120min');
  assert.equal(cooldowns[7], 6 * HOUR, '封顶 6h');
});

test('breaker cooldown and kind cooldown take the longer one', () => {
  const { scheduler, advance, at } = makeScheduler([{ id: 'a', manualWeight: 1 }], {
    settings: { blockedCooldownMs: 10 * MIN, busyCooldownMs: 90_000, quotaCooldownMs: 30 * MIN },
  });
  const acc = scheduler.accounts[0];
  for (let i = 0; i < 3; i++) {
    advance(1);
    scheduler.onUpstreamError(acc, { kind: 'blocked' });
  }
  assert.equal(acc.cooldownUntil - at(), 30 * MIN, 'blocked 3 次 → max(10min, 30min) = 30min');

  const { scheduler: s2, advance: adv2, at: at2 } = makeScheduler([{ id: 'b', manualWeight: 1 }]);
  const b = s2.accounts[0];
  for (let i = 0; i < 3; i++) {
    adv2(1);
    s2.onUpstreamError(b, { kind: 'rate_limit' });
  }
  assert.equal(b.cooldownUntil - at2(), 30 * MIN, 'rate_limit 3 次 → max(30min, 30min) = 30min');
});

test('a shorter cooldown never overwrites a longer one still running', () => {
  const { scheduler } = makeScheduler([{ id: 'a', manualWeight: 1 }]);
  const acc = scheduler.accounts[0];
  scheduler.onUpstreamError(acc, { kind: 'blocked' });
  const until = acc.cooldownUntil;
  scheduler.onUpstreamError(acc, { kind: 'client' }); // 0 冷却
  assert.equal(acc.cooldownUntil, until, 'client 的 0 冷却不得抹掉风控冷却');
});

test('rate limit: first offence 90s, repeat offence 30min', () => {
  const { scheduler } = makeScheduler([{ id: 'a', manualWeight: 1 }]);
  const acc = scheduler.accounts[0];
  scheduler.onUpstreamError(acc, { kind: 'rate_limit' });
  assert.equal(acc.cooldownUntil - scheduler.now(), 90_000);
  scheduler.onUpstreamError(acc, { kind: 'rate_limit' });
  assert.equal(acc.cooldownUntil - scheduler.now(), 30 * MIN);
});

test('all accounts cooling: fall back to the earliest recovery, but never a tried one', () => {
  const { scheduler } = makeScheduler([
    { id: 'a', manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  const [a, b] = scheduler.accounts;
  scheduler.onUpstreamError(a, { kind: 'rate_limit' }); // 90s
  scheduler.onUpstreamError(b, { kind: 'blocked' }); // 10min

  assert.equal(scheduler.pick().id, 'a', '最早恢复者兜底');
  assert.equal(scheduler.pick({ exclude: new Set([a.id]) }).id, 'b');
  assert.equal(scheduler.pick({ exclude: new Set([a.id, b.id]) }), null);
  assert.equal(scheduler.pick({ exclude: new Set(['a', 'b']) }), null, 'exclude 也接受 id 字符串');
});

test('sticky sessions honour the TTL and survive updateAccount by id', () => {
  const { scheduler, advance } = makeScheduler([
    { id: 'a', manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  const [a] = scheduler.accounts;

  scheduler.stickySet('k', a);
  assert.equal(scheduler.stickyGet('k'), a);
  advance(30 * MIN + 1);
  assert.equal(scheduler.stickyGet('k'), null, 'TTL 过期');

  scheduler.stickySet('k2', a);
  advance(29 * MIN);
  assert.equal(scheduler.stickyGet('k2'), a, '命中续期');

  const next = scheduler.updateAccount('a', { label: 'renamed' });
  assert.equal(next.label, 'renamed');
  assert.equal(scheduler.accounts[0], a, 'updateAccount 保持对象身份，不重建');
  assert.equal(scheduler.stickyGet('k2'), next, '粘性仍然命中同一对象');
});

test('updateAccount edits in place: other accounts and target runtime state untouched', () => {
  const { scheduler, advance } = makeScheduler([
    { id: 'a', manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  const [a, b] = scheduler.accounts;
  scheduler.onUpstreamError(b, { kind: 'server' });
  b.outcomes.push(1);
  const bCooldown = b.cooldownUntil;
  const bFails = b.consecutiveFails;
  const bOutcomes = [...b.outcomes];
  advance(1000);
  scheduler.onUpstreamError(a, { kind: 'rate_limit' });
  const aCooldown = a.cooldownUntil;
  const aFails = a.consecutiveFails;
  const aOutcomes = [...a.outcomes];

  scheduler.updateAccount('a', { label: 'A2' });

  assert.equal(scheduler.accounts[1], b, '其他账号对象不变');
  assert.equal(b.cooldownUntil, bCooldown);
  assert.equal(b.consecutiveFails, bFails);
  assert.deepEqual(b.outcomes, bOutcomes);

  assert.equal(scheduler.accounts[0], a, '目标账号也是同一对象');
  assert.equal(a.label, 'A2');
  assert.equal(a.cooldownUntil, aCooldown, '编辑不改冷却');
  assert.equal(a.consecutiveFails, aFails);
  assert.deepEqual(a.outcomes, aOutcomes, '编辑不改成功率记录');
  assert.equal(a.state, 'ok', 'state 默认保留旧值');
});

test('updateAccount keeps the picked object identity so inFlight is decremented on the live account', () => {
  const { scheduler } = makeScheduler([
    { id: 'a', manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  const picked = scheduler.pick();
  assert.equal(picked.id, 'a');
  scheduler.updateAccount('a', { label: 'x' });
  assert.equal(scheduler.pick(), picked, '编辑后 pick 返回的仍是同一个对象引用');

  // 模拟在途：send() 持有的引用在编辑后减 1，必须落在同一对象上归零
  picked.inFlight = 1;
  scheduler.updateAccount('a', { label: 'x' });
  picked.inFlight -= 1;
  assert.equal(picked.inFlight, 0, '在途计数不能泄漏到孤儿对象');

  // onSuccess 记账必须落在编辑后的账号上
  const before = picked.outcomes.length;
  scheduler.onSuccess(picked);
  assert.equal(picked.outcomes.length, before + 1, 'outcomes 记账落在同一对象');
  assert.equal(scheduler.successRateOf(picked), 1);
  assert.equal(scheduler.snapshot().find((item) => item.id === 'a').successRate, 1);
});

test('updateAccount clamps manualWeight to 0..20', () => {
  const { scheduler } = makeScheduler([{ id: 'a', manualWeight: 1 }]);
  assert.equal(scheduler.updateAccount('a', { manualWeight: 99 }).manualWeight, 20);
  assert.equal(scheduler.updateAccount('a', { manualWeight: -3 }).manualWeight, 0);
  assert.equal(scheduler.updateAccount('a', { manualWeight: 7.6 }).manualWeight, 7.6);
});

test('accounts without an id get stable pool-scoped ids and stay addressable', () => {
  const { scheduler } = makeScheduler([
    { manualWeight: 1, jwt: 'a' },
    { manualWeight: 1, jwt: 'b' },
  ]);
  const [a, b] = scheduler.accounts;
  assert.equal(a.id, 'test:0');
  assert.equal(b.id, 'test:1');
  assert.equal(scheduler.pick({ exclude: new Set([a.id]) }), b, 'exclude 按生成的 id 生效');
  scheduler.stickySet('k', b);
  assert.equal(scheduler.stickyGet('k'), b, '无 id 账号也能绑定粘性');
});

test('updateAccount keeps the id immutable and preserves inFlight', () => {
  const { scheduler } = makeScheduler([{ id: 'a', manualWeight: 1 }]);
  scheduler.accounts[0].inFlight = 2;
  const next = scheduler.updateAccount('a', { id: 'hacked', label: 'x' });
  assert.equal(next.id, 'a');
  assert.equal(next.label, 'x');
  assert.equal(next.inFlight, 2, '在途并发不能被编辑清掉');
  assert.equal(scheduler.updateAccount('missing', {}), null);
});

test('auth failures mark needs_login and stay excluded until a success', () => {
  const { scheduler } = makeScheduler([
    { id: 'a', manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  const [a, b] = scheduler.accounts;
  scheduler.onUpstreamError(a, { kind: 'auth' });
  assert.equal(a.state, 'needs_login');
  assert.equal(scheduler.snapshot().find((item) => item.id === 'a').state, 'needs_login');

  for (let i = 0; i < 10; i++) {
    assert.equal(scheduler.pick({ allowFallback: false }), b, 'needs_login 账号不得入选');
  }
  scheduler.onUpstreamError(a, { kind: 'server' });
  assert.equal(a.state, 'needs_login', '其他 kind 不得把 state 改回 ok');

  scheduler.onSuccess(a);
  assert.equal(a.state, 'ok');
  assert.equal(scheduler.snapshot().find((item) => item.id === 'a').state, 'ok');
});

test('enabled === 0 disables the account', () => {
  const { scheduler } = makeScheduler([
    { id: 'a', enabled: 0, manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  assert.equal(scheduler.pick().id, 'b');
  assert.equal(scheduler.snapshot()[0].enabled, false);
});

test('inFlight at the cap is not selectable', () => {
  const { scheduler } = makeScheduler([
    { id: 'a', manualWeight: 1 },
    { id: 'b', manualWeight: 1 },
  ]);
  scheduler.accounts[0].inFlight = 5;
  scheduler.accounts[1].inFlight = 5;
  assert.equal(scheduler.pick(), null);
  scheduler.accounts[1].inFlight = 4;
  assert.equal(scheduler.pick().id, 'b');
});

test('sessionKeyOf prioritises headers, falls back to the first user text and mixes in the key id', () => {
  const req = (headers) => ({ headers });
  const body = { messages: [{ role: 'user', content: 'hello' }] };

  const bySession = sessionKeyOf({ req: req({ 'x-ugw-session': 'S1', 'x-session-id': 'S2' }), body, keyId: 'A' });
  const bySessionHeader = sessionKeyOf({ req: req({ 'x-session-id': 'S2' }), body, keyId: 'A' });
  const withBothHeaders = sessionKeyOf({ req: req({ 'x-session-id': 'S2', 'x-conversation-id': 'S3' }), body, keyId: 'A' });
  const onlyConversation = sessionKeyOf({ req: req({ 'x-conversation-id': 'S3' }), body, keyId: 'A' });
  assert.notEqual(bySession, bySessionHeader, 'x-ugw-session 优先');
  assert.equal(bySessionHeader, withBothHeaders, 'x-session-id 优先于 x-conversation-id');
  assert.notEqual(bySessionHeader, onlyConversation, 'x-conversation-id 是不同的 key');
  assert.equal(
    sessionKeyOf({ req: req({}), body: { ...body, metadata: { conversation_id: 'S3' } }, keyId: 'A' }),
    onlyConversation,
    'metadata.conversation_id 与同名 header 等价',
  );

  const byConversation = sessionKeyOf({
    req: req({}),
    body: { messages: [], metadata: { conversation_id: 'c1' } },
    keyId: 'A',
  });
  assert.ok(byConversation);

  const fallback = sessionKeyOf({ req: req({}), body, keyId: 'A' });
  const fallbackAgain = sessionKeyOf({ req: req({}), body, keyId: 'A' });
  assert.equal(fallback, fallbackAgain);

  const otherText = sessionKeyOf({
    req: req({}),
    body: { messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'other' }] },
    keyId: 'A',
  });
  assert.notEqual(fallback, otherText);

  const otherKey = sessionKeyOf({ req: req({}), body, keyId: 'B' });
  assert.notEqual(fallback, otherKey, '不同 API key 同首句不得撞 key');
  assert.equal(sessionKeyOf({ req: req({}), body }), sessionKeyOf({ req: req({}), body }), 'keyId 缺省也可用');
});
