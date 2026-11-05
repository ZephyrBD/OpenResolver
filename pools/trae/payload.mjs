// 入站 Anthropic Messages → SOLO llm_utils_chat 请求体。
// 移植自 vendor/cpa-trae/trae/upstream/payload.go（MIT）：白名单透传（v0.12.37）、
// tools/tool_choice 归一化（normalizeTools/normalizeToolChoice）、max_tokens 缺省 1M
// （v0.12.48，防上游把长输出截在 128k）。developer→system 归一同源（payload.go:57-63）。
//
// 与源码的差异：源码输入是 OpenAI messages；这里入口是 Anthropic（网关契约，
// 与 qoder buildChatPayload 同位）。tool_use 块 → tool_calls[].function_call
//（vendor 把 OpenAI 的 function 改名为上游的 function_call，payload.go:66-99）。

import { FUNCTION } from './constants.mjs';

const SAMPLE_KEYS = ['temperature', 'top_p', 'max_tokens', 'presence_penalty', 'frequency_penalty', 'seed', 'n'];

function textBlocks(text) {
  return [{ type: 'text', text }];
}

function contentToBlocks(content) {
  if (content == null) return null;
  if (typeof content === 'string') return textBlocks(content);
  if (Array.isArray(content)) {
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => ({ type: 'text', text: b.text }));
  }
  return null;
}

function toolResultMessages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b?.type === 'tool_result')
    .map((b) => ({
      role: 'tool',
      tool_call_id: b.tool_use_id,
      content: contentToBlocks(b.content ?? '') ?? textBlocks(''),
    }));
}

/** Anthropic assistant 消息 → OpenAI 形 assistant + tool_calls[].function_call（payload.go:66-99）。 */
function assistantMessage(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const text = blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const calls = blocks
    .filter((b) => b?.type === 'tool_use' && b.name)
    .map((b) => ({
      id: b.id,
      type: 'function',
      // 上游 Go struct 要求 FunctionCall.Name 必填；function → function_call 重命名
      function_call: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  const out = { role: 'assistant' };
  if (text) out.content = textBlocks(text);
  if (calls.length) out.tool_calls = calls;
  return out;
}

/** normalizeToolChoice（payload.go:274-317）+ Anthropic tool_choice 形状。 */
function normalizeToolChoice(out, toolChoice) {
  const suppress = () => {
    delete out.tools;
    delete out.tool_choice;
  };
  if (toolChoice == null) return;
  if (typeof toolChoice === 'string') {
    const v = toolChoice.trim().toLowerCase();
    if (v === 'none') return suppress();
    if (v === 'auto' || v === 'required') out.tool_choice = v;
    else delete out.tool_choice;
    return;
  }
  if (typeof toolChoice !== 'object') return void delete out.tool_choice;
  const type = String(toolChoice.type ?? '').trim().toLowerCase();
  switch (type) {
    case 'none':
      suppress();
      return;
    case 'auto':
      out.tool_choice = 'auto';
      return;
    case 'any':
    case 'required':
      out.tool_choice = 'required';
      return;
    case 'tool':
    case 'function': {
      const name = String(toolChoice.name ?? toolChoice.function?.name ?? '').trim();
      out.tool_choice = name || 'auto';
      return;
    }
    default:
      delete out.tool_choice;
  }
}

/** normalizeTools（payload.go:323-356）：Anthropic {name,description,input_schema} → SOLO 条目，parameters 是 JSON 字符串。 */
function normalizeTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const list = tools
    .filter((t) => t && typeof t === 'object' && typeof t.name === 'string' && t.name)
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description != null ? { description: t.description } : {}),
        ...(t.input_schema != null ? { parameters: JSON.stringify(t.input_schema) } : {}),
      },
    }));
  return list.length ? list : undefined;
}

/**
 * 构造 SOLO 上游 body。白名单之外一律丢弃：上游无原生 thinking 参数，
 * agent 字段触发流内 4023 "model is unknown"（payload.go:183-191 注释）。
 */
export function buildTraePayload(body, model) {
  const messages = [];
  const toolCallIds = new Set();
  const systemText =
    typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system
            .filter((b) => typeof b === 'string' || b?.type === 'text')
            .map((b) => (typeof b === 'string' ? b : b.text ?? ''))
            .join('')
        : '';
  if (systemText) messages.push({ role: 'system', content: textBlocks(systemText) });

  for (const msg of body.messages ?? []) {
    if (msg?.role === 'assistant') {
      const converted = assistantMessage(msg);
      for (const call of converted.tool_calls ?? []) toolCallIds.add(call.id);
      // v0.12.50：全被剔且无正文的 assistant 占位整条剔除（payload.go:88-98 同款）
      if (converted.content || converted.tool_calls) messages.push(converted);
      continue;
    }
    if (msg?.role === 'user') {
      // 悬空 tool 消息（tool_use_id 不在前文 assistant.tool_calls）导致上游空流
      //（vendor payload.go:116-166，v0.12.50）：孤儿 tool_result 剔除
      for (const toolMsg of toolResultMessages(msg.content)) {
        if (toolCallIds.has(toolMsg.tool_call_id)) messages.push(toolMsg);
      }
      const blocks = contentToBlocks(msg.content);
      if (blocks && blocks.length) messages.push({ role: 'user', content: blocks });
      continue;
    }
    const blocks = contentToBlocks(msg?.content);
    if (blocks) messages.push({ role: msg?.role === 'developer' ? 'system' : msg?.role, content: blocks });
  }

  const out = { messages, function: FUNCTION, stream: true, config_name: model, model };
  const tools = normalizeTools(body.tools);
  if (tools) out.tools = tools;
  normalizeToolChoice(out, body.tool_choice);

  for (const k of SAMPLE_KEYS) {
    if (typeof body[k] === 'number' && Number.isFinite(body[k])) out[k] = body[k];
  }
  // vendor v0.12.48：客户端没带 max_tokens 就补大上限，长回复不再被上游腰斩
  if (!('max_tokens' in out)) out.max_tokens = 1_000_000;
  const stop = body.stop ?? body.stop_sequences;
  if (typeof stop === 'string' || Array.isArray(stop)) out.stop = stop;
  return out;
}
