import { buildChatRequest, resolveProfile, type ChatParams } from "@ezclaw/core";
import { describe, expect, it } from "vitest";
import { ENDPOINT_PRESETS, getEndpointPreset, profileFamily } from "./catalog.js";
import { DiscoveryParseError, listPath, parseModelList } from "./discovery.js";
import { PRESET_FILES, matchPresets } from "./presets.js";

const hello = [{ role: "user" as const, parts: [{ type: "text" as const, text: "halo" }] }];

function request(opts: {
  presetId: string;
  modelId: string;
  discovery?: ReturnType<typeof parseModelList>[number]["patch"];
  params?: ChatParams;
}) {
  const preset = getEndpointPreset(opts.presetId);
  const protocol = preset?.protocol ?? "openai-chat";
  const matched = matchPresets(profileFamily(opts.presetId), opts.modelId);
  const { profile } = resolveProfile({
    protocol,
    fallbackPresets: matched.fallback,
    discovery: opts.discovery,
    presets: matched.corrections,
  });
  return buildChatRequest({ protocol, modelId: opts.modelId, profile, params: opts.params ?? {}, messages: hello });
}

describe("catalog", () => {
  it("has unique ids and covers every provider and gateway the PRD lists", () => {
    const ids = ENDPOINT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ["openai", "anthropic", "google", "xai", "qwen", "zai", "deepseek", "minimax", "mimo", "openrouter", "venice"]) {
      expect(ids).toContain(id);
    }
  });

  it("gives every preset with a key an auth scheme, and header auth a header name", () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(p.needsKey).toBe(p.auth.type !== "none");
      if (p.auth.type === "header") expect(p.auth.headerName).toBeTruthy();
      expect(() => new URL(p.baseUrl)).not.toThrow();
    }
  });

  it("uses header auth for Anthropic and Xiaomi MiMo, as their docs require", () => {
    expect(getEndpointPreset("anthropic")?.auth).toEqual({ type: "header", headerName: "x-api-key" });
    expect(getEndpointPreset("mimo")?.auth).toEqual({ type: "header", headerName: "api-key" });
  });

  it("maps every local runtime to one family", () => {
    expect(["ollama", "lmstudio", "llamacpp", "vllm"].map(profileFamily)).toEqual(["local", "local", "local", "local"]);
    expect(profileFamily("custom")).toBe("custom");
  });
});

