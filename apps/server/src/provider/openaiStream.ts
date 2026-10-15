import { ThinkTagSplitter, type FinishReason, type StreamEvent, type Usage } from "@ezclaw/core";
import { ProviderError } from "./http.js";
import { readSse } from "./sse.js";

type Json = Record<string, unknown>;

function rec(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mapFinish(reason: unknown): FinishReason {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

function parseUsage(u: Json): Usage {
  const usage: Usage = {
    inputTokens: num(u.prompt_tokens) ?? num(u.input_tokens),
    outputTokens: num(u.completion_tokens) ?? num(u.output_tokens),
    reasoningTokens: num(rec(u.completion_tokens_details)?.reasoning_tokens) ?? num(rec(u.output_tokens_details)?.reasoning_tokens),
    cachedTokens: num(rec(u.prompt_tokens_details)?.cached_tokens),
    costUsd: num(u.cost),
  };
  return Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined)) as Usage;
}

export interface OpenAIStreamOptions {
  /** Separate inline <think> tags from the answer (local servers, unknown gateways). */
  parseThinkTags: boolean;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/**
 * Turns an OpenAI Chat Completions SSE stream into canonical stream events. Besides the live
 * deltas it assembles the assistant message exactly as sent, so it can be replayed later.
 */
export async function* parseOpenAIStream(body: ReadableStream<Uint8Array>, opts: OpenAIStreamOptions): AsyncGenerator<StreamEvent> {
  const splitter = opts.parseThinkTags ? new ThinkTagSplitter() : null;
  let sawStructuredReasoning = false;
  let finished = false;
  let finishReason: FinishReason = "other";

  const text: string[] = [];
  const reasoning: string[] = [];
  let reasoningField: "reasoning_content" | "reasoning" = "reasoning_content";
  const reasoningDetails: Json[] = [];
  const calls = new Map<number, PendingCall>();

  for await (const message of readSse(body)) {
    const data = message.data.trim();
    if (!data) continue;
    if (data === "[DONE]") break;

    let chunk: Json | null;
    try {
      chunk = rec(JSON.parse(data));
    } catch {
      continue;
    }
    if (!chunk) continue;

    // Some gateways report a failure as a data chunk after the stream has started.
    const err = rec(chunk.error);
    if (err) {
      const msg = typeof err.message === "string" ? err.message : "Provider mengirim error di tengah stream.";
      throw new ProviderError(msg, { raw: msg, code: typeof err.code === "string" ? err.code : null });
    }

    const usage = rec(chunk.usage);
    if (usage) yield { type: "usage", usage: parseUsage(usage) };

    const choice = rec((chunk.choices as unknown[] | undefined)?.[0]);
    if (!choice) continue;
    const delta = rec(choice.delta);

    if (delta) {
      const structured =
        typeof delta.reasoning_content === "string" ? ("reasoning_content" as const) : typeof delta.reasoning === "string" ? ("reasoning" as const) : null;
      if (structured) {
        const piece = delta[structured] as string;
        if (piece) {
          sawStructuredReasoning = true;
          reasoningField = structured;
          reasoning.push(piece);
          yield { type: "reasoning", delta: piece };
        }
      }
      if (Array.isArray(delta.reasoning_details)) {
        for (const d of delta.reasoning_details) if (rec(d)) reasoningDetails.push(d as Json);
      }

      const content = typeof delta.content === "string" ? delta.content : "";
      if (content) {
        if (splitter && !sawStructuredReasoning) {
          for (const piece of splitter.push(content)) {
            if (piece.kind === "text") text.push(piece.delta);
            yield { type: piece.kind, delta: piece.delta };
          }
        } else {
          text.push(content);
          yield { type: "text", delta: content };
        }
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const raw of delta.tool_calls) {
          const tc = rec(raw);
          if (!tc) continue;
          const index = num(tc.index) ?? 0;
          const fn = rec(tc.function);
          const pending = calls.get(index) ?? { id: "", name: "", args: "" };
          if (typeof tc.id === "string" && tc.id) pending.id = tc.id;
          if (typeof fn?.name === "string") pending.name += fn.name;
          if (typeof fn?.arguments === "string") pending.args += fn.arguments;
          calls.set(index, pending);
        }
      }
    }

    if (choice.finish_reason) {
      finished = true;
      finishReason = mapFinish(choice.finish_reason);
    }
  }

  if (splitter) {
    for (const piece of splitter.flush()) {
      if (piece.kind === "text") text.push(piece.delta);
      yield { type: piece.kind, delta: piece.delta };
    }
  }

  const ordered = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c], i) => ({ ...c, id: c.id || `call_${i + 1}` }));
  for (const c of ordered) yield { type: "tool_call", callId: c.id, name: c.name, argsText: c.args || "{}" };

  if (ordered.length || text.length || reasoning.length) {
    const message: Json = { role: "assistant", content: text.join("") || null };
    if (reasoning.length) message[reasoningField] = reasoning.join("");
    if (reasoningDetails.length) message.reasoning_details = reasoningDetails;
    if (ordered.length) {
      message.tool_calls = ordered.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    }
    yield { type: "raw", raw: { protocol: "openai-chat", data: message } };
  }

  if (!finished && ordered.length) finishReason = "tool_calls";
  yield { type: "finish", reason: ordered.length && finishReason === "stop" ? "tool_calls" : finishReason };
}
