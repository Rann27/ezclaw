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

type ImagePart = Extract<Part, { type: "image" }>;

/** Images whose bytes were filled in for this request. Images without data are not sent. */
function imagesOf(parts: Part[]): (ImagePart & { dataUrl: string })[] {
  return parts.filter((p): p is ImagePart & { dataUrl: string } => p.type === "image" && typeof p.dataUrl === "string");
}

function splitDataUrl(url: string): { mediaType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { mediaType: m[1]!, data: m[2]! } : { mediaType: "image/png", data: "" };
}

const TOOL_IMAGES_NOTE = "Gambar yang dilampirkan tool pada langkah sebelumnya:";

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
    if (m.role === "developer") {
      out.push(m);
      continue;
    }
    out.push(m);
    if (m.role !== "assistant") continue;

    const calls = callsOf(m.parts);
    if (!calls.length) continue;

    const answered = new Map<string, ToolResultPart>();
    const images: Part[] = [];
    let j = i + 1;
    while (messages[j]?.role === "tool") {
      for (const r of resultsOf(messages[j]!.parts)) answered.set(r.callId, r);
      images.push(...messages[j]!.parts.filter((p) => p.type === "image"));
      j++;
    }
    const results: ToolResultPart[] = calls.map(
      (c) => answered.get(c.callId) ?? { type: "tool_result", callId: c.callId, name: c.name, output: INTERRUPTED, isError: true },
    );
    out.push({ role: "tool", parts: [...results, ...images] });
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
    if (m.role === "developer") {
      out.push({ role: opts.systemRole, content: textOf(m.parts) });
    } else if (m.role === "user") {
      const content = textOf(m.parts);
      const images = imagesOf(m.parts);
      if (images.length) out.push({ role: "user", content: [...(content ? [{ type: "text", text: content }] : []), ...images.map((i) => ({ type: "image_url", image_url: { url: i.dataUrl } }))] });
      else if (content) out.push({ role: "user", content });
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
      // Tool messages cannot carry images in Chat Completions, so they follow as a user message.
      const images = imagesOf(m.parts);
      if (images.length) out.push({ role: "user", content: [{ type: "text", text: TOOL_IMAGES_NOTE }, ...images.map((i) => ({ type: "image_url", image_url: { url: i.dataUrl } }))] });
    }
  }
  return out;
}

/* -------------------------------------------------------------------- responses */

export function toResponsesInput(messages: CanonicalMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const m of normalizeToolPairs(messages)) {
    if (m.role === "developer") {
      out.push({ role: "developer", content: textOf(m.parts) });
    } else if (m.role === "user") {
      const content = textOf(m.parts);
      const images = imagesOf(m.parts);
      if (images.length) out.push({ role: "user", content: [...(content ? [{ type: "input_text", text: content }] : []), ...images.map((i) => ({ type: "input_image", image_url: i.dataUrl }))] });
      else if (content) out.push({ role: "user", content });
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
      const images = imagesOf(m.parts);
      if (images.length) out.push({ role: "user", content: [{ type: "input_text", text: TOOL_IMAGES_NOTE }, ...images.map((i) => ({ type: "input_image", image_url: i.dataUrl }))] });
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
    // Anthropic has no developer role; buildChatRequest moves those into the system prompt.
    if (m.role === "developer") continue;
    if (m.role === "user") {
      const text = textOf(m.parts);
      const blocks: unknown[] = imagesOf(m.parts).map((i) => {
        const { mediaType, data } = splitDataUrl(i.dataUrl);
        return { type: "image", source: { type: "base64", media_type: mediaType, data } };
      });
      if (text) blocks.push({ type: "text", text });
      if (blocks.length) push("user", blocks);
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
        [
          ...resultsOf(m.parts).map((r) => ({ type: "tool_result", tool_use_id: r.callId, content: r.output, ...(r.isError ? { is_error: true } : {}) })),
          // Images follow the tool results in the same user turn.
          ...imagesOf(m.parts).map((i) => {
            const { mediaType, data } = splitDataUrl(i.dataUrl);
            return { type: "image", source: { type: "base64", media_type: mediaType, data } };
          }),
        ],
      );
    }
  }
  return out;
}
