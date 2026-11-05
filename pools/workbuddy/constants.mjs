// 移植自 vendor/wb-whl/codebuddy_proxy/backend_profile.py:106-127（MIT © Mayer）：
// DOMESTIC_PROFILE / GLOBAL_PROFILE 两套 region 配置。WorkBuddy 与 CodeBuddy 共用
// 同一插件协议，差异只在 OAuth start 的 platform 参数（PROTOCOL.md §94-98：
// 仅 platform=workbuddy 替换 platform=ide，其余完全相同）。

export const ENDPOINT_CN = 'https://copilot.tencent.com';
export const ENDPOINT_GLOBAL = 'https://www.codebuddy.ai';

export const AUTH_PREFIX = '/plugin';
export const CHAT_PATH = '/v2/chat/completions';
export const ENTERPRISE_MODELS_PATH = '/console/enterprises/{enterpriseId}/config/models';

// 登录链路（codebuddy_client_demo.py:334-407 的 _auth_path('/auth/state') 等）。
export const EP_AUTH_STATE = '/v2/plugin/auth/state';
export const EP_AUTH_TOKEN = '/v2/plugin/auth/token';
export const EP_LOGIN_ACCOUNT = '/v2/plugin/login/account';
export const EP_TOKEN_REFRESH = '/v2/plugin/auth/token/refresh';
export const EP_V3_CONFIG = '/v3/config';
// 签到（PROTOCOL.md §72，仅 cn 有签到；global 无签到接口）。
export const EP_CHECKIN_STATUS = '/v2/billing/meter/checkin-activity-status';
// 计费面（余额/积分包查询、每日签到、试用领取）。CodeBuddy 计费域名与对话域名分离。
export const EP_USER_RESOURCE = '/v2/billing/meter/get-user-resource';
export const EP_DAILY_CHECKIN = '/v2/billing/meter/daily-checkin';
export const EP_TRIAL_CLAIM = '/billing/ide/trial';
export const BILLING_ENDPOINT_CN = 'https://www.codebuddy.cn';
export const BILLING_ENDPOINT_GLOBAL = 'https://www.workbuddy.ai';

// IDE 头常量（codebuddy_client_demo.py:260-292 auth_headers 逐项值）。
export const BASE_UA = 'Mozilla/5.0 (compatible; Genie-IDE/1.0)';
export const IDE_TYPE = 'vscode';
export const IDE_NAME = 'Visual Studio Code';
export const IDE_VERSION = '1.70.2';
export const PRODUCT_VERSION = '4.10.33259736';
export const PRODUCT_CODE = 'codebuddy';

// 模型发现 UA（PROTOCOL.md §105-106：/v3/config UA 敏感，CLI UA 会得到削减表）。
export const DISCOVERY_UA = 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0';

// 模型发现失败时的静态降级表（models_config.domestic.json / global.json 抄录，verified=false）。
export const FALLBACK_MODELS = {
  cn: [
    { id: 'auto', display_name: 'Auto' },
    { id: 'glm-5.2', display_name: 'GLM-5.2', context_window: 168000, max_tokens: 32000 },
    { id: 'deepseek-v4-pro', display_name: 'DeepSeek V4 Pro' },
    { id: 'kimi-k3-1', display_name: 'Kimi K3.1' },
  ],
  global: [
    { id: 'claude-4.0', display_name: 'Claude 4.0' },
    { id: 'gpt-5', display_name: 'GPT-5' },
    { id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro' },
  ],
};

// /v3/config 三 realm 基座（PROTOCOL.md §106：三 realm 各自 {upstreamBase}/v3/config，
// X-Domain 带对应 realm 域名）。realm 集合不随 region 变化。
export const REALM_BASES = ['https://copilot.tencent.com', 'https://www.codebuddy.cn', 'https://www.codebuddy.ai'];

export const REGION_KEYS = { cn: 'cn', global: 'global' };

export function endpointFor(region) {
  if (region === 'cn') return ENDPOINT_CN;
  if (region === 'global') return ENDPOINT_GLOBAL;
  throw new Error(`未知 WorkBuddy region: ${region}`);
}

export function poolNameFor(region) {
  return region === 'cn' ? 'workbuddy-cn' : 'workbuddy';
}
