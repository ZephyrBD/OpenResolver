import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { loadKeys } from './auth/store.mjs';
import { createGateway } from './gateway.mjs';
import { loadSettings, writeSettings } from './pools/settings.mjs';
import { loadAccounts, saveAccounts } from './pools/zcode/accounts.mjs';
import { createZcodePool } from './pools/zcode/index.mjs';
import { createQoderPool } from './pools/qoder/index.mjs';
import { createQoderQuotaCache } from './pools/qoder/quota.mjs';
import { loadIdentitySeed } from './pools/qoder/identity.mjs';
import { createTraePool } from './pools/trae/index.mjs';
import { createWorkbuddyPool } from './pools/workbuddy/index.mjs';
import { createCodeartsPool } from './pools/codearts/index.mjs';
import { identityFromRefreshToken } from './pools/codearts/auth.mjs';
import { SNAP_ENGINE_API_HOST as CA_SNAP_BASE } from './pools/codearts/constants.mjs';
import { createClaimScheduler } from './pools/claim-scheduler.mjs';
import { createClaimer as zcodeClaimer } from './pools/zcode/claim.mjs';
import { createClaimer as qoderClaimer } from './pools/qoder/claim.mjs';
import { createClaimer as traeClaimer } from './pools/trae/checkin.mjs';
import { createClaimer as wbClaimer } from './pools/workbuddy/checkin.mjs';
import { createClaimer as caClaimer } from './pools/codearts/checkin.mjs';
import { regionConfig as qoderRegionConfig } from './pools/qoder/region.mjs';
import { endpointFor as wbEndpointFor } from './pools/workbuddy/constants.mjs';
import { DEFAULT_BIZ_HOST as TRAE_BIZ_HOST } from './pools/trae/constants.mjs';
import { loadAccounts as loadTraeAccounts } from './pools/zcode/accounts.mjs';
import { createPanelGateway } from './panel/api.mjs';
import { createUsageRecorder } from './panel/usage.mjs';

const PROFILE_URL = new URL('./profile/zcode-profile.json', import.meta.url);

function loadProfile() {
  return JSON.parse(fs.readFileSync(PROFILE_URL, 'utf8'));
}

const QODER_REGIONS = ['global', 'cn'];

/**
 * 组装网关：配置 → 密钥库 → 池设置 → 账号池 → HTTP 服务。不负责 listen，方便测试与嵌入。
 * 新池组装失败（无账号/坏配置）只警告，不拖垮网关启动。
 */
