import { describe, expect, it } from "vitest";
import { buildChatRequest, protocolDefaults, renderSegments, splitWrapperText, toAnthropicMessages, toOpenAIChatMessages, toResponsesInput, type CanonicalMessage, type HarnessSegment } from "./index.js";

const vars = { date: "2026-10-16", os: "Windows", shell: "PowerShell", workspace: "F:\\w", approval: "ask", model: "m" };
const seg = (id: string, content: string, extra: Partial<HarnessSegment> = {}): HarnessSegment => ({ id, title: id, purpose: "", enabled: true, content, dynamic: false, placement: "system", ...extra });

describe("renderSegments", () => {
  it("keeps stable segments in order and moves dynamic ones out, skipping disabled ones", () => {
    const out = renderSegments([seg("env", "Date: {{date}}", { dynamic: true }), seg("a", "A"), seg("off", "X", { enabled: false }), seg("b", "B in {{workspace}}")], "plain", vars);
    expect(out.stable).toBe("A\n\nB in F:\\w");
    expect(out.dynamic).toBe("Date: 2026-10-16");
  });

  it("wraps each segment in a tag named after its title", () => {
    const out = renderSegments([seg("x", "Hi", { title: "Communication style" })], "tags", vars);
    expect(out.stable).toBe("<communication_style>\nHi\n</communication_style>");
  });
});

describe("splitWrapperText", () => {
  it("rebuilds a Markdown wrapper exactly from its segments", () => {
    const text = "Intro line.\n\n# One\nbody 1\n\n# Two\nbody 2";
    const { wrap, segments } = splitWrapperText(text);
    expect(wrap).toBe("plain");
    expect(renderSegments(segments, wrap, vars).stable).toBe(text);
  });

  it("splits on ## when there is no repeated # heading", () => {
    expect(splitWrapperText("## A\nx\n## B\ny").segments.map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("keeps a single block when there is no structure", () => {
    expect(splitWrapperText("just text").segments).toHaveLength(1);
  });

  it("marks an Environment section as dynamic", () => {
    expect(splitWrapperText("# Rules\nx\n# Environment\ny").segments.find((s) => s.title === "Environment")?.dynamic).toBe(true);
  });
});

describe("images on the wire", () => {
  const img = "data:image/png;base64,AAAA";
  const history: CanonicalMessage[] = [
    { role: "user", parts: [{ type: "text", text: "look" }] },
    { role: "assistant", parts: [{ type: "tool_call", callId: "c1", name: "view_image", args: { path: "p.png" } }] },
    { role: "tool", parts: [{ type: "tool_result", callId: "c1", name: "view_image", output: "attached" }, { type: "image", assetId: "a1", dataUrl: img }] },
  ];

  it("chat completions: tool result first, then the image as a user message", () => {
    const out = toOpenAIChatMessages(history, undefined, { systemRole: "system", reasoningReplay: "never" });
    expect(out.at(-2)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(out.at(-1)).toMatchObject({ role: "user", content: [{ type: "text" }, { type: "image_url", image_url: { url: img } }] });
  });

  it("responses: function_call_output, then an input_image", () => {
    const out = toResponsesInput(history);
    expect(out.at(-1)).toMatchObject({ role: "user", content: [{ type: "input_text" }, { type: "input_image", image_url: img }] });
  });

  it("anthropic: image block after the tool_result in the same turn", () => {
    const out = toAnthropicMessages(history);
    expect(out.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] });
  });

  it("images without data are not sent", () => {
    const out = toOpenAIChatMessages([{ role: "user", parts: [{ type: "text", text: "x" }, { type: "image", assetId: "a" }] }], undefined, { systemRole: "system", reasoningReplay: "never" });
    expect(out).toEqual([{ role: "user", content: "x" }]);
  });
});

describe("prompt caching", () => {
  const messages: CanonicalMessage[] = [{ role: "user", parts: [{ type: "text", text: "hi" }] }];

  it("anthropic marks the system prompt and the newest block", () => {
    const { body } = buildChatRequest({ protocol: "anthropic", modelId: "c", profile: protocolDefaults("anthropic"), params: {}, system: "S", messages });
    expect(body.system).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
    expect((body.messages as { content: { cache_control?: unknown }[] }[]).at(-1)!.content.at(-1)!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("is off by default for OpenAI-compatible models, and turns the system message into parts when on", () => {
    const plain = buildChatRequest({ protocol: "openai-chat", modelId: "m", profile: protocolDefaults("openai-chat"), params: {}, system: "S", messages });
    expect((plain.body.messages as { content: unknown }[])[0]!.content).toBe("S");
    const cached = buildChatRequest({ protocol: "openai-chat", modelId: "anthropic/claude", profile: { ...protocolDefaults("openai-chat"), promptCache: true }, params: {}, system: "S", messages });
    expect((cached.body.messages as { content: unknown }[])[0]!.content).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  });
});
