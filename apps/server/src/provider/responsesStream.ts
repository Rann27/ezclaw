import type { FinishReason, StreamEvent, Usage } from "@ezclaw/core";
import { ProviderError } from "./http.js";
import { readSse } from "./sse.js";

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseUsage(u: Json): Usage {
  const usage: Usage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    reasoningTokens: num(rec(u.output_tokens_details)?.reasoning_tokens),
    cachedTokens: num(rec(u.input_tokens_details)?.cached_tokens),
  };
  return Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) as Usage;
}

function failureMessage(response: Json | null, fallback: string): string {
  const err = rec(response?.error);
  return str(err?.message) ?? str(rec(response?.incomplete_details)?.reason) ?? fallback;
}

/** Turns an OpenAI Responses API SSE stream (OpenAI, DeepSeek, xAI) into canonical stream events. */
export async function* parseResponsesStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  let sawReasoningText = false;
  let sawSummary = false;
  const doneItems = new Map<number, Json>();
  const argBuffers = new Map<string, string>();
  let completedOutput: Json[] | null = null;
  let status: "completed" | "incomplete" | null = null;
  let incompleteReason: string | undefined;
  let usage: Usage | null = null;

  for await (const message of readSse(body)) {
    const data = message.data.trim();
    if (!data || data === "[DONE]") continue;
    let ev: Json | null;
    try {
      ev = rec(JSON.parse(data));
    } catch {
      continue;
    }
    if (!ev) continue;
    const type = str(ev.type) ?? message.event ?? "";

    switch (type) {
      case "response.output_text.delta": {
        const delta = str(ev.delta);
        if (delta) yield { type: "text", delta };
        break;
      }
      case "response.reasoning_text.delta": {
        const delta = str(ev.delta);
        if (delta && !sawSummary) {
          sawReasoningText = true;
          yield { type: "reasoning", delta };
        }
        break;
      }
      case "response.reasoning_summary_text.delta": {
        const delta = str(ev.delta);
        if (delta && !sawReasoningText) {
          sawSummary = true;
          yield { type: "reasoning", delta };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const id = str(ev.item_id) ?? String(num(ev.output_index) ?? 0);
        argBuffers.set(id, (argBuffers.get(id) ?? "") + (str(ev.delta) ?? ""));
        break;
      }
      case "response.output_item.done": {
        const item = rec(ev.item);
        if (item) doneItems.set(num(ev.output_index) ?? doneItems.size, item);
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = rec(ev.response);
        status = type === "response.completed" ? "completed" : "incomplete";
        incompleteReason = str(rec(response?.incomplete_details)?.reason);
        if (Array.isArray(response?.output)) completedOutput = (response.output as unknown[]).filter((i): i is Json => rec(i) !== null);
        const u = rec(response?.usage);
        if (u) usage = parseUsage(u);
        break;
      }
      case "response.failed": {
        const msg = failureMessage(rec(ev.response), "Provider melaporkan request gagal.");
        throw new ProviderError(msg, { raw: msg, code: str(rec(rec(ev.response)?.error)?.code) ?? null });
      }
      case "error": {
        const err = rec(ev.error) ?? ev;
        const msg = str(err.message) ?? "Provider mengirim error di tengah stream.";
        throw new ProviderError(msg, { raw: msg, code: str(err.code) ?? null });
      }
      default:
        break;
    }
  }

  if (!status && !doneItems.size) {
    throw new ProviderError("Stream berakhir tanpa respons lengkap dari provider.");
  }

  const output = completedOutput ?? [...doneItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  let sawCall = false;
  for (const item of output) {
    if (item.type !== "function_call") continue;
    sawCall = true;
    const callId = str(item.call_id) ?? str(item.id) ?? `call_${Math.random().toString(36).slice(2, 8)}`;
    const argsText = str(item.arguments) || argBuffers.get(str(item.id) ?? "") || "{}";
    yield { type: "tool_call", callId, name: str(item.name) ?? "", argsText };
  }

  if (output.length) yield { type: "raw", raw: { protocol: "openai-responses", data: output } };
  if (usage) yield { type: "usage", usage };

  const reason: FinishReason = sawCall ? "tool_calls" : status === "incomplete" ? (incompleteReason === "content_filter" ? "content_filter" : "length") : "stop";
  yield { type: "finish", reason };
}