export function boot({ env = process.env, log = console.log } = {}) {
  const config = loadConfig(env);
  const dataDir = path.resolve(config.dataDir);
  const zcodeDir = path.join(dataDir, 'pools', 'zcode');
  fs.mkdirSync(zcodeDir, { recursive: true, mode: 0o700 });

  const keysFile = path.join(dataDir, 'keys.json');
  const db = loadKeys(keysFile);

  // 文件优先于环境变量；环境变量只作首次默认值（文档 §6 / §18）。
  // 首次启动就把默认值落一份，让“文件优先”名副其实。
  const settingsFile = path.join(dataDir, 'pool-settings.json');
  const poolSettings = loadSettings({ file: settingsFile, env });
  if (!fs.existsSync(settingsFile)) writeSettings(settingsFile, poolSettings);

  const zcodeAccounts = loadAccounts(zcodeDir);
  const zcode = createZcodePool({
    accounts: zcodeAccounts,
    profile: loadProfile(),
    config: {
      origin: config.zcodeOrigin,
      appVersion: config.zcodeAppVersion,
      maxAttempts: poolSettings.maxAttempts,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      poolSettings,
      settingsFile,
    },
  });

  if (!zcodeAccounts.length) {
    log(`[boot] ZCode 池为空，先跑 node tools/import-zcode.mjs 导入账号`);
  }

  const pools = [zcode];

  // Qoder 池：global + cn 各一个实例；额度缓存接进调度（quotaRatio 注入）。
  let identitySeed = 'default';
  try {
    identitySeed = loadIdentitySeed(dataDir);
  } catch (err) {
    log(`[boot] Qoder identity seed 生成失败：${err?.message}`);
  }

  for (const region of QODER_REGIONS) {
    try {
      const dirName = region === 'cn' ? 'qoder-cn' : 'qoder';
      const qoderDir = path.join(dataDir, 'pools', dirName);
      fs.mkdirSync(qoderDir, { recursive: true, mode: 0o700 });
      const accounts = loadAccounts(qoderDir);
      const quota = createQoderQuotaCache({ mode: region });
      const qoder = createQoderPool({
        accounts,
        config: {
          identitySeed,
          maxAttempts: poolSettings.maxAttempts,
          upstreamTimeoutMs: config.upstreamTimeoutMs,
          poolSettings,
          settingsFile,
          quota,
          modelsCacheFile: path.join(qoderDir, 'models-cache.json'),
        },
        region,
      });
      pools.push(qoder);
      if (!accounts.length) {
        log(`[boot] Qoder ${region} 池为空，先跑 node tools/import-qoder.mjs --pat <pat>${region === 'cn' ? ' --region cn' : ''}`);
      }
    } catch (err) {
      log(`[boot] Qoder ${region} 池组装失败，跳过：${err?.message}`);
    }
  }

  // Trae 池（SOLO CN）：第 4 个池。host 可用环境变量整体指到桩/反代。
  try {
    const traeDir = path.join(dataDir, 'pools', 'trae');
    fs.mkdirSync(traeDir, { recursive: true, mode: 0o700 });
    const traeAccounts = loadTraeAccounts(traeDir);
    const trae = createTraePool({
      accounts: traeAccounts,
      config: {
        chatHost: env.UGW_TRAE_CHAT_HOST,
        bizHost: env.UGW_TRAE_BIZ_HOST,
        apiHost: env.UGW_TRAE_API_HOST,
        accountsFile: path.join(traeDir, 'accounts.json'),
        maxAttempts: poolSettings.maxAttempts,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        poolSettings,
        settingsFile,
      },
      fetchImpl: globalThis.fetch,
    });
    pools.push(trae);
    if (!traeAccounts.length) {
      log(`[boot] Trae 池为空，先跑 node tools/trae-login.mjs --link 登录导入账号`);
    }
  } catch (err) {
    log(`[boot] Trae 池组装失败，跳过：${err?.message}`);
  }

  // WorkBuddy 池（cn + global）：与 qoder/trae 同为默认建池（无账号空转无害，
  // onboard 真机路径依赖池存在）。新池组装失败只警告，不拖垮网关。
  for (const region of ['global', 'cn']) {
    try {
      const dirName = region === 'cn' ? 'workbuddy-cn' : 'workbuddy';
      const wbDir = path.join(dataDir, 'pools', dirName);
      fs.mkdirSync(wbDir, { recursive: true, mode: 0o700 });
      const wbAccounts = loadAccounts(wbDir);
      const wb = createWorkbuddyPool({
        accounts: wbAccounts,
        region,
        config: {
          dataDir,
          endpoint: region === 'cn' ? env.UGW_WB_ENDPOINT_CN : env.UGW_WB_ENDPOINT_GLOBAL,
          accountsFile: path.join(wbDir, 'accounts.json'),
          maxAttempts: poolSettings.maxAttempts,
          upstreamTimeoutMs: config.upstreamTimeoutMs,
          poolSettings,
          settingsFile,
        },
        fetchImpl: globalThis.fetch,
      });
      pools.push(wb);
      // fire-and-forget 模型发现：避免生产永远停在静态降级表
      wb.refreshModels().catch(() => {});
      if (!wbAccounts.length) {
        log(`[boot] WorkBuddy ${region} 池为空，用面板 onboard 登录导入账号`);
      }
    } catch (err) {
      log(`[boot] WorkBuddy ${region} 池组装失败，跳过：${err?.message}`);
    }
  }

  // CodeArts 池（第 7 个池）：默认建池（无账号空转无害，onboard 真机路径依赖池存在）。
  let codeartsPool = null;
  try {
    const caDir = path.join(dataDir, 'pools', 'codearts');
    fs.mkdirSync(caDir, { recursive: true, mode: 0o700 });
    const caAccounts = loadAccounts(caDir);
    // 一次性回填：早期落号的账号没有 userId/userName/domainId（上游 token 响应不带），
    // 而 refresh_token JWT 的 user_profile 里有。目录按 userId 隔离，空键会让发现结果被丢弃，
    // 所以必须在建池前补齐（只填空值，不动 id，改了才落盘）。
    let caChanged = false;
    for (const acc of caAccounts) {
      if (acc.userId && acc.userName && acc.domainId) continue;
      const identity = identityFromRefreshToken(acc.refreshToken);
      if (!identity) continue;
      if (!acc.userId && identity.userId) { acc.userId = identity.userId; caChanged = true; }
      if (!acc.userName && identity.userName) { acc.userName = identity.userName; caChanged = true; }
      if (!acc.domainId && identity.domainId) { acc.domainId = identity.domainId; caChanged = true; }
      if (!acc.label && identity.userName) { acc.label = identity.userName; caChanged = true; }
    }
    if (caChanged) saveAccounts(caDir, caAccounts);
    const codearts = createCodeartsPool({
      accounts: caAccounts,
      config: {
        dataDir,
        snapBase: env.UGW_CA_SNAP_BASE,
        benefitBase: env.UGW_CA_BENEFIT_BASE,
        accountsFile: path.join(caDir, 'accounts.json'),
        maxAttempts: poolSettings.maxAttempts,
        upstreamTimeoutMs: config.upstreamTimeoutMs,
        poolSettings,
        settingsFile,
      },
      fetchImpl: globalThis.fetch,
    });
    codeartsPool = codearts;
    pools.push(codearts);
    // fire-and-forget 模型发现：避免生产永远停在静态降级表
    codearts.refreshModels().catch(() => {});
    if (!caAccounts.length) {
      log(`[boot] CodeArts 池为空，用面板 onboard 登录导入账号`);
    }
  } catch (err) {
    log(`[boot] CodeArts 池组装失败，跳过：${err?.message}`);
  }

  if (!db.keys.length) {
    log(`[boot] 还没有 zsk_ 密钥，跑 node tools/keygen.mjs --name dev 生成一条`);
  }

  // 自动领取（M8d）：每池一个 claimer，claimScheduler 负责每日补领 + ZCode 周末抢领。
  // 必须在 createPanelGateway 之前构造——面板的 claim 路由直接引用这些实例。
  const claimers = {
    zcode: zcodeClaimer({ origin: config.zcodeOrigin }),
    qoder: qoderClaimer({ openApiUrl: qoderRegionConfig('global').openApiUrl, name: 'qoder' }),
    'qoder-cn': qoderClaimer({ openApiUrl: qoderRegionConfig('cn').openApiUrl, name: 'qoder-cn' }),
    trae: traeClaimer({ bizHost: env.UGW_TRAE_BIZ_HOST || TRAE_BIZ_HOST }),
    workbuddy: wbClaimer({ name: 'workbuddy' }),
    'workbuddy-cn': wbClaimer({ name: 'workbuddy-cn' }),
    // STS 只有 ~2h：领取前必须走 token 管理器刷新（池 credsOf 会刷新 + 落盘 + 回写运行态），
    // 否则定时补领/面板手动领取在空闲 >2h 后必然 401。池缺失时回退直读账号上的凭证。
    codearts: caClaimer({
      snapBase: env.UGW_CA_SNAP_BASE || CA_SNAP_BASE,
      credsOf: (acc) =>
        codeartsPool?.credsOf?.(acc) ??
        Promise.resolve({
          accessKeyID: acc.accessKeyID,
          secretAccessKey: acc.secretAccessKey,
          securityToken: acc.securityToken,
        }),
    }),
  };
  const claimScheduler = createClaimScheduler({
    pools,
    claimers,
    settingsFile,
    dataDir,
    log,
  });

  // 面板面（M6a）：认证 + API + 静态挂载。admin.json 未设置时登录返回 503 引导跑 admin-passwd。
  const usage = createUsageRecorder({
    dataDir,
    maxFileBytes: config.maxUsageFileBytes,
  });
  const panel = createPanelGateway({
    config,
    pools,
    db,
    keysFile,
    dataDir,
    usage,
    secureCookie: env.UGW_SECURE_COOKIE === '1',
    traeApiHost: env.UGW_TRAE_API_HOST,
    zcodeOrigin: config.zcodeOrigin,
    claimers,
    claimScheduler,
  });

  const server = createGateway({ config, pools, db, panel, usage });

  if (poolSettings.autoClaimEnabled || poolSettings.weekendGrabEnabled) {
    claimScheduler.start();
  }

  return {
    server,
    config,
    db,
    keysFile,
    dataDir,
    usage,
    panel,
    claimers,
    claimScheduler,
    zcode,
    qoder: pools.find((p) => p.name === 'qoder') ?? null,
    qoderCn: pools.find((p) => p.name === 'qoder-cn') ?? null,
    trae: pools.find((p) => p.name === 'trae') ?? null,
    workbuddy: pools.find((p) => p.name === 'workbuddy') ?? null,
    workbuddyCn: pools.find((p) => p.name === 'workbuddy-cn') ?? null,
    codearts: pools.find((p) => p.name === 'codearts') ?? null,
    poolSettings,
  };
}
