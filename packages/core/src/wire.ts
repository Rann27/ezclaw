import type { ReasoningReplay } from "./capabilities.js";
import type { CanonicalMessage, Part } from "./chat.js";

export type WireMessage = Record<string, unknown>;

type ToolCallPart = Extract<Part, { type: "tool_call" }>;
type ToolResultPart = Extract<Part, { type: "tool_result" }>;

const INTERRUPTED = "Pemanggilan tool ini tidak selesai (dihentikan atau terputus), jadi tidak ada hasilnya.";

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function callsOf(parts: Part[]): ToolCallPart[] {
  return parts.filter((p): p is ToolCallPart => p.type === "tool_call");
}

function resultsOf(parts: Part[]): ToolResultPart[] {
  return parts.filter((p): p is ToolResultPart => p.type === "tool_result");
}

function argsJson(call: ToolCallPart): string {
  return JSON.stringify(call.args ?? {});
}

/**
 * Providers reject a transcript where a tool call has no result, or a result has no call.
 * An interrupted run can leave either, so the history is repaired before it is sent.
 */
export function normalizeToolPairs(messages: CanonicalMessage[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") continue; // results are re-attached after their assistant message below
    out.push(m);
    if (m.role !== "assistant") continue;

    const calls = callsOf(m.parts);
    if (!calls.length) continue;

    const answered = new Map<string, ToolResultPart>();
    let j = i + 1;
    while (messages[j]?.role === "tool") {
      for (const r of resultsOf(messages[j]!.parts)) answered.set(r.callId, r);
      j++;
    }
    const results: ToolResultPart[] = calls.map(
      (c) => answered.get(c.callId) ?? { type: "tool_result", callId: c.callId, name: c.name, output: INTERRUPTED, isError: true },
    );
    out.push({ role: "tool", parts: results });
  }
  return out;
}

/* ------------------------------------------------------------------ openai chat */

function stripChatReasoning(message: WireMessage): WireMessage {
  const { reasoning_content: _a, reasoning: _b, reasoning_details: _c, ...rest } = message;
  return rest;
}

export function toOpenAIChatMessages(
  messages: CanonicalMessage[],
  system: string | undefined,
  opts: { systemRole: "system" | "developer"; reasoningReplay: ReasoningReplay },
): WireMessage[] {
  const out: WireMessage[] = [];
  if (system) out.push({ role: opts.systemRole, content: system });

  for (const m of normalizeToolPairs(messages)) {
    if (m.role === "user") {
      const content = textOf(m.parts);
      if (content) out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.raw?.protocol === "openai-chat" && typeof m.raw.data === "object" && m.raw.data) {
        const raw = m.raw.data as WireMessage;
        out.push(opts.reasoningReplay === "never" ? stripChatReasoning(raw) : raw);
        continue;
      }
      const content = textOf(m.parts);
      const calls = callsOf(m.parts);
      if (!content && !calls.length) continue;
      const msg: WireMessage = { role: "assistant", content: content || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({ id: c.callId, type: "function", function: { name: c.name, arguments: argsJson(c) } }));
      }
      out.push(msg);
    } else {
      for (const r of resultsOf(m.parts)) out.push({ role: "tool", tool_call_id: r.callId, content: r.output });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- responses */

export function toResponsesInput(messages: CanonicalMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of normalizeToolPairs(messages)) {
    if (m.role === "user") {
      const content = textOf(m.parts);
      if (content) out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.raw?.protocol === "openai-responses" && Array.isArray(m.raw.data)) {
        out.push(...(m.raw.data as WireMessage[]));
        continue;
      }
      const content = textOf(m.parts);
      if (content) out.push({ role: "assistant", content });
      for (const c of callsOf(m.parts)) out.push({ type: "function_call", call_id: c.callId, name: c.name, arguments: argsJson(c) });
    } else {
      for (const r of resultsOf(m.parts)) out.push({ type: "function_call_output", call_id: r.callId, output: r.output });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- anthropic */

export function toAnthropicMessages(messages: CanonicalMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: "user" | "assistant", content: unknown[]) => {
    const last = out.at(-1);
    // Anthropic wants strict alternation, so neighbours with the same role are merged.
    if (last && last.role === role && Array.isArray(last.content)) (last.content as unknown[]).push(...content);
    else out.push({ role, content });
  };

  for (const m of normalizeToolPairs(messages)) {
    if (m.role === "user") {
      const text = textOf(m.parts);
      if (text) push("user", [{ type: "text", text }]);
    } else if (m.role === "assistant") {
      if (m.raw?.protocol === "anthropic" && Array.isArray(m.raw.data)) {
        push("assistant", m.raw.data as unknown[]);
        continue;
      }
      const blocks: unknown[] = [];
      const text = textOf(m.parts);
      if (text) blocks.push({ type: "text", text });
      for (const c of callsOf(m.parts)) blocks.push({ type: "tool_use", id: c.callId, name: c.name, input: c.args ?? {} });
      if (blocks.length) push("assistant", blocks);
    } else {
      push(
        "user",
        resultsOf(m.parts).map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.output, ...(r.isError ? { is_error: true } : {}) })),
      );
    }
  }
  return out;
}
