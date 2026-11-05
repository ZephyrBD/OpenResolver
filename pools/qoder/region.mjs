// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :130-201（MIT）
// global / cn 两套域名。cn 的 centerUrl 没有 scheme 尾斜杠差异，refresh 直接拼。

export const QODER_REGIONS = {
  global: {
    mode: 'global',
    providerID: 'qoder',
    baseUrl: 'https://api3.qoder.sh/',
    openApiUrl: 'https://openapi.qoder.sh',
    centerUrl: 'https://center.qoder.sh',
    userNameFallback: 'Qoder User',
    userEmailFallback: 'user@qoder.com',
  },
  cn: {
    mode: 'cn',
    providerID: 'qoder-cn',
    baseUrl: 'https://gateway.qoder.com.cn/',
    openApiUrl: 'https://openapi.qoder.com.cn',
    centerUrl: 'https://gateway.qoder.com.cn',
    userNameFallback: 'Qoder CN User',
    userEmailFallback: 'user@qoder.com.cn',
  },
};

export function regionConfig(mode) {
  const cfg = QODER_REGIONS[mode];
  if (!cfg) throw new Error(`未知的 Qoder region：${mode}`);
  return cfg;
}

export function chatUrl(mode) {
  // 源码原样照搬：FetchKeys=llm_model_result（不要"修正"成 llm_result）
  return `${regionConfig(mode).baseUrl}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}

export function modelListUrl(mode) {
  return `${regionConfig(mode).baseUrl}algo/api/v2/model/list?Encode=1`;
}

export function exchangeUrl(mode) {
  return `${regionConfig(mode).openApiUrl}/api/v1/jobToken/exchange`;
}

export function userinfoUrl(mode) {
  return `${regionConfig(mode).openApiUrl}/api/v1/userinfo`;
}

export function quotaUrl(mode) {
  return `${regionConfig(mode).openApiUrl}/api/v2/quota/usage`;
}

export function refreshUrl(mode) {
  return `${regionConfig(mode).centerUrl}/algo/api/v3/user/refresh_token`;
}