describe("preset files", () => {
  it("record where each rule came from and when it was checked", () => {
    for (const file of PRESET_FILES) {
      expect(file.source.length).toBeGreaterThan(0);
      expect(file.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("only match the family they are written for", () => {
    const deepseek = matchPresets("deepseek", "deepseek-flash");
    expect(deepseek.corrections.length).toBeGreaterThan(0);
    expect(matchPresets("openai", "deepseek-flash").corrections).toEqual([]);
    expect(matchPresets("custom", "deepseek-flash")).toEqual({ fallback: [], corrections: [] });
  });
});

describe("discovery parsers", () => {
  it("OpenRouter: reads modalities, parameters, context, and reasoning support", () => {
    const models = parseModelList("openrouter", {
      data: [
        {
          id: "anthropic/claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          context_length: 1000000,
          architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
          pricing: { prompt: "0.000003", completion: "0.000015" },
          top_provider: { max_completion_tokens: 64000 },
          supported_parameters: ["temperature", "top_p", "top_k", "tools", "stop", "reasoning", "max_tokens"],
          default_parameters: { temperature: 1, top_p: null },
        },
        {
          id: "vendor/image-model",
          name: "Image Model",
          architecture: { input_modalities: ["text"], output_modalities: ["image"] },
          supported_parameters: [],
        },
      ],
    });
    expect(models).toHaveLength(2);
    const claude = models[0]!;
    expect(claude.kind).toBe("text");
    expect(claude.patch).toMatchObject({
      inputModalities: ["text", "image", "file"],
      contextLength: 1000000,
      maxOutputTokens: 64000,
      tools: true,
      stop: true,
      seed: false,
      reasoning: { style: "openrouter", canDisable: true, budget: { min: 1024 } },
    });
    expect(claude.patch.sampling?.temperature).toEqual({ min: 0, max: 2, step: 0.05, default: 1 });
    expect(claude.patch.sampling?.top_k).toBeTruthy();
    expect(claude.patch.sampling?.frequency_penalty).toBeNull();
    expect(claude.meta.pricing).toMatchObject({ prompt: "0.000003" });
    expect(models[1]?.kind).toBe("image");
  });

  it("Venice: separates text and image models, skips other types, reads capabilities", () => {
    const models = parseModelList("venice", {
      data: [
        {
          id: "venice-text",
          type: "text",
          model_spec: {
            name: "Venice Text",
            availableContextTokens: 131072,
            maxCompletionTokens: 8192,
            capabilities: { supportsFunctionCalling: true, supportsVision: true, supportsReasoning: true, supportsReasoningEffort: true },
            constraints: { temperature: { default: 0.8 }, top_p: { default: 0.9 } },
          },
        },
        { id: "venice-image", type: "image", model_spec: { name: "Venice Image", constraints: { aspectRatios: ["1:1"] } } },
        { id: "venice-tts", type: "tts", model_spec: { name: "TTS" } },
      ],
    });
    expect(models.map((m) => [m.modelId, m.kind])).toEqual([
      ["venice-text", "text"],
      ["venice-image", "image"],
    ]);
    expect(models[0]?.patch).toMatchObject({
      contextLength: 131072,
      tools: true,
      inputModalities: ["text", "image"],
      reasoning: { style: "venice", efforts: ["low", "medium", "high"] },
    });
    expect(models[0]?.patch.sampling?.temperature).toMatchObject({ default: 0.8 });
    expect(models[1]?.meta.constraints).toMatchObject({ aspectRatios: ["1:1"] });
  });

  it("Venice: inpaint models are edit-only image models, image models take no input image", () => {
    const [edit, gen] = parseModelList("venice", {
      data: [
        { id: "qwen-image-2-edit", type: "inpaint", model_spec: { name: "Qwen Edit", constraints: { aspectRatios: ["auto", "1:1"], promptCharacterLimit: 2000, combineImages: false } } },
        { id: "flux-2", type: "image", model_spec: { name: "Flux 2", constraints: { resolutions: ["1K", "2K"], steps: { default: 20, max: 40 }, promptCharacterLimit: 2000, widthHeightDivisor: 16 } } },
      ],
    });
    expect(edit).toMatchObject({ kind: "image", patch: { inputModalities: ["text", "image"], image: { editOnly: true, maxInputImages: 1, aspectRatios: ["auto", "1:1"], resolutions: [] } } });
    expect(gen).toMatchObject({ kind: "image", patch: { image: { maxInputImages: 0, resolutions: ["1K", "2K"], steps: { max: 40, default: 20 } } } });
  });

  it("plain lists: image models are recognised by name", () => {
    const ms = parseModelList("openai", { data: ["gpt-5.5", "gpt-image-2", "dall-e-3", "grok-imagine-image", "gemini-3-flash-image-preview", "text-embedding-3", "qwen-image-edit"].map((id) => ({ id })) });
    expect(ms.filter((m) => m.kind === "image").map((m) => m.modelId)).toEqual(["gpt-image-2", "dall-e-3", "grok-imagine-image", "gemini-3-flash-image-preview", "qwen-image-edit"]);
  });

  it("Venice: input image limits for multi-edit and style references", () => {
    const [combine, listed, single, styled] = parseModelList("venice", {
      data: [
        { id: "a-edit", type: "inpaint", model_spec: { constraints: { aspectRatios: ["auto"], promptCharacterLimit: 1, combineImages: true } } },
        { id: "b-edit", type: "inpaint", model_spec: { constraints: { aspectRatios: ["auto"], promptCharacterLimit: 1, combineImages: true, maxInputImages: 10 } } },
        { id: "c-edit", type: "inpaint", model_spec: { constraints: { aspectRatios: ["auto"], promptCharacterLimit: 1, combineImages: false } } },
        { id: "krea", type: "image", model_spec: { constraints: { promptCharacterLimit: 1, steps: { default: 1, max: 2 }, widthHeightDivisor: 16, maxStyleReferences: 3 } } },
      ],
    });
    expect([combine, listed, single, styled].map((m) => m!.patch.image?.maxInputImages)).toEqual([3, 10, 1, 3]);
  });

  it("list paths ask Venice and OpenRouter for image models too", () => {
    expect(listPath("venice")).toBe("/models?type=all");
    expect(listPath("openrouter")).toBe("/models?output_modalities=text,image");
    expect(listPath("openai")).toBe("/models");
  });

  it("Anthropic: derives the thinking style and effort levels from capabilities", () => {
    const supported = { supported: true };
    const [m] = parseModelList("anthropic", {
      data: [
        {
          id: "claude-opus-5-5",
          display_name: "Claude Opus 5.5",
          max_input_tokens: 1000000,
          max_tokens: 128000,
          capabilities: {
            image_input: supported,
            pdf_input: supported,
            effort: { supported: true, low: supported, medium: supported, high: supported, max: supported, xhigh: supported },
            thinking: { supported: true, types: { adaptive: supported, enabled: supported, disabled: supported } },
          },
        },
      ],
    });
    expect(m?.name).toBe("Claude Opus 5.5");
    expect(m?.patch).toMatchObject({
      inputModalities: ["text", "image", "file"],
      maxOutputTokens: 128000,
      reasoning: { style: "anthropic-adaptive", canDisable: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
    });
  });

  it("Anthropic: a model with only manual thinking gets a budget instead of efforts", () => {
    const supported = { supported: true };
    const [m] = parseModelList("anthropic", {
      data: [{ id: "claude-haiku-4-5", capabilities: { thinking: { supported: true, types: { enabled: supported, disabled: supported, adaptive: { supported: false } } } } }],
    });
    expect(m?.patch.reasoning).toMatchObject({ style: "anthropic-budget", efforts: [], budget: { min: 1024 } });
  });

  it("OpenAI-style lists keep just the id, and strip Gemini's models/ prefix", () => {
    const models = parseModelList("openai", { data: [{ id: "models/gemini-2.5-flash" }, { id: "llama3.2:3b" }, { nope: 1 }] });
    expect(models.map((m) => m.modelId)).toEqual(["gemini-2.5-flash", "llama3.2:3b"]);
  });

  it("throws a readable error when the response is not a model list", () => {
    expect(() => parseModelList("openai", { error: "x" })).toThrow(DiscoveryParseError);
    expect(() => parseModelList("openai", "html")).toThrow(DiscoveryParseError);
  });
});

describe("end to end: model id + provider rules -> wire body", () => {
  it("DeepSeek: thinking on by default, so temperature is dropped; turning it off sends thinking disabled and keeps temperature", () => {
    const on = request({ presetId: "deepseek", modelId: "deepseek-flash", params: { temperature: 0.3 } });
    expect(on.body).not.toHaveProperty("temperature");
    expect(on.dropped[0]?.param).toBe("temperature");

    const off = request({ presetId: "deepseek", modelId: "deepseek-flash", params: { temperature: 0.3, reasoning: { mode: "off" } } });
    expect(off.body).toMatchObject({ temperature: 0.3, thinking: { type: "disabled" } });

    const max = request({ presetId: "deepseek", modelId: "deepseek-flash", params: { reasoning: { mode: "on", effort: "max" } } });
    expect(max.body).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "max" });
  });

  it("OpenAI GPT-6: Responses API, max_output_tokens, one reasoning object, encrypted reasoning kept", () => {
    const req = request({ presetId: "openai", modelId: "gpt-6-luna", params: { max_output_tokens: 2000, reasoning: { mode: "on", effort: "high" } } });
    expect(req.path).toBe("/responses");
    expect(req.body).toMatchObject({ max_output_tokens: 2000, reasoning: { effort: "high", summary: "auto" }, store: false, include: ["reasoning.encrypted_content"] });
    expect(req.body).not.toHaveProperty("max_tokens");
    expect(req.body).not.toHaveProperty("messages");
  });

  it("DeepSeek on the Responses wire (as Codex uses it): the same rules, expressed as reasoning.effort", () => {
    const profile = resolveProfile({ protocol: "openai-responses", presets: matchPresets("deepseek", "deepseek-flash").corrections });
    const req = buildChatRequest({ protocol: "openai-responses", modelId: "deepseek-flash", profile: profile.profile, params: { temperature: 0.2, reasoning: { mode: "on", effort: "max" } }, messages: hello });
    expect(req.body.reasoning).toEqual({ effort: "max" });
    expect(req.body).not.toHaveProperty("temperature");
    expect(req.body).not.toHaveProperty("include");
  });

  it("Anthropic Claude 5.x: asks for summarized adaptive thinking without being told to", () => {
    const req = request({ presetId: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(req.path).toBe("/v1/messages");
    expect(req.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("Anthropic Claude 4.5: thinking is manual budget, nothing sent by default", () => {
    expect(request({ presetId: "anthropic", modelId: "claude-sonnet-4-5-20250929" }).body).not.toHaveProperty("thinking");
    const on = request({ presetId: "anthropic", modelId: "claude-sonnet-4-5-20250929", params: { max_output_tokens: 16000, reasoning: { mode: "on", budgetTokens: 5000 } } });
    expect(on.body.thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
  });

  it("Anthropic discovery beats the model-id fallback; the correction still marks 5.x as thinking by default", () => {
    const supported = { supported: true };
    const [m] = parseModelList("anthropic", {
      data: [{ id: "claude-opus-5-5", capabilities: { thinking: { supported: true, types: { adaptive: supported, disabled: supported } }, effort: { low: supported, high: supported } } }],
    });
    const req = request({ presetId: "anthropic", modelId: "claude-opus-5-5", discovery: m!.patch, params: { reasoning: { mode: "on", effort: "high" } } });
    expect(req.body).toMatchObject({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  });

  it("MiniMax: always splits reasoning, and clamps temperature to its documented range", () => {
    const req = request({ presetId: "minimax", modelId: "MiniMax-M3", params: { temperature: 3 } });
    expect(req.body).toMatchObject({ reasoning_split: true, temperature: 2 });
  });

  it("Venice: provider extras reach venice_parameters, and reasoning comes from discovery", () => {
    const [m] = parseModelList("venice", {
      data: [{ id: "v", type: "text", model_spec: { capabilities: { supportsReasoning: true, supportsReasoningEffort: true } } }],
    });
    const req = request({
      presetId: "venice",
      modelId: "v",
      discovery: m!.patch,
      params: { extras: { venice_web_search: "auto", venice_system_prompt: false }, reasoning: { mode: "on", effort: "low" }, top_k: 40 },
    });
    expect(req.body).toMatchObject({
      venice_parameters: { enable_web_search: "auto", include_venice_system_prompt: false },
      reasoning_effort: "low",
      top_k: 40,
    });
  });

  it("OpenRouter: routes through the unified reasoning object and provider sort", () => {
    const [m] = parseModelList("openrouter", {
      data: [{ id: "deepseek/deepseek-flash", supported_parameters: ["temperature", "reasoning", "tools"], architecture: { input_modalities: ["text"], output_modalities: ["text"] } }],
    });
    const req = request({
      presetId: "openrouter",
      modelId: "deepseek/deepseek-flash",
      discovery: m!.patch,
      params: { reasoning: { mode: "on", effort: "high" }, extras: { provider_sort: "throughput" }, top_p: 0.5 },
    });
    expect(req.body).toMatchObject({ reasoning: { effort: "high" }, provider: { sort: "throughput" } });
    expect(req.body).not.toHaveProperty("top_p");
    expect(req.dropped.map((d) => d.param)).toContain("top_p");
  });

  it("xAI: stop is rejected by reasoning models, so it is dropped", () => {
    const req = request({ presetId: "xai", modelId: "grok-4.7", params: { stop: ["x"] } });
    expect(req.body).not.toHaveProperty("stop");
    expect(req.dropped.map((d) => d.param)).toContain("stop");
  });

  it("an unknown custom model still builds a plain, valid request", () => {
    const req = request({ presetId: "custom", modelId: "whatever", params: { temperature: 0.7, reasoning: { mode: "on" } } });
    expect(req.body.temperature).toBe(0.7);
    expect(req.notes[0]).toContain("tidak punya kontrol reasoning");
  });
});
