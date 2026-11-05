import { HttpError } from './errors.mjs';

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 读取请求体，超过上限立刻 413。 */
export async function readBody(req, limit = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw new HttpError(413, `请求体超过上限 ${limit} 字节`, { type: 'invalid_request_error' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON 对象', { type: 'invalid_request_error' });
  }
}
