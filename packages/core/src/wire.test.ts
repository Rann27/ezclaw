import { describe, expect, it } from "vitest";
import type { ToolDef } from "./agent.js";
import type { CanonicalMessage } from "./chat.js";
import { buildChatRequest } from "./engine.js";
import { protocolDefaults } from "./profile.js";
import { normalizeToolPairs, toAnthropicMessages, toOpenAIChatMessages, toResponsesInput } from "./wire.js";

const user = (text: string): CanonicalMessage => ({ role: "user", parts: [{ type: "text", text }] });
const readFile: ToolDef = { name: "read_file", description: "Baca file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

const toolTurn: CanonicalMessage[] = [
  user("baca a.txt"),
  { role: "assistant", parts: [{ type: "text", text: "Baik." }, { type: "tool_call", callId: "c1", name: "read_file", args: { path: "a.txt" } }] },
  { role: "tool", parts: [{ type: "tool_result", callId: "c1", name: "read_file", output: "isi a" }] },
  { role: "assistant", parts: [{ type: "text", text: "Isinya: isi a" }] },
];

describe("tool pair repair", () => {
  it("adds a result for a call that never got one, and drops a result with no call", () => {
    const broken: CanonicalMessage[] = [
      user("x"),
      { role: "assistant", parts: [{ type: "tool_call", callId: "c1", name: "shell", args: {} }] },
      user("lanjut"),
      { role: "tool", parts: [{ type: "tool_result", callId: "ghost", name: "shell", output: "?" }] },
    ];
    const fixed = normalizeToolPairs(broken);
    expect(fixed.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(fixed[2]?.parts[0]).toMatchObject({ callId: "c1", isError: true });
  });

  it("keeps a complete pair untouched, with every call answered in the same tool message", () => {
    const two: CanonicalMessage[] = [
      { role: "assistant", parts: [{ type: "tool_call", callId: "a", name: "n", args: {} }, { type: "tool_call", callId: "b", name: "n", args: {} }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "b", name: "n", output: "B" }, { type: "tool_result", callId: "a", name: "n", output: "A" }] },
    ];
    const fixed = normalizeToolPairs(two);
    expect(fixed).toHaveLength(2);
    expect(fixed[1]?.parts.map((p) => (p as { callId: string }).callId)).toEqual(["a", "b"]);
  });
});

describe("openai chat wire", () => {
  const opts = { systemRole: "system" as const, reasoningReplay: "never" as const };

  it("turns a tool turn into assistant tool_calls and tool messages", () => {
    const wire = toOpenAIChatMessages(toolTurn, "Sistem.", opts);
    expect(wire).toEqual([
      { role: "system", content: "Sistem." },
      { role: "user", content: "baca a.txt" },
      { role: "assistant", content: "Baik.", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "isi a" },
      { role: "assistant", content: "Isinya: isi a" },
    ]);
  });

  const withRaw: CanonicalMessage[] = [
    user("hai"),
    { role: "assistant", parts: [{ type: "text", text: "halo" }], raw: { protocol: "openai-chat", data: { role: "assistant", content: "halo", reasoning_content: "mikir" } } },
  ];

  it("replays the provider's own message, keeping reasoning_content only when the model needs it back", () => {
    expect(toOpenAIChatMessages(withRaw, undefined, { ...opts, reasoningReplay: "with-tools" })[1]).toMatchObject({ reasoning_content: "mikir" });
    expect(toOpenAIChatMessages(withRaw, undefined, opts)[1]).toEqual({ role: "assistant", content: "halo" });
  });

  it("does not replay a turn produced under another protocol", () => {
    const foreign: CanonicalMessage[] = [{ role: "assistant", parts: [{ type: "text", text: "halo" }], raw: { protocol: "anthropic", data: [{ type: "thinking" }] } }];
    expect(toOpenAIChatMessages(foreign, undefined, opts)).toEqual([{ role: "assistant", content: "halo" }]);
  });
});

describe("responses wire", () => {
  it("emits function_call and function_call_output items", () => {
    expect(toResponsesInput(toolTurn)).toEqual([
      { role: "user", content: "baca a.txt" },
      { role: "assistant", content: "Baik." },
      { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "c1", output: "isi a" },
      { role: "assistant", content: "Isinya: isi a" },
    ]);
  });

  it("replays the provider's output items verbatim, reasoning included", () => {
    const items = [{ type: "reasoning", id: "rs_1", encrypted_content: "xyz" }, { type: "function_call", call_id: "c9", name: "n", arguments: "{}" }];
    const msgs: CanonicalMessage[] = [
      { role: "assistant", parts: [{ type: "tool_call", callId: "c9", name: "n", args: {} }], raw: { protocol: "openai-responses", data: items } },
      { role: "tool", parts: [{ type: "tool_result", callId: "c9", name: "n", output: "ok" }] },
    ];
    expect(toResponsesInput(msgs)).toEqual([...items, { type: "function_call_output", call_id: "c9", output: "ok" }]);
  });
});

describe("anthropic wire", () => {
  it("sends tool_use blocks and returns results in one user message", () => {
    expect(toAnthropicMessages(toolTurn)).toEqual([
      { role: "user", content: [{ type: "text", text: "baca a.txt" }] },
      { role: "assistant", content: [{ type: "text", text: "Baik." }, { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "isi a" }] },
      { role: "assistant", content: [{ type: "text", text: "Isinya: isi a" }] },
    ]);
  });

  it("merges tool results with the next user message so roles keep alternating", () => {
    const wire = toAnthropicMessages([...toolTurn, user("lagi")]);
    expect(wire.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    const afterTools = toAnthropicMessages([toolTurn[0]!, toolTurn[1]!, toolTurn[2]!, user("lagi")]);
    expect(afterTools.at(-1)?.content).toEqual([{ type: "tool_result", tool_use_id: "c1", content: "isi a" }, { type: "text", text: "lagi" }]);
  });

  it("replays thinking blocks with their signatures unchanged", () => {
    const blocks = [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "halo" }];
    const wire = toAnthropicMessages([user("hai"), { role: "assistant", parts: [{ type: "text", text: "halo" }], raw: { protocol: "anthropic", data: blocks } }]);
    expect(wire[1]).toEqual({ role: "assistant", content: blocks });
  });

  it("marks failed tool results as errors", () => {
    const wire = toAnthropicMessages([
      { role: "assistant", parts: [{ type: "tool_call", callId: "c", name: "n", args: {} }] },
      { role: "tool", parts: [{ type: "tool_result", callId: "c", name: "n", output: "gagal", isError: true }] },
    ]);
    expect(wire[1]?.content).toEqual([{ type: "tool_result", tool_use_id: "c", content: "gagal", is_error: true }]);
  });
});

describe("requests with tools", () => {
  const params = {};

  it("openai chat: function tools and tool_choice", () => {
    const profile = protocolDefaults("openai-chat");
    const req = buildChatRequest({ protocol: "openai-chat", modelId: "m", profile, params, messages: toolTurn, tools: [readFile], toolChoice: "auto" });
    expect(req.body.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Baca file", parameters: readFile.parameters } }]);
    expect(req.body.tool_choice).toBe("auto");
    expect(req.path).toBe("/chat/completions");
  });

  it("responses: flat tools, instructions, input items, max_output_tokens, no stop or seed", () => {
    const profile = protocolDefaults("openai-responses");
    const req = buildChatRequest({
      protocol: "openai-responses",
      modelId: "m",
      profile,
      params: { max_output_tokens: 900, stop: ["x"], seed: 1, top_k: 5, temperature: 0.5 },
      system: "Sistem.",
      messages: toolTurn,
      tools: [readFile],
    });
    expect(req.path).toBe("/responses");
    expect(req.body).toMatchObject({ instructions: "Sistem.", max_output_tokens: 900, temperature: 0.5, store: false, stream: true });
    expect(req.body.tools).toEqual([{ type: "function", name: "read_file", description: "Baca file", parameters: readFile.parameters }]);
    expect(Array.isArray(req.body.input)).toBe(true);
    expect(req.body).not.toHaveProperty("messages");
    expect(req.body).not.toHaveProperty("stop");
    expect(req.body).not.toHaveProperty("seed");
    expect(req.dropped.map((d) => d.param).sort()).toEqual(["seed", "stop", "top_k"]);
  });

  it("responses: one reasoning object, whatever the provider calls its switch", () => {
    const deepseek = { ...protocolDefaults("openai-responses"), reasoning: { style: "deepseek" as const, canDisable: true, defaultOn: true, efforts: ["low", "high", "max"], lockedWhileActive: [] } };
    const on = buildChatRequest({ protocol: "openai-responses", modelId: "m", profile: deepseek, params: { reasoning: { mode: "on", effort: "max" } }, messages: [user("x")] });
    expect(on.body.reasoning).toEqual({ effort: "max" });
    expect(on.body).not.toHaveProperty("thinking");
    const off = buildChatRequest({ protocol: "openai-responses", modelId: "m", profile: deepseek, params: { reasoning: { mode: "off" } }, messages: [user("x")] });
    expect(off.body.reasoning).toEqual({ effort: "none" });

    const openai = { ...protocolDefaults("openai-responses"), reasoning: { style: "openai-effort" as const, canDisable: false, defaultOn: true, efforts: ["low", "high"], lockedWhileActive: [] } };
    expect(buildChatRequest({ protocol: "openai-responses", modelId: "m", profile: openai, params: { reasoning: { mode: "on", effort: "high" } }, messages: [user("x")] }).body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(buildChatRequest({ protocol: "openai-responses", modelId: "m", profile: openai, params: {}, messages: [user("x")] }).body.reasoning).toEqual({ summary: "auto" });
  });

  it("anthropic: input_schema, and tool_choice any for required", () => {
    const profile = protocolDefaults("anthropic");
    const req = buildChatRequest({ protocol: "anthropic", modelId: "m", profile, params, messages: toolTurn, tools: [readFile], toolChoice: "required" });
    expect(req.body.tools).toEqual([{ name: "read_file", description: "Baca file", input_schema: readFile.parameters }]);
    expect(req.body.tool_choice).toEqual({ type: "any" });
  });

  it("sends no tools field when there are none", () => {
    const req = buildChatRequest({ protocol: "openai-chat", modelId: "m", profile: protocolDefaults("openai-chat"), params, messages: [user("x")], tools: [] });
    expect(req.body).not.toHaveProperty("tools");
  });
});
