import path from 'node:path';

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    version: '0.1.0',
    host: env.HOST || '0.0.0.0',
    port: num(env.PORT, 8790),
    dataDir: env.UGW_DATA_DIR || path.join(import.meta.dirname, 'data'),
    maxBodyBytes: num(env.UGW_MAX_BODY_BYTES, 8 * 1024 * 1024),
    maxAttempts: num(env.UGW_MAX_ATTEMPTS, 3),
    openMode: env.UGW_OPEN_MODE !== '0',
    maxUsageFileBytes: num(env.UGW_MAX_USAGE_FILE_BYTES, 64 * 1024 * 1024),
    upstreamTimeoutMs: num(env.UGW_UPSTREAM_TIMEOUT_MS, 600_000),
    zcodeOrigin: env.ZCODE_UPSTREAM_ORIGIN || 'https://zcode.z.ai',
    zcodeAppVersion: env.ZCODE_APP_VERSION || '3.16.3',
  };
}
