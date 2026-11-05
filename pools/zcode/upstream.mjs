import { metadataUserId } from '../../fingerprint.mjs';

const SYSTEM_BANNER = (text) => `<pi_system_instructions>\n${text}\n</pi_system_instructions>`;

function systemText(inbound) {
  if (typeof inbound.system === 'string') return inbound.system;
  if (Array.isArray(inbound.system)) {
    return inbound.system
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/**
 * 入站 Anthropic 请求 → ZCode 上游请求体。
 *
 * 关键点：上游对 system 做内容指纹校验，只认客户端官方那份原文。
 * 所以 system 一律换成 profile.system，客户端 system 降级成块塞进首条 user 消息。
 * 入站不写 stream 视为 false（ZCode2api 默认 true 的行为不可预测）。
 */
export function buildUpstreamBody(inbound, profile, acc) {
  const messages = structuredClone(inbound.messages ?? []);
  const clientSystem = systemText(inbound).trim();

  if (clientSystem) {
    const banner = SYSTEM_BANNER(clientSystem);
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      if (typeof firstUser.content === 'string') firstUser.content = `${banner}\n\n${firstUser.content}`;
      else if (Array.isArray(firstUser.content)) firstUser.content.unshift({ type: 'text', text: banner });
      else firstUser.content = banner;
    } else {
      messages.unshift({ role: 'user', content: banner });
    }
  }

  const maxTokens = Number(inbound.max_tokens) || profile.max_tokens || 128000;

  return {
    model: inbound.model,
    max_tokens: Math.min(maxTokens, profile.max_tokens || 128000),
    stream: inbound.stream === true,
    metadata: { user_id: metadataUserId(acc.uid) },
    system: profile.system,
    messages,
    tool_choice: profile.tool_choice ?? { type: 'auto' },
    thinking: profile.thinking ?? { type: 'enabled' },
    output_config: profile.output_config ?? { effort: 'low' },
    ...(Array.isArray(inbound.tools) && inbound.tools.length ? { tools: inbound.tools } : {}),
  };
}
