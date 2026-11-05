/**
 * 入站 OpenAI Chat Completions → 上游 Anthropic Messages（zcode 池用），
 * 以及反方向：Anthropic message JSON / SSE 流 → OpenAI chat.completion。
 * 流式聚合只产出完整对象；网关侧负责喂 SSE 事件。
 */
import { HttpError } from '../http/errors.mjs';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/**
 * OpenAI content parts → Anthropic 内容块。text 部分直接映射；
 * 其它部分（image_url 等）拒绝：zcode 上游是纯文本面，静默丢图比 400 更危险。
 */
function contentPartsToBlocks(content) {
  const blocks = content.map((part) => {
    if (typeof part === 'string') return { type: 'text', text: part };
    if (part?.type === 'text') return { type: 'text', text: part.text ?? '' };
    return null;
  });
  if (blocks.some((b) => b === null)) {
    throw new HttpError(400, 'messages 里存在暂不支持的内容块（仅支持 text，图片等多模态部分已拒绝）', {
      type: 'invalid_request_error',
    });
  }
  return blocks;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toolChoiceOf(choice) {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    return { type: 'tool', name: choice.function?.name };
  }
  return undefined;
}

/** 入站 OpenAI 请求体 → Anthropic Messages 请求体（不含 model，网关负责路由后的模型名）。 */
export function chatCompletionsToMessages(body) {
  const system = [];
  const messages = [];
  let pendingToolResults = null;

  const flushToolResults = () => {
    if (pendingToolResults) {
      messages.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const msg of body.messages ?? []) {
    if (msg.role === 'system') {
      system.push(textOf(msg.content));
      continue;
    }
    if (msg.role === 'tool') {
      if (!pendingToolResults) pendingToolResults = [];
      pendingToolResults.push({ type: 'tool_result', tool_use_id: msg.tool_call_id, content: textOf(msg.content) });
      continue;
    }
    flushToolResults();
    if (msg.role === 'assistant') {
      const toolCalls = msg.tool_calls ?? [];
      if (!toolCalls.length) {
        const content = msg.content;
        const empty = content == null || content === '' || (Array.isArray(content) && content.length === 0);
        if (empty) continue; // Anthropic 拒绝空 content，直接丢掉这条
        messages.push({
          role: 'assistant',
          content: Array.isArray(content) ? contentPartsToBlocks(content) : content,
        });
        continue;
      }
      const blocks = [];
      const text = textOf(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name,
          input: safeJson(tc.function?.arguments ?? '') ?? {},
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    const content = msg.content;
    const empty = content == null || content === '' || (Array.isArray(content) && content.length === 0);
    if (empty) continue; // Anthropic 拒绝空 content
    messages.push({ role: 'user', content: Array.isArray(content) ? contentPartsToBlocks(content) : content });
  }
  flushToolResults();

  const out = { messages };
  if (system.length) out.system = system;

  const toolChoice = toolChoiceOf(body.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;

  const tools = (body.tools ?? [])
    .filter((t) => t?.type === 'function')
    .map((t) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    }));
  if (tools.length) out.tools = tools;

  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop = Array.isArray(body.stop) ? body.stop : [body.stop];
  out.stream = body.stream === true;
  return out;
}

const STOP_REASON = {
  end_turn: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  stop_sequence: 'stop',
};

/** Anthropic message JSON → OpenAI chat.completion 对象。thinking 块丢弃。 */
export function anthropicToChatCompletion(messageJson, model) {
  const blocks = Array.isArray(messageJson?.content) ? messageJson.content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
  const toolCalls = blocks
    .filter((b) => b?.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));

  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const promptTokens = messageJson?.usage?.input_tokens ?? 0;
  const completionTokens = messageJson?.usage?.output_tokens ?? 0;
  return {
    id: messageJson?.id ?? 'chatcmpl-gateway',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: STOP_REASON[messageJson?.stop_reason] ?? null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

/**
 * 消费 {event,data} 事件流（sse-reader 产出），聚合出完整的 OpenAI chat.completion。
 * 文本与 tool 的 partial_json 按 index 聚合；坏 JSON 的 arguments 保留原始拼接串。
 */
export async function aggregateAnthropicSseToChatCompletion(eventStream, model) {
  let id;
  const blocks = [];
  let stopReason = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const { data } of eventStream) {
    if (data === '[DONE]') break;
    const json = safeJson(data);
    if (!json?.type) continue;

    if (json.type === 'message_start') {
      id = json.message?.id;
      inputTokens = json.message?.usage?.input_tokens ?? inputTokens;
      outputTokens = json.message?.usage?.output_tokens ?? outputTokens;
    } else if (json.type === 'content_block_start') {
      const cb = json.content_block ?? {};
      blocks[json.index] = {
        type: cb.type,
        text: '',
        id: cb.id,
        name: cb.name,
        json: '',
      };
    } else if (json.type === 'content_block_delta') {
      const block = blocks[json.index];
      if (!block) continue;
      if (json.delta?.type === 'text_delta') block.text += json.delta.text ?? '';
      else if (json.delta?.type === 'input_json_delta') block.json += json.delta.partial_json ?? '';
    } else if (json.type === 'message_delta') {
      stopReason = json.delta?.stop_reason ?? stopReason;
      inputTokens = json.usage?.input_tokens ?? inputTokens;
      outputTokens = json.usage?.output_tokens ?? outputTokens;
    }
  }

  const content = blocks.filter(Boolean).map((b) =>
    b.type === 'tool_use'
      ? { type: 'tool_use', id: b.id, name: b.name, input: safeJson(b.json), raw_arguments: b.json }
      : { type: 'text', text: b.text },
  );

  const completion = anthropicToChatCompletion({ id, content, stop_reason: stopReason, usage: { input_tokens: inputTokens, output_tokens: outputTokens } }, model);
  // 坏 JSON 的 tool：input 为 null 时回退原始拼接串，而不是 stringify(null)。
  const finalCalls = completion.choices[0].message.tool_calls;
  if (finalCalls) {
    const toolBlocks = content.filter((b) => b.type === 'tool_use');
    finalCalls.forEach((call, i) => {
      if (toolBlocks[i].input == null) call.function.arguments = toolBlocks[i].raw_arguments;
    });
  }
  return completion;
}
