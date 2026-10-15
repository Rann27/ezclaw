import type { FinishReason, StreamEvent, Usage } from "@ezclaw/core";
import { ProviderError } from "./http.js";
import { readSse } from "./sse.js";

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mapStop(reason: unknown): FinishReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}

interface Block {
  type: string;
  text: string;
  signature: string;
  id: string;
  name: string;
  json: string;
  /** For blocks that arrive complete (redacted_thinking and similar). */
  original: Json;
}

/**
 * Turns an Anthropic Messages SSE stream into canonical stream events. The content blocks are
 * also kept in Anthropic's own shape, because thinking blocks must be sent back with their
 * signatures when tools are used.
 */
export async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  let inputTokens: number | undefined;
  let cachedTokens: number | undefined;
  let finished = false;
  let finishReason: FinishReason = "other";
  const blocks = new Map<number, Block>();

  for await (const message of readSse(body)) {
    const data = message.data.trim();
    if (!data) continue;
    let event: Json | null;
    try {
      event = rec(JSON.parse(data));
    } catch {
      continue;
    }
    if (!event) continue;

    switch (event.type) {
      case "message_start": {
        const usage = rec(rec(event.message)?.usage);
        inputTokens = num(usage?.input_tokens);
        cachedTokens = num(usage?.cache_read_input_tokens);
        break;
      }
      case "content_block_start": {
        const index = num(event.index) ?? blocks.size;
        const cb = rec(event.content_block) ?? {};
        blocks.set(index, {
          type: typeof cb.type === "string" ? cb.type : "text",
          text: "",
          signature: "",
          id: typeof cb.id === "string" ? cb.id : "",
          name: typeof cb.name === "string" ? cb.name : "",
          json: "",
          original: cb,
        });
        break;
      }
      case "content_block_delta": {
        const block = blocks.get(num(event.index) ?? -1);
        const delta = rec(event.delta);
        if (!block || !delta) break;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
          block.text += delta.text;
          yield { type: "text", delta: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
          block.text += delta.thinking;
          if (delta.thinking) yield { type: "reasoning", delta: delta.thinking };
        } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
          block.signature += delta.signature;
          yield { type: "reasoning_signature", signature: delta.signature };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          block.json += delta.partial_json;
        }
        break;
      }
      case "content_block_stop": {
        const block = blocks.get(num(event.index) ?? -1);
        if (block?.type === "tool_use") {
          yield { type: "tool_call", callId: block.id, name: block.name, argsText: block.json || "{}" };
        }
        break;
      }
      case "message_delta": {
        const usage = rec(event.usage);
        const out: Usage = {};
        if (inputTokens !== undefined) out.inputTokens = inputTokens;
        if (cachedTokens !== undefined) out.cachedTokens = cachedTokens;
        const outputTokens = num(usage?.output_tokens);
        if (outputTokens !== undefined) out.outputTokens = outputTokens;
        const thinking = num(rec(usage?.output_tokens_details)?.thinking_tokens);
        if (thinking !== undefined) out.reasoningTokens = thinking;
        if (Object.keys(out).length) yield { type: "usage", usage: out };
        const stop = rec(event.delta)?.stop_reason;
        if (stop) {
          finished = true;
          finishReason = mapStop(stop);
        }
        break;
      }
      case "error": {
        const err = rec(event.error);
        const msg = typeof err?.message === "string" ? err.message : "Provider mengirim error di tengah stream.";
        throw new ProviderError(msg, { raw: msg, code: typeof err?.type === "string" ? err.type : null });
      }
      default:
        // message_stop and ping carry nothing we need.
        break;
    }
  }

  const content: Json[] = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]): Json | null => {
      switch (b.type) {
        case "text":
          return b.text ? { type: "text", text: b.text } : null;
        case "thinking":
          return { type: "thinking", thinking: b.text, signature: b.signature };
        case "tool_use": {
          let input: unknown = {};
          try {
            input = JSON.parse(b.json || "{}");
          } catch {
            input = {};
          }
          return { type: "tool_use", id: b.id, name: b.name, input };
        }
        default:
          // redacted_thinking and anything new: sent back exactly as it arrived.
          return b.original;
      }
    })
    .filter((b): b is Json => b !== null);

  if (content.length) yield { type: "raw", raw: { protocol: "anthropic", data: content } };
  if (!finished) finishReason = [...blocks.values()].some((b) => b.type === "tool_use") ? "tool_calls" : "other";
  yield { type: "finish", reason: finishReason };
}
