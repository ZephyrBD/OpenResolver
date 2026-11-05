// 常量：CodeArts Agent 云端 API（vendor/codearts2api/internal/upstream/const.go 全量抄录，MIT © HITZY2002）。

// SnapEngineApiHost 盘古引擎/聊天网关（snap-access，product.json snapEngineDomain）。
export const SNAP_ENGINE_API_HOST = 'https://snap-access.cn-north-4.myhuaweicloud.com';
// SnapManagerHost 登录/令牌服务（snap-manager）。
export const SNAP_MANAGER_HOST = `${SNAP_ENGINE_API_HOST}/snap-manager`;
// PortalHost 华为云 CodeArts 门户（OAuth authorize 入口，注意带 /portal）。
export const PORTAL_HOST = 'https://codearts.huaweicloud.com/portal';
// STSHost 临时 AK/SK。
export const STS_HOST = 'https://sts.cn-north-4.myhuaweicloud.com';

// CLIENT_ID OAuth client（官方 CodeArts Agent 插件的 uri_scheme）。
// refresh_token 与该值绑定：换 client_id 刷新会被 STS 拒。
export const CLIENT_ID = 'codearts-agent';

// 聊天端点（chatDomain 商业版 = snap-access.cn-north-4，v2 已是 OpenAI 兼容形状）。
export const EP_CHAT_V2 = '/api/v2/chat/completions';
export const EP_AGENT_LIST = '/v1/agent-center/agents/useragents';
export const EP_AGENT_DETAIL = '/v1/agent-center/agents/detail';
// 内置模型（Agent-Type: PromptCenter）。
export const EP_MODEL_BUILTIN = '/v1/model/builtin';

// 限时福利（免费套餐）网关：模型发现 + 领取（opengw.developer 域）。
export const BENEFIT_HOST = 'https://opengw.developer.huaweicloud.com';
export const EP_BENEFIT_CONFIG = '/api/v1/gateway/config';
export const EP_BENEFIT_CLAIM = '/api/v1/benefit/claim';

// 登录/令牌。
export const EP_LOGIN_TICKET = '/v1/login/ticket';
export const EP_OAUTH_TOKENS = '/v1/oauth2/tokens';

// DefaultLoginConfig（client.go:93-103，逆向自 huaweicloud.authentication 扩展）。
export const PLUGIN_NAME = 'snap_AIIDE';
export const PLUGIN_VERSION = '5.2.0';
export const REDIRECT_PATH = '/oauth/callback';

// 福利路由头（models.go:34-38）：福利模型聊天必须带，否则 InferHub.002002009.404。
export const HEADER_MAAS_TYPE = 'maas_type';
export const MAAS_BENEFIT = 'benefit';

// 签到/积分（checkin.go:14-19）。
export const EP_CREDIT_DELIVERY = '/v1/ops/delivery';
export const EP_CREDIT_CLAIM = '/v1/ops/claim';
export const EP_CREDIT_CONFIRM = '/v1/ops/confirm';
export const CREDIT_CHANNEL = 'IDE';
