import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, sseEvents } from '../adapters/sse-reader.mjs';

/** mulberry32：固定种子，保证边界切分点可复现。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feedAll(parser, text) {
  return parser.push(text);
}

/** 把 text 按 n 个随机点切成 n+1 段，逐段 push，收集全部事件。 */
function feedFragmented(parser, text, seed, cuts) {
  const r = rng(seed);
  const points = Array.from({ length: cuts }, () => Math.floor(r() * text.length)).sort((a, b) => a - b);
  const events = [];
  let prev = 0;
  for (const p of points) {
    events.push(...parser.push(text.slice(prev, p)));
    prev = p;
  }
  events.push(...parser.push(text.slice(prev)));
  events.push(...parser.drain());
  return { events, points };
}

test('parses a whole multi-event stream: event+data, comments, [DONE]', () => {
  const p = createSseParser();
  const events = feedAll(
    p,
    [
      ': keep-alive',
      'event: message_start',
      'data: {"type":"message_start"}',
      '',
      'event: content_block_delta',
      'data: {"type":"text_delta"}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n'),
  );

  assert.deepEqual(events, [
    { event: 'message_start', data: '{"type":"message_start"}' },
    { event: 'content_block_delta', data: '{"type":"text_delta"}' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('feeds the same stream split at 20 random byte boundaries and gets identical events', () => {
  const text = [
    ': ping',
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好 world"}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const whole = createSseParser();
  const expected = [...feedAll(whole, text), ...whole.drain()];

  const p = createSseParser();
  const { events, points } = feedFragmented(p, text, 20260203, 20);
  assert.equal(points.length, 20);
  assert.equal(points.every((v, i) => i === 0 || v >= points[i - 1]), true);
  assert.deepEqual(events, expected);
  assert.equal(events.length, 3);
});

test('survives a `data: ` prefix split as `da` + `ta: `', () => {
  const p = createSseParser();
  let events = p.push('event: message\nda');
  assert.deepEqual(events, []);
  events = p.push('ta: {"ok":true}\n\n');
  assert.deepEqual(events, [{ event: 'message', data: '{"ok":true}' }]);
});

test('survives a JSON body and the \\n\\n separator split across chunks', () => {
  const p = createSseParser();
  let events = p.push('data: {"a":1,"b":[1,2,');
  assert.deepEqual(events, []);
  events = p.push('3]}\n');
  assert.deepEqual(events, []);
  events = p.push('\ndata: [DONE]\n');
  assert.deepEqual(events, [{ event: 'message', data: '{"a":1,"b":[1,2,3]}' }]);
  assert.deepEqual(p.drain(), [{ event: 'message', data: '[DONE]' }]);
});

test('joins multi-line data with \\n', () => {
  const p = createSseParser();
  const events = p.push('data: a\ndata: b\n\n');
  assert.deepEqual(events, [{ event: 'message', data: 'a\nb' }]);
});

test('accepts \\r\\n, bare \\r, and mixed line endings', () => {
  const p = createSseParser();
  const events = [
    ...p.push('event: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: 3\r\rdata: 4\r\n'),
    ...p.drain(),
  ];
  assert.deepEqual(events, [
    { event: 'a', data: '1\n2' },
    { event: 'message', data: '3' },
    { event: 'message', data: '4' },
  ]);
});

test('a trailing lone \\r before a \\n is one \\r\\n terminator, not an extra blank line', () => {
  const p = createSseParser();
  let events = p.push('data: x\r');
  assert.deepEqual(events, []);
  events = p.push('\ndata: y\r\n\r\n');
  assert.deepEqual(events, [{ event: 'message', data: 'x\ny' }]);
});

test('drain flushes a trailing event with no final blank line and reset clears state', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: last'), []);
  assert.deepEqual(p.drain(), [{ event: 'message', data: 'last' }]);
  assert.deepEqual(p.drain(), [], 'drain 幂等');

  p.push('event: stale\ndata: 1\n\n');
  p.reset();
  assert.deepEqual(p.push('data: fresh\n\n'), [{ event: 'message', data: 'fresh' }]);
});

test('sseEvents async-iterates buffers into events', async () => {
  async function* source() {
    yield Buffer.from('event: message_start\nda');
    yield Buffer.from('ta: {"a":1}\n\ndata: [DONE]\n\n');
  }
  const events = [];
  for await (const ev of sseEvents(source())) events.push(ev);
  assert.deepEqual(events, [
    { event: 'message_start', data: '{"a":1}' },
    { event: 'message', data: '[DONE]' },
  ]);
});
