import { createParser } from "eventsource-parser";

export interface SseMessage {
  event: string | undefined;
  data: string;
}

/** Yields server-sent events from a response body as they arrive. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const queue: SseMessage[] = [];
  const parser = createParser({
    onEvent(e) {
      queue.push({ event: e.event, data: e.data });
    },
  });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift()!;
    }
    parser.feed(decoder.decode());
    while (queue.length) yield queue.shift()!;
  } finally {
    reader.releaseLock();
  }
}
