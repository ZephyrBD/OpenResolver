import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../../gateway.mjs';
import { createKey } from '../../auth/keys.mjs';

export const zcodePool = {
  name: 'zcode',
  type: 'pool',
  models: () => [
    {
      id: 'GLM-5.3',
      display_name: 'GLM-5.3 (ZCode)',
      context_window: 128000,
      supports_tools: true,
      supports_thinking: true,
    },
    {
      id: 'GLM-5.3-Flash',
      display_name: 'GLM-5.3-Flash (ZCode)',
      context_window: 128000,
      supports_tools: true,
      supports_thinking: true,
    },
  ],
};

export async function startGateway(ctx, { pools = [zcodePool], config = {}, db } = {}) {
  const server = createGateway({ config: { version: '0.1.0', ...config }, pools, db });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  ctx.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${port}`, server };
}

export function seedDb(opts) {
  const db = { version: 1, keys: [] };
  const created = createKey(db, opts);
  return { db, full: created.full, key: created.key };
}
