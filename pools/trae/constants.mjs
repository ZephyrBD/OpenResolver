// 移植自 vendor/cpa-trae/trae/upstream/constants.go（MIT，mmqz/cpa-multi-plugins）。
// SOLO 上游技术常量（实测抓包值，禁止改动）。版本码决定上游返回哪张模型表：
// 20260820 → 36 模型含 glm-5.3（v0.12.49 实测）。

export const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
export const IDE_VERSION = '0.1.61';
export const IDE_VERSION_CODE = '20260820';
export const DEVICE_BRAND = '83DG';
export const OS_VERSION = 'Windows 11 Pro';
export const CLIENT_UA = `Trae/${IDE_VERSION}`;

// SOLO stable 谱系 OAuth client（vendor PROTOCOL.md §199；与 trae-cn 的
// ono9krqynydwx5 不同，跨谱系换发会被 ug/pay 族 401 code=1001 拒绝）。
export const CLIENT_ID = 'en1oxy7wnw8j9n';

// llm_utils_chat 从 v0.12.79 起只接受 solo_work_lite（issue #9，其余 4001）。
export const FUNCTION = 'solo_work_lite';

// 端点（vendor/cpa-trae/trae/upstream/constants.go:26-37）。
export const EP_CHAT = '/api/agent/v3/llm_utils_chat';
export const EP_EXCHANGE = '/cloudide/api/v3/trae/oauth/ExchangeToken';
export const EP_USER_INFO = '/cloudide/api/v3/trae/GetUserInfo';
export const EP_ENT_USAGE = '/trae/api/v2/pay/ide_user_ent_usage';
export const EP_CHECKIN_STATUS = '/trae/api/v2/ug/checkin_credits/status';
export const EP_CHECKIN_CLAIM = '/trae/api/v2/ug/checkin_credits/claim';

// 宿主：chat/biz 默认官方对应域名；mchost.guru 是社区反代（UGW_TRAE_CHAT_HOST 可选备用）；
// oauth（ExchangeToken/GetUserInfo）在 .com.cn。默认模型 glm-5.2（vendor payload.go:267 实测可用）。
// 2026-11-05 真机实测：官方 api.trae.cn 对 llm_utils_chat 返回 404，社区反代 mchost.guru 可用
// （vendor 默认同此）。官方域名保留为 UGW_TRAE_CHAT_HOST 可选项。
export const DEFAULT_CHAT_HOST = 'https://trae-api-cn.mchost.guru';
export const DEFAULT_BIZ_HOST = 'https://api.trae.cn';
export const DEFAULT_API_HOST = 'https://api.trae.com.cn';
export const DEFAULT_MODEL = 'glm-5.2';
