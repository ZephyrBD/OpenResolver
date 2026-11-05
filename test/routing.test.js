import test from 'node:test';
import assert from 'node:assert/strict';
import { routeModel, RouteError } from '../routing.mjs';

const POOLS = ['zcode', 'qoder-cn', 'qoder', 'trae', 'wb-cn', 'wb-global'];

test('splits "<pool>/<model>" at the first slash', () => {
  assert.deepEqual(routeModel('zcode/GLM-5.3', POOLS), { pool: 'zcode', model: 'GLM-5.3' });
  assert.deepEqual(routeModel('trae/deepseek/v4-flash', POOLS), {
    pool: 'trae',
    model: 'deepseek/v4-flash',
  });
});

test('rejects a bare model id because pool is ambiguous', () => {
  assert.throws(
    () => routeModel('GLM-5.3', POOLS),
    (err) => err instanceof RouteError && err.status === 400 && /<pool>\//.test(err.message),
  );
});

test('rejects an unknown pool prefix', () => {
  assert.throws(
    () => routeModel('nope/GLM-5.3', POOLS),
    (err) => err instanceof RouteError && err.status === 400 && /nope/.test(err.message),
  );
});

test('rejects an empty model after the prefix', () => {
  assert.throws(
    () => routeModel('zcode/', POOLS),
    (err) => err instanceof RouteError && err.status === 400,
  );
});
