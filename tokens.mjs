/** Anthropic 请求里的文本量 → 粗略 token 估算（chars / 3.2，与 v3 §9.1 一致）。 */
export function collectText(body = {}) {
  const parts = [];
  if (typeof body.system === 'string') parts.push(body.system);
  else if (Array.isArray(body.system)) parts.push(body.system.map((b) => b?.text ?? '').join(''));

  for (const msg of Array.isArray(body.messages) ? body.messages : []) {
    if (typeof msg?.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (typeof block?.text === 'string') parts.push(block.text);
        else if (block?.content) parts.push(JSON.stringify(block.content));
      }
    }
  }

  if (Array.isArray(body.tools)) parts.push(JSON.stringify(body.tools));
  return parts.join('\n');
}

export function estimateTokens(body) {
  const text = collectText(body);
  return Math.max(1, Math.ceil(text.length / 3.2));
}
