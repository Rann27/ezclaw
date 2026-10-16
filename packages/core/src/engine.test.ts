import { describe, expect, it } from "vitest";
import type { ProfilePatch } from "./capabilities.js";
import type { ChatParams } from "./chat.js";
import { buildChatRequest, buildParamPanel, findRejectedKey, resolveReasoning } from "./engine.js";
import { protocolDefaults, resolveProfile, type Protocol } from "./profile.js";
import { ThinkTagSplitter } from "./thinkSplitter.js";

const hello = [{ role: "user" as const, parts: [{ type: "text" as const, text: "halo" }] }];

function build(protocol: Protocol, patches: ProfilePatch[], params: ChatParams, omit: string[] = [], system?: string) {
  const { profile } = resolveProfile({ protocol, presets: patches });
  return buildChatRequest({ protocol, modelId: "m", profile, params, messages: hello, omit, system });
}

const deepseek: ProfilePatch = {
  maxTokensField: "max_tokens",
  sampling: { temperature: { min: 0, max: 2, step: 0.05 }, top_p: { min: 0.95, max: 1, step: 0.01 } },
  reasoning: {
    style: "deepseek",
    canDisable: true,
    defaultOn: true,
    efforts: ["low", "high", "max"],
    defaultEffort: "high",
    lockedWhileActive: ["temperature", "presence_penalty", "frequency_penalty"],
    lockReason: "Diabaikan DeepSeek saat thinking aktif.",
  },
};

describe("profile resolution", () => {
  it("later layers win and provenance names the layer that set each field", () => {
    const { profile, provenance } = resolveProfile({
      protocol: "openai-chat",
      discovery: { contextLength: 128000, tools: false },
      presets: [{ tools: true, reasoning: { style: "zai", canDisable: true } }],
      override: { contextLength: 64000 },
    });
    expect(profile.contextLength).toBe(64000);
    expect(profile.tools).toBe(true);
    expect(profile.reasoning.style).toBe("zai");
    expect(profile.reasoning.efforts).toEqual([]);
    expect(provenance).toMatchObject({ contextLength: "override", tools: "preset", "reasoning.style": "preset" });
  });

  it("removes a sampling control when a layer sets it to null, and merges the rest per param", () => {
    const { profile } = resolveProfile({
      protocol: "openai-chat",
      presets: [{ sampling: { top_k: { min: 0, max: 100, step: 1 } } }],
      override: { sampling: { temperature: null } },
    });
    expect(profile.sampling.temperature).toBeUndefined();
    expect(profile.sampling.top_k).toBeDefined();
    expect(profile.sampling.top_p).toBeDefined();
  });

  it("replaces extras with the same key and accumulates notes", () => {
    const extra = (label: string) => ({ key: "k", label, path: "a.b", type: "boolean" as const });
    const { profile } = resolveProfile({
      protocol: "openai-chat",
      presets: [{ extras: [extra("one")], notes: ["a"] }, { extras: [extra("two")], notes: ["b", "a"] }],
    });
    expect(profile.extras).toHaveLength(1);
    expect(profile.extras[0]?.label).toBe("two");
    expect(profile.notes).toEqual(["a", "b"]);
  });

  it("does not mutate the protocol defaults", () => {
    resolveProfile({ protocol: "openai-chat", override: { sampling: { temperature: null } } });
    expect(protocolDefaults("openai-chat").sampling.temperature).toBeDefined();
  });
});

describe("reasoning state", () => {
  const { profile } = resolveProfile({ protocol: "openai-chat", presets: [deepseek] });

  it("sends nothing in default mode but still reports whether the model reasons", () => {
    expect(resolveReasoning(profile, undefined)).toMatchObject({ active: true, send: "nothing" });
  });

  it("refuses to switch off a model that cannot be switched off", () => {
    const fixed = resolveProfile({ protocol: "openai-chat", presets: [{ reasoning: { ...deepseek.reasoning, canDisable: false } }] }).profile;
    const state = resolveReasoning(fixed, { mode: "off" });
    expect(state.send).toBe("nothing");
    expect(state.active).toBe(true);
    expect(state.notes[0]).toContain("tidak bisa dimatikan");
  });

  it("falls back to the default effort when the requested one is unsupported", () => {
    const state = resolveReasoning(profile, { mode: "on", effort: "xhigh" });
    expect(state.effort).toBe("high");
    expect(state.notes[0]).toContain("xhigh");
  });
});

