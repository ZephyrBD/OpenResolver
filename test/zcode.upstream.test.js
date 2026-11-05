import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildUpstreamBody } from '../pools/zcode/upstream.mjs';
import { deviceIdFor, sessionIdFor } from '../fingerprint.mjs';

const PROFILE = {
  system: [{ type: 'text', text: 'OFFICIAL SYSTEM 1' }, { type: 'text', text: 'OFFICIAL SYSTEM 2' }],
  max_tokens: 128000,
  tool_choice: { type: 'auto' },
  thinking: { type: 'enabled' },
  output_config: { effort: 'low' },
};

const ACC = { uid: 'uid-1', label: 'a1' };

test('replaces the client system with the official profile system', () => {
  const out = buildUpstreamBody(
    { model: 'GLM-5.3', system: 'be terse', messages: [{ role: 'user', content: 'hi' }] },
    PROFILE,
    ACC,
  );

  assert.deepEqual(out.system, PROFILE.system);
  assert.equal(out.messages[0].role, 'user');
  assert.equal(out.messages[0].content, '<pi_system_instructions>\nbe terse\n</pi_system_instructions>\n\nhi');
});

test('handles array system blocks and array user content', () => {
  const out = buildUpstreamBody(
    {
      model: 'GLM-5.3',
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    },
    PROFILE,
    ACC,
  );

  assert.equal(out.messages[0].content[0].text, '<pi_system_instructions>\nA\n\nB\n</pi_system_instructions>');
  assert.equal(out.messages[0].content[1].text, 'hi');
});

test('adds a synthetic user message when the client sent no messages', () => {
  const out = buildUpstreamBody({ model: 'GLM-5.3', system: 'S', messages: [] }, PROFILE, ACC);
  assert.deepEqual(out.messages, [
    { role: 'user', content: '<pi_system_instructions>\nS\n</pi_system_instructions>' },
  ]);
});

test('stream defaults to false unless explicitly true', () => {
  const base = { model: 'GLM-5.3', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(buildUpstreamBody(base, PROFILE, ACC).stream, false);
  assert.equal(buildUpstreamBody({ ...base, stream: true }, PROFILE, ACC).stream, true);
  assert.equal(buildUpstreamBody({ ...base, stream: 'yes' }, PROFILE, ACC).stream, false);
});

test('carries profile knobs and per-account fingerprint', () => {
  const out = buildUpstreamBody(
    { model: 'GLM-5.3', max_tokens: 999, messages: [{ role: 'user', content: 'hi' }] },
    PROFILE,
    ACC,
  );
  assert.equal(out.model, 'GLM-5.3');
  assert.equal(out.max_tokens, 999);
  assert.deepEqual(out.tool_choice, { type: 'auto' });
  assert.deepEqual(out.thinking, { type: 'enabled' });
  assert.deepEqual(out.output_config, { effort: 'low' });
  assert.deepEqual(JSON.parse(out.metadata.user_id), {
    device_id: deviceIdFor('uid-1'),
    account_uuid: '',
    session_id: sessionIdFor('uid-1'),
  });
});

test('caps max_tokens at the profile limit and only forwards non-empty tools', () => {
  const out = buildUpstreamBody(
    {
      model: 'GLM-5.3',
      max_tokens: 999999,
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'hi' }],
    },
    PROFILE,
    ACC,
  );
  assert.equal(out.max_tokens, 128000);
  assert.equal(out.tools.length, 1);
  assert.equal('tools' in buildUpstreamBody({ model: 'm', tools: [], messages: [] }, PROFILE, ACC), false);
});

test('does not mutate the inbound messages array', () => {
  const inbound = { model: 'GLM-5.3', system: 'S', messages: [{ role: 'user', content: 'hi' }] };
  buildUpstreamBody(inbound, PROFILE, ACC);
  assert.equal(inbound.messages[0].content, 'hi');
});

test('the shipped profile still has three blocks and 10701 chars', () => {
  const profile = JSON.parse(
    readFileSync(new URL('../profile/zcode-profile.json', import.meta.url), 'utf8'),
  );
  assert.equal(profile.system.length, 3);
  assert.equal(profile.system.reduce((n, b) => n + b.text.length, 0), 10701);
  assert.equal(profile.max_tokens, 128000);
});
