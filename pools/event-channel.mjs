import { sseEvents } from '../adapters/sse-reader.mjs';

/**
 * 上游本身是 Anthropic SSE 的池（zcode）：把响应体逐帧解析成事件对象塞进通道。
 * [DONE] 帧忽略（Anthropic 上游不发，防御性处理）；非 JSON data 跳过。
 */
export function sseBodyChannel(bodyStream) {
  const channel = createEventChannel();
  (async () => {
    try {
      for await (const { data } of sseEvents(bodyStream)) {
        if (data === '[DONE]') break;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json?.type) channel.push([json]);
      }
      channel.end();
    } catch (err) {
      channel.fail(err);
    }
  })();
  return channel;
}

/**
 * push → async-iterator 桥：sendStream 用。
 * 池内在 SSE 消费回调里批量 push Anthropic 事件，网关侧 for-await 逐个消费；
 * 流内错误通过 fail() 抛进迭代器，正常收尾调 end()。
 */
export function createEventChannel() {
  const queue = [];
  let wake = null;
  let failure = null;
  let closed = false;

  const signal = () => {
    const r = wake;
    wake = null;
    r?.();
  };

  return {
    push(events) {
      if (closed || !events?.length) return;
      queue.push(...events);
      signal();
    },
    fail(err) {
      if (closed) return;
      failure = err;
      signal();
    },
    end() {
      if (closed) return;
      closed = true;
      signal();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield* queue.splice(0);
          continue;
        }
        if (failure) throw failure;
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