describe("parameter engine: openai-chat", () => {
  it("builds a plain streaming request with usage and the system message first", () => {
    const req = build("openai-chat", [], {}, [], "Jawab singkat.");
    expect(req.path).toBe("/chat/completions");
    expect(req.body).toMatchObject({
      model: "m",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "Jawab singkat." },
        { role: "user", content: "halo" },
      ],
    });
  });

  it("uses the developer role and max_completion_tokens when the profile asks for them", () => {
    const req = build("openai-chat", [{ systemRole: "developer", maxTokensField: "max_completion_tokens" }], { max_output_tokens: 500 }, [], "x");
    expect(req.body.max_completion_tokens).toBe(500);
    expect(req.body).not.toHaveProperty("max_tokens");
    expect((req.body.messages as { role: string }[])[0]?.role).toBe("developer");
  });

  it("drops sampling params the model does not support, with a reason", () => {
    const req = build("openai-chat", [], { top_k: 40, temperature: 0.5 });
    expect(req.body).not.toHaveProperty("top_k");
    expect(req.body.temperature).toBe(0.5);
    expect(req.dropped).toEqual([{ param: "top_k", reason: "Tidak didukung model ini." }]);
  });

  it("clamps out-of-range values and says so", () => {
    const req = build("openai-chat", [], { temperature: 5 });
    expect(req.body.temperature).toBe(2);
    expect(req.notes.some((n) => n.includes("temperature disesuaikan"))).toBe(true);
  });

  it("drops params that the model ignores while reasoning is active (DeepSeek thinking)", () => {
    const req = build("openai-chat", [deepseek], { temperature: 0.2, top_p: 0.97 });
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body.top_p).toBe(0.97);
    expect(req.dropped).toEqual([{ param: "temperature", reason: "Diabaikan DeepSeek saat thinking aktif." }]);
  });

  it("keeps the same param once reasoning is switched off", () => {
    const req = build("openai-chat", [deepseek], { temperature: 0.2, reasoning: { mode: "off" } });
    expect(req.body.temperature).toBe(0.2);
    expect(req.body.thinking).toEqual({ type: "disabled" });
  });

  it.each([
    ["openai-effort", { reasoning: { style: "openai-effort" as const, canDisable: false, efforts: ["low", "medium", "high"] } }, { mode: "on" as const, effort: "high" }, { reasoning_effort: "high" }],
    ["openrouter effort", { reasoning: { style: "openrouter" as const, canDisable: true, efforts: ["low", "high"] } }, { mode: "on" as const, effort: "low" }, { reasoning: { effort: "low" } }],
    ["openrouter budget", { reasoning: { style: "openrouter" as const, canDisable: true, efforts: ["low", "high"], budget: { min: 1024, max: 32000, step: 1 } } }, { mode: "on" as const, budgetTokens: 4000 }, { reasoning: { max_tokens: 4000 } }],
    ["openrouter off", { reasoning: { style: "openrouter" as const, canDisable: true, efforts: ["low"] } }, { mode: "off" as const }, { reasoning: { effort: "none" } }],
    ["deepseek on", deepseek, { mode: "on" as const, effort: "max" }, { thinking: { type: "enabled" }, reasoning_effort: "max" }],
    ["zai off", { reasoning: { style: "zai" as const, canDisable: true } }, { mode: "off" as const }, { thinking: { type: "disabled" } }],
    ["qwen budget", { reasoning: { style: "qwen" as const, canDisable: true, budget: { min: 0, max: 38912, step: 1 } } }, { mode: "on" as const, budgetTokens: 2000 }, { enable_thinking: true, thinking_budget: 2000 }],
    ["qwen off", { reasoning: { style: "qwen" as const, canDisable: true } }, { mode: "off" as const }, { enable_thinking: false }],
    ["venice effort", { reasoning: { style: "venice" as const, canDisable: true, efforts: ["low", "high"] } }, { mode: "on" as const, effort: "high" }, { reasoning_effort: "high" }],
    ["venice off", { reasoning: { style: "venice" as const, canDisable: true } }, { mode: "off" as const }, { venice_parameters: { disable_thinking: true } }],
  ])("maps reasoning for %s", (_name, preset, reasoning, expected) => {
    const req = build("openai-chat", [preset], { reasoning });
    expect(req.body).toMatchObject(expected);
  });

  it("writes provider extras at their dotted path", () => {
    const extra = { key: "web", label: "Web search", path: "venice_parameters.enable_web_search", type: "enum" as const, options: [{ value: "off", label: "Off" }, { value: "on", label: "On" }] };
    const req = build("openai-chat", [{ extras: [extra] }], { extras: { web: "on" } });
    expect(req.body.venice_parameters).toEqual({ enable_web_search: "on" });
  });

  it("merges extra body last, deeply, and refuses to touch managed fields", () => {
    const extra = { key: "web", label: "Web", path: "venice_parameters.enable_web_search", type: "enum" as const };
    const req = build("openai-chat", [{ extras: [extra] }], {
      extras: { web: "on" },
      extraBody: { venice_parameters: { include_venice_system_prompt: false }, model: "hack", provider: { sort: "price" } },
    });
    expect(req.body.venice_parameters).toEqual({ enable_web_search: "on", include_venice_system_prompt: false });
    expect(req.body.provider).toEqual({ sort: "price" });
    expect(req.body.model).toBe("m");
    expect(req.dropped.some((d) => d.param === "model")).toBe(true);
    expect(req.notes.some((n) => n.includes("venice_parameters"))).toBe(true);
  });

  it("omits fields this model rejected before", () => {
    const req = build("openai-chat", [], { temperature: 0.4 }, ["temperature", "stream_options", "model"]);
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("stream_options");
    expect(req.body.model).toBe("m");
    expect(req.dropped.map((d) => d.param)).toEqual(["temperature", "stream_options"]);
  });
});

