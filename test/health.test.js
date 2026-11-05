import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../gateway.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('GET /health reports ok, version and pool list', async (t) => {
  const server = createGateway({ config: { version: '0.1.0' }, pools: [] });
  const port = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const res = await fetch(`http://127.0.0.1:${port}/health`);

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: '0.1.0', pools: [] });
});
