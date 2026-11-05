/**
 * 容忍任意字节边界的 SSE 增量解析器。
 *
 * 只实现 Qoder / ZCode / tw2api 实际用到的子集：event: / data: / 注释行 / 空行分帧。
 * 不做 id: / retry:（YAGNI）。\r\n、\r、\n 都是合法行尾，\r\n 被切开也认。
 */

export function createSseParser() {
  let buf = '';
  let eventName = null;
  const dataLines = [];
  const out = [];

  function dispatch() {
    if (eventName === null && dataLines.length === 0) return;
    out.push({ event: eventName ?? 'message', data: dataLines.join('\n') });
    eventName = null;
    dataLines.length = 0;
  }

  function processLine(line) {
    if (line === '') return dispatch();
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  function push(text) {
    buf += text;
    for (;;) {
      // 找下一个行尾；结尾孤立的 \r 可能是跨 chunk \r\n 的前半，先扣住。
      let end = -1;
      let termLen = 0;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === '\n') {
          end = i;
          termLen = 1;
          break;
        }
        if (buf[i] === '\r') {
          if (i + 1 < buf.length) {
            end = i;
            termLen = buf[i + 1] === '\n' ? 2 : 1;
            break;
          }
          break;
        }
      }
      if (end === -1) break;
      processLine(buf.slice(0, end));
      buf = buf.slice(end + termLen);
    }
    return out.splice(0);
  }

  function drain() {
    if (buf.endsWith('\r')) {
      processLine(buf.slice(0, -1));
    } else if (buf !== '') {
      processLine(buf);
    }
    buf = '';
    dispatch();
    return out.splice(0);
  }

  function reset() {
    buf = '';
    eventName = null;
    dataLines.length = 0;
    out.length = 0;
  }

  return { push, drain, reset };
}

/** 把字节/字符串异步流变成 {event,data} 事件流。 */
export async function* sseEvents(source) {
  const parser = createSseParser();
  for await (const chunk of source) {
    const events = parser.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    for (const ev of events) yield ev;
  }
  for (const ev of parser.drain()) yield ev;
}