describe("parameter engine: anthropic", () => {
  const adaptive: ProfilePatch = {
    reasoning: { style: "anthropic-adaptive", canDisable: true, defaultOn: true, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", lockedWhileActive: [] },
    maxOutputTokens: 64000,
  };

  it("sends system at the top level, requires max_tokens, and targets /v1/messages", () => {
    const req = build("anthropic", [], {}, [], "Jawab singkat.");
    expect(req.path).toBe("/v1/messages");
    expect(req.body.system).toEqual([{ type: "text", text: "Jawab singkat.", cache_control: { type: "ephemeral" } }]);
    expect(req.body.max_tokens).toBe(16000);
    expect(req.body).not.toHaveProperty("stream_options");
    expect((req.body.messages as { role: string }[]).every((m) => m.role !== "system")).toBe(true);
  });

  it("asks for summarized thinking by default on models that think by default", () => {
    const req = build("anthropic", [adaptive], {});
    expect(req.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.body).not.toHaveProperty("output_config");
  });

  it("sends nothing about thinking by default on models where thinking is off by default", () => {
    const req = build("anthropic", [{ ...adaptive, reasoning: { ...adaptive.reasoning, defaultOn: false } }], {});
    expect(req.body).not.toHaveProperty("thinking");
  });

  it("maps effort to output_config and off to disabled", () => {
    expect(build("anthropic", [adaptive], { reasoning: { mode: "on", effort: "xhigh" } }).body).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
    expect(build("anthropic", [adaptive], { reasoning: { mode: "off" } }).body.thinking).toEqual({ type: "disabled" });
  });

  it("uses stop_sequences and ignores seed", () => {
    const req = build("anthropic", [], { stop: ["END"], seed: 3 });
    expect(req.body.stop_sequences).toEqual(["END"]);
    expect(req.body).not.toHaveProperty("seed");
    expect(req.dropped.map((d) => d.param)).toContain("seed");
  });

  it("budget thinking must stay under max_tokens and above the minimum", () => {
    const budget: ProfilePatch = { reasoning: { style: "anthropic-budget", canDisable: true, defaultOn: false, efforts: [], budget: { min: 1024, max: 64000, step: 1 }, lockedWhileActive: [] } };
    const ok = build("anthropic", [budget], { max_output_tokens: 16000, reasoning: { mode: "on", budgetTokens: 4000 } });
    expect(ok.body.thinking).toEqual({ type: "enabled", budget_tokens: 4000 });

    const lowered = build("anthropic", [budget], { max_output_tokens: 3000, reasoning: { mode: "on", budgetTokens: 8000 } });
    expect(lowered.body.thinking).toEqual({ type: "enabled", budget_tokens: 2999 });

    const tooSmall = build("anthropic", [budget], { max_output_tokens: 1000, reasoning: { mode: "on" } });
    expect(tooSmall.body).not.toHaveProperty("thinking");
    expect(tooSmall.dropped[0]?.param).toBe("reasoning");
  });
});

describe("parameter panel", () => {
  it("lists only supported sampling controls and locks the ones reasoning ignores", () => {
    const { profile } = resolveProfile({ protocol: "openai-chat", presets: [deepseek] });
    const panel = buildParamPanel(profile, {});
    expect(panel.sampling.map((s) => s.param)).toEqual(["temperature", "top_p", "frequency_penalty", "presence_penalty"]);
    const byParam = Object.fromEntries(panel.sampling.map((s) => [s.param, s]));
    expect(byParam.temperature).toMatchObject({ locked: true, lockReason: "Diabaikan DeepSeek saat thinking aktif." });
    expect(byParam.presence_penalty?.locked).toBe(true);
    expect(byParam.top_p?.locked).toBe(false);

    const off = buildParamPanel(profile, { reasoning: { mode: "off" } });
    expect(off.sampling.every((c) => !c.locked)).toBe(true);
    expect(off.reasoning.active).toBe(false);
  });
});

describe("rejected parameter detection", () => {
  const bodyKeys = ["model", "messages", "stream", "stream_options", "temperature", "top_p", "reasoning_effort", "thinking", "stop"];

  it.each([
    ["Unsupported parameter: 'temperature' is not supported with this model.", null, "temperature"],
    ["Unrecognized request argument supplied: top_p", null, "top_p"],
    ["temperature: Extra inputs are not permitted", null, "temperature"],
    ["Invalid value for `reasoning_effort`: expected one of low, high", null, "reasoning_effort"],
    ["something went wrong", "stream_options.include_usage", "stream_options"],
    ["Unknown field \"thinking.type\"", null, "thinking"],
  ])("finds the blamed field in %j", (message, param, expected) => {
    expect(findRejectedKey({ message, param, bodyKeys })).toBe(expected);
  });

  it("does not blame protected or absent fields, nor ordinary words", () => {
    expect(findRejectedKey({ message: "Invalid 'model': not found", bodyKeys })).toBeNull();
    expect(findRejectedKey({ message: "Please stop sending requests so fast", bodyKeys })).toBeNull();
    expect(findRejectedKey({ message: "Unsupported parameter: 'seed'", bodyKeys })).toBeNull();
  });
});

describe("think tag splitter", () => {
  function run(chunks: string[]) {
    const s = new ThinkTagSplitter();
    const out = chunks.flatMap((c) => s.push(c)).concat(s.flush());
    const join = (kind: string) => out.filter((c) => c.kind === kind).map((c) => c.delta).join("");
    return { text: join("text"), reasoning: join("reasoning") };
  }

  it("separates reasoning from text", () => {
    expect(run(["<think>mikir</think>jawaban"])).toEqual({ text: "jawaban", reasoning: "mikir" });
  });

  it("handles tags cut across chunks at every position", () => {
    const full = "a<think>bc</think>de";
    for (let i = 1; i < full.length; i++) {
      expect(run([full.slice(0, i), full.slice(i)])).toEqual({ text: "ade", reasoning: "bc" });
    }
  });

  it("does not swallow a lone angle bracket", () => {
    expect(run(["x < y and <b>bold</b>"])).toEqual({ text: "x < y and <b>bold</b>", reasoning: "" });
  });

  it("flushes a held-back partial tag when the stream ends", () => {
    expect(run(["hasil <thi"])).toEqual({ text: "hasil <thi", reasoning: "" });
  });
});
