import { describe, expect, it } from "vitest";
import {
  chatImageBody,
  buildVersions,
  compileEditPrompt,
  compileReferencePrompt,
  dashscopeRoot,
  dashscopeSubmitBody,
  defaultImageSpec,
  defaultImageWire,
  mergeImageSpec,
  openaiImagesGenerateBody,
  openrouterImagesBody,
  resolveImageParams,
  veniceEditBody,
  veniceMultiEditBody,
  veniceGenerateBody,
} from "./index.js";

describe("resolveImageParams", () => {
  const openai = defaultImageSpec("openai-images");

  it("keeps supported values and caps n at the model limit", () => {
    const r = resolveImageParams(openai, { size: "1024x1024", quality: "high", n: 9 }, 0);
    expect(r.params).toMatchObject({ size: "1024x1024", quality: "high", n: 4 });
    expect(r.n).toBe(4);
    expect(r.notes.join(" ")).toContain("paling banyak 4");
  });

  it("drops parameters the model does not take and says why", () => {
    const r = resolveImageParams(openai, { negativePrompt: "blur", seed: 5, steps: 20, aspectRatio: "16:9" }, 0);
    expect(r.params).toEqual({ n: 1 });
    expect(r.notes).toHaveLength(4);
  });

  it("rejects a size the model does not list", () => {
    const r = resolveImageParams(openai, { size: "999x999" }, 0);
    expect(r.params.size).toBeUndefined();
    expect(r.notes[0]).toContain("999x999");
  });

  it("clamps steps and guidance into the model's range", () => {
    const r = resolveImageParams(defaultImageSpec("venice-image"), { steps: 500, guidance: 0 }, 0);
    expect(r.params.steps).toBe(50);
    expect(r.params.guidance).toBe(1);
  });

  it("limits references to what the model accepts", () => {
    expect(resolveImageParams(defaultImageSpec("venice-image"), {}, 3)).toMatchObject({ referencesUsed: 1 });
    const none = resolveImageParams(defaultImageSpec("dashscope-async"), {}, 2);
    expect(none.referencesUsed).toBe(0);
    expect(none.notes[0]).toContain("tidak menerima gambar referensi");
  });
});

describe("compileReferencePrompt", () => {
  it("returns the prompt untouched without references", () => {
    expect(compileReferencePrompt("a cat", [])).toBe("a cat");
  });

  it("describes a carried-over previous result as such", () => {
    const text = compileReferencePrompt("make it night", [{ previous: true }, { role: "style" }]);
    expect(text.split("\n")).toEqual([
      "Image 1 is the previous result: keep everything the instruction does not ask to change.",
      "Image 2 is a style reference: imitate its rendering technique, colour treatment and texture, not its content.",
      "Instruction: make it night",
    ]);
  });

  it("names each image by position and role", () => {
    const text = compileReferencePrompt("paint a harbour", [{ role: "style" }, { role: "palette" }, {}]);
    expect(text).toContain("Image 1 is a style reference");
    expect(text).toContain("Image 2 is a colour palette reference");
    expect(text).toContain("Image 3 is a supplementary reference");
    expect(text.endsWith("Instruction: paint a harbour")).toBe(true);
  });
});

describe("wire bodies", () => {
  const base = { modelId: "m", prompt: "p", n: 2, references: ["data:image/png;base64,AA"] };

  it("openai generations", () => {
    expect(openaiImagesGenerateBody({ ...base, params: { size: "1024x1024", format: "webp" } })).toEqual({ model: "m", prompt: "p", n: 2, size: "1024x1024", output_format: "webp" });
  });

  it("openrouter images carries references as input_references", () => {
    const b = openrouterImagesBody({ ...base, params: { aspectRatio: "16:9", resolution: "2K", seed: 3 } });
    expect(b).toMatchObject({ aspect_ratio: "16:9", resolution: "2K", seed: 3, input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] });
  });

  it("venice generate and edit", () => {
    const g = veniceGenerateBody({ ...base, params: { negativePrompt: "blur", guidance: 7, steps: 8 } });
    expect(g).toMatchObject({ variants: 2, negative_prompt: "blur", cfg_scale: 7, steps: 8 });
    expect(g).not.toHaveProperty("image");
    expect(veniceEditBody({ ...base, params: { format: "png" } })).toEqual({ model: "m", prompt: "p", image: "AA", aspect_ratio: "auto", output_format: "png", safe_mode: false });
  });

  it("venice safe mode: off unless asked for, and only sent to Venice", () => {
    expect(veniceEditBody({ ...base, params: {} })).toMatchObject({ safe_mode: false });
    expect(veniceGenerateBody({ ...base, params: {} })).toMatchObject({ safe_mode: false });
    expect(veniceEditBody({ ...base, params: { safeMode: true } })).toMatchObject({ safe_mode: true });
    expect(resolveImageParams(defaultImageSpec("venice-image"), { safeMode: true }, 0).params.safeMode).toBe(true);
    expect(resolveImageParams(defaultImageSpec("openai-images"), { safeMode: true }, 0).params).not.toHaveProperty("safeMode");
  });

  it("venice multi-edit uses modelId and an images list, target first", () => {
    const b = veniceMultiEditBody({ ...base, references: ["data:image/png;base64,AA", "data:image/png;base64,BB"], params: { resolution: "2K" } });
    expect(b).toEqual({ modelId: "m", prompt: "p", images: ["AA", "BB"], aspect_ratio: "auto", resolution: "2K", safe_mode: false });
    expect(veniceGenerateBody({ ...base, references: ["data:image/png;base64,CC"], params: {} }).style_references).toEqual([{ image: "CC" }]);
  });

  it("dashscope always asks for one image per task", () => {
    expect(dashscopeSubmitBody({ ...base, params: { size: "1664*928", negativePrompt: "x" } })).toEqual({
      model: "m",
      input: { prompt: "p" },
      parameters: { n: 1, negative_prompt: "x", size: "1664*928", watermark: false },
    });
  });

  it("chat modalities asks for image only unless the model also answers in text", () => {
    const only = chatImageBody({ modelId: "m", messages: [{ role: "user", text: "hi", images: [] }], params: { aspectRatio: "1:1" }, textOutput: false });
    expect(only).toMatchObject({ modalities: ["image"], image_config: { aspect_ratio: "1:1" }, stream: false });
    const both = chatImageBody({ modelId: "m", messages: [{ role: "user", text: "hi", images: ["data:image/png;base64,AA"] }], params: {}, textOutput: true });
    expect(both.modalities).toEqual(["image", "text"]);
    expect((both.messages as { content: unknown }[])[0]!.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }, { type: "text", text: "hi" }]);
  });
});

