// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :1648-1679, :1717-1845（MIT）
// 请求体构造。入站 Anthropic Messages 先经 messagesToChatCompletions 转 OpenAI 消息
// （system 已落成首条 role:system —— 与源码"顶层 system 无效、塞进 messages[0]"等价）。

import crypto from 'node:crypto';
import { messagesToChatCompletions } from '../../adapters/anthropic-to-openai.mjs';

export const MAX_OUTPUT_TOKENS = 131072;

function stableHashOf(prefix, ...inputs) {
  const hash = crypto.createHash('sha256');
  hash.update(prefix);
  for (const input of inputs) {
    hash.update('\0');
    hash.update(String(input));
  }
  return hash.digest('hex').slice(0, 16);
}

export const stableHash = stableHashOf;

export function stableChatRecordID(model, messages, tools, maxTokens) {
  const hash = crypto.createHash('sha256');
  hash.update('qoder-record');
  hash.update('\0');
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update('\0');
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update('\0');
      hash.update(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update('\0');
    hash.update(JSON.stringify(tools));
  }
  hash.update('\0');
  hash.update(`mt=${maxTokens}`);
  return hash.digest('hex').slice(0, 16);
}

function lastUserTextOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      const content = messages[i].content;
      return typeof content === 'string' ? content : '';
    }
  }
  return '';
}

/**
 * 构造 Qoder agent_chat_generation 请求体（未编码）。
 * @param {object} body 入站 Anthropic Messages 请求体（model 已剥成上游模型 id）
 * @param {object} modelConfig model/list 缓存里的整块条目，至少含 {key, is_reasoning}
 * @param {object} opts {userID, randomUUID, now}
 */
export function buildChatPayload(body, modelConfig, { userID, randomUUID = crypto.randomUUID, now = Date.now } = {}) {
  if (!modelConfig?.key) throw new Error(`Unknown Qoder model id: ${body?.model}`);
  const qoderModel = modelConfig.key;
  const converted = messagesToChatCompletions(body);
  const messages = converted.messages;
  const tools = converted.tools ?? [];
  const maxTokens = Math.min(body.max_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);

  const stablePart = stableHashOf('qoder-session', userID || 'qoder-user', qoderModel);
  const sessionID = `${stablePart}-${randomUUID()}`;
  const recordID = stableChatRecordID(qoderModel, messages, tools.length ? tools : undefined, maxTokens);
  const lastUserText = lastUserTextOf(messages);

  return {
    request_id: randomUUID(),
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: sessionID,
    stream: true,
    chat_task: 'FREE_INPUT',
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    session_type: 'qodercli',
    agent_id: 'agent_common',
    task_id: 'common',
    code_language: '',
    chat_prompt: '',
    image_urls: null,
    aliyun_user_type: '',
    // 顶层 system Qoder 服务端不读；system 已由 messagesToChatCompletions 塞进 messages[0] role:system
    system: '',
    messages,
    tools,
    parameters: { max_tokens: maxTokens, enable_thinking: false },
    chat_context: {
      chatPrompt: '',
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: qoderModel, is_reasoning: !!modelConfig.is_reasoning },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: modelConfig,
    business: {
      product: 'cli',
      version: '1.0.0',
      type: 'agent',
      stage: 'start',
      id: randomUUID(),
      name: lastUserText.substring(0, 30),
      begin_at: now(),
    },
  };
}
