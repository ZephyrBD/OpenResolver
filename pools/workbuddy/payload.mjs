// 入站 Anthropic Messages → WB OpenAI Chat Completions 请求体。
// 移植自 vendor/wb-whl/codebuddy_proxy/codebuddy_client_demo.py stream_chat（:449-482）：
// 请求体就是标准 OpenAI Chat Completions 形状（model/messages/temperature/max_tokens/stream），
// 无特殊字段 → 直接复用 M2 的 messagesToChatCompletions 转换器，本模块只做 WB 特有薄层：
// model 直传、stream:true 固定（上游统一以 SSE 返回，非流式由网关聚合）、采样参数透传。

import { messagesToChatCompletions } from '../../adapters/anthropic-to-openai.mjs';

export function buildWbPayload(body, model) {
  const payload = messagesToChatCompletions(body);
  payload.model = model;
  payload.stream = true;
  return payload;
}