describe("wire selection", () => {
  it("follows the provider family", () => {
    expect(defaultImageWire("openrouter", false, "https://openrouter.ai/api/v1")).toBe("openrouter-images");
    expect(defaultImageWire("openrouter", true, "https://openrouter.ai/api/v1")).toBe("chat-modalities");
    expect(defaultImageWire("venice", false, "")).toBe("venice-image");
    expect(defaultImageWire("google", true, "")).toBe("chat-modalities");
    expect(defaultImageWire("custom", false, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("dashscope-async");
    expect(defaultImageWire("openai", false, "https://api.openai.com/v1")).toBe("openai-images");
  });

  it("finds the DashScope task root beside the compatible-mode path", () => {
    expect(dashscopeRoot("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe("https://dashscope-intl.aliyuncs.com/api/v1");
    expect(dashscopeRoot("https://x.maas.aliyuncs.com/api/v1/")).toBe("https://x.maas.aliyuncs.com/api/v1");
  });

  it("a profile patch refines the wire's defaults", () => {
    const spec = mergeImageSpec(defaultImageSpec("openai-images"), { wire: "openai-images", maxN: 1, sizes: ["512x512"] });
    expect(spec).toMatchObject({ maxN: 1, sizes: ["512x512"], maxInputImages: 16 });
  });
});

describe("compileEditPrompt", () => {
  it("numbers the target first, then references with their roles, then the instruction and what to keep", () => {
    const text = compileEditPrompt("make it dusk", [{ role: "style" }, { role: "palette" }], ["face", "composition"]);
    expect(text.split("\n")).toEqual([
      "Image 1 is the image to edit.",
      "Image 2 is a style reference: imitate its rendering technique, colour treatment and texture, not its content.",
      "Image 3 is a colour palette reference: use its colours, not its content.",
      "Instruction: make it dusk",
      "Keep unchanged from Image 1: the face and identity of any person or character, the composition and framing.",
    ]);
  });

  it("has no keep line when nothing is to be kept", () => {
    expect(compileEditPrompt("x", [], [])).toBe("Image 1 is the image to edit.\nInstruction: x");
  });
});

describe("buildVersions", () => {
  const msg = (id: string, target: string, results: string[], prompt: string) => ({
    id,
    role: "assistant",
    status: "complete",
    createdAt: "2026-10-15T10:00:00.000Z",
    image: { target, prompt },
    parts: results.map((assetId, i) => ({ type: "image", assetId, seed: i + 1 })),
  });

  it("starts from the first target and chains each result to the image it was edited from", () => {
    const v = buildVersions([msg("m1", "orig", ["a", "b"], "one"), msg("m2", "a", ["c"], "two")]);
    expect(v.map((x) => [x.label, x.assetId, x.parent])).toEqual([
      ["v0", "orig", null],
      ["v1", "a", "orig"],
      ["v2", "b", "orig"],
      ["v3", "c", "a"],
    ]);
    expect(v[3]).toMatchObject({ messageId: "m2", instruction: "two", seed: 1 });
  });

  it("editing an older version starts a branch and keeps the rest", () => {
    const v = buildVersions([msg("m1", "orig", ["a"], "one"), msg("m2", "a", ["b"], "two"), msg("m3", "a", ["c"], "three")]);
    expect(v.filter((x) => x.parent === "a").map((x) => x.assetId)).toEqual(["b", "c"]);
  });

  it("ignores turns that are not edits", () => {
    expect(buildVersions([{ id: "u", role: "user", status: "complete", createdAt: "", image: null, parts: [] }])).toEqual([]);
  });
});
