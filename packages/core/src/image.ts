import { z } from "zod";
import { type ImageSpec, type ImageSpecPatch, type ImageWire, type NumberSpec } from "./capabilities.js";

export const IMAGE_WIRE_LABELS: Record<ImageWire, string> = {
  "chat-modalities": "Chat dengan output gambar",
  "openai-images": "OpenAI Images",
  "openrouter-images": "OpenRouter Images",
  "venice-image": "Venice Image",
  "dashscope-async": "DashScope (async)",
};

export const IMAGE_ROLES = ["style", "subject", "object", "palette", "composition", "background", "other"] as const;
export const imageRoleSchema = z.enum(IMAGE_ROLES);
export type ImageRole = z.infer<typeof imageRoleSchema>;

export const IMAGE_ROLE_LABELS: Record<ImageRole, string> = {
  style: "Gaya",
  subject: "Subjek atau karakter",
  object: "Objek",
  palette: "Palet warna",
  composition: "Komposisi atau pose",
  background: "Latar",
  other: "Lainnya",
};

/** What the model is told about each reference, in English because most image models are trained mostly on English prompts. */
const ROLE_INSTRUCTIONS: Record<ImageRole, string> = {
  style: "style reference: imitate its rendering technique, colour treatment and texture, not its content",
  subject: "subject reference: keep the identity and distinguishing features of the person or character shown",
  object: "object reference: include this object, keeping its shape and details",
  palette: "colour palette reference: use its colours, not its content",
  composition: "composition reference: follow its layout, framing and pose, not its content",
  background: "background reference: use this setting as the background",
  other: "supplementary reference",
};

const COMMON_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const TIERS = ["1K", "2K", "4K"];
const FORMATS = ["png", "jpeg", "webp"];
const QUALITIES = ["low", "medium", "high"];

/** Baseline for a wire before anything is known about the specific model. */
export function defaultImageSpec(wire: ImageWire): ImageSpec {
  const base: ImageSpec = {
    wire,
    sizes: [],
    aspectRatios: [],
    resolutions: [],
    qualities: [],
    formats: [],
    maxN: 1,
    maxInputImages: 0,
    negativePrompt: false,
    seed: false,
    steps: null,
    guidance: null,
    conversational: false,
  };
  switch (wire) {
    case "chat-modalities":
      // One request per image, run in parallel.
      return { ...base, aspectRatios: COMMON_RATIOS, resolutions: TIERS, maxN: 4, maxInputImages: 4, conversational: true };
    case "openai-images":
      return { ...base, sizes: ["1024x1024", "1536x1024", "1024x1536", "auto"], qualities: [...QUALITIES, "auto"], formats: FORMATS, maxN: 4, maxInputImages: 16 };
    case "openrouter-images":
      return { ...base, aspectRatios: COMMON_RATIOS, resolutions: TIERS, qualities: QUALITIES, formats: FORMATS, maxN: 4, maxInputImages: 4, seed: true };
    case "venice-image":
      return {
        ...base,
        aspectRatios: ["1:1", "3:2", "2:3", "16:9", "9:16", "4:3", "3:4", "4:5", "21:9"],
        resolutions: TIERS,
        formats: FORMATS,
        maxN: 4,
        maxInputImages: 1,
        negativePrompt: true,
        seed: true,
        steps: { min: 1, max: 50, step: 1 },
        guidance: { min: 1, max: 20, step: 0.5, default: 7.5 },
      };
    case "dashscope-async":
      // Async tasks make one image each, so n tasks run in parallel.
      return { ...base, sizes: ["1328*1328", "1664*928", "928*1664", "1472*1104", "1104*1472"], maxN: 4, negativePrompt: true, seed: true };
  }
}

/** Applies a patch on top of a spec; arrays and values replace, they do not merge. */
export function mergeImageSpec(base: ImageSpec, patch: ImageSpecPatch | null | undefined): ImageSpec {
  if (!patch) return base;
  const next = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  return next;
}

export const imageParamsSchema = z
  .object({
    negativePrompt: z.string().max(7500).optional(),
    size: z.string().max(20).optional(),
    aspectRatio: z.string().max(10).optional(),
    resolution: z.string().max(10).optional(),
    quality: z.string().max(20).optional(),
    format: z.string().max(10).optional(),
    n: z.number().int().min(1).max(10).optional(),
    seed: z.number().int().optional(),
    steps: z.number().optional(),
    guidance: z.number().optional(),
    /** Let the Prompt Composer rewrite follow-ups into a standalone prompt. Default on for single-prompt models. */
    composer: z.boolean().optional(),
  })
  .strict();
export type ImageParams = z.infer<typeof imageParamsSchema>;

export const imageReferenceSchema = z.object({
  assetId: z.string().min(1).max(80),
  role: imageRoleSchema.optional(),
});
export type ImageReference = z.infer<typeof imageReferenceSchema>;

/** What the owner wants left alone in an edit. Each chip becomes one phrase in the compiled prompt. */
export const KEEP_IDS = ["face", "composition", "colors", "text", "background"] as const;
export const keepIdSchema = z.enum(KEEP_IDS);
export type KeepId = z.infer<typeof keepIdSchema>;

export const KEEP_LABELS: Record<KeepId, string> = {
  face: "Wajah",
  composition: "Komposisi",
  colors: "Warna",
  text: "Teks di gambar",
  background: "Latar",
};

const KEEP_PHRASES: Record<KeepId, string> = {
  face: "the face and identity of any person or character",
  composition: "the composition and framing",
  colors: "the colour palette",
  text: "any text in the image",
  background: "the background",
};

/** What an image turn was made from, stored with the assistant message. */
export interface ImageTurnMeta {
  wire: string;
  /** The prompt as the owner typed it. */
  prompt: string;
  /** The prompt actually sent, after the Prompt Composer and the reference template. */
  sentPrompt: string;
  composed: boolean;
  params: ImageParams;
  references: { assetId: string; role?: ImageRole }[];
  n: number;
  /** Edit turns: the image that was edited, which makes each result a child of it. */
  target?: string;
  keep?: KeepId[];
}

export interface ResolvedImageParams {
  params: ImageParams;
  n: number;
  /** How many of the references fit; the rest are not sent. */
  referencesUsed: number;
  notes: string[];
}

function clamp(spec: NumberSpec, v: number): number {
  return Math.min(spec.max, Math.max(spec.min, v));
}

/** Keeps only what the model accepts and says why anything else was dropped. */
export function resolveImageParams(spec: ImageSpec, params: ImageParams, referenceCount: number): ResolvedImageParams {
  const notes: string[] = [];
  const out: ImageParams = {};

  if (params.negativePrompt?.trim()) {
    if (spec.negativePrompt) out.negativePrompt = params.negativePrompt.trim();
    else notes.push("Negative prompt tidak dikirim: model ini tidak punya parameter itu.");
  }
  const pick = (key: "size" | "aspectRatio" | "resolution" | "quality" | "format", allowed: string[], label: string) => {
    const v = params[key];
    if (v === undefined || v === "") return;
    if (allowed.length === 0) notes.push(`${label} tidak dikirim: model ini tidak memakainya.`);
    else if (!allowed.includes(v)) notes.push(`${label} "${v}" tidak didukung model ini, jadi tidak dikirim.`);
    else out[key] = v;
  };
  pick("size", spec.sizes, "Ukuran");
  pick("aspectRatio", spec.aspectRatios, "Aspect ratio");
  pick("resolution", spec.resolutions, "Resolusi");
  pick("quality", spec.qualities, "Kualitas");
  pick("format", spec.formats, "Format");

  if (params.seed !== undefined) {
    if (spec.seed) out.seed = params.seed;
    else notes.push("Seed tidak dikirim: model ini tidak punya parameter itu.");
  }
  if (params.steps !== undefined) {
    if (spec.steps) out.steps = clamp(spec.steps, params.steps);
    else notes.push("Steps tidak dikirim: model ini tidak punya parameter itu.");
  }
  if (params.guidance !== undefined) {
    if (spec.guidance) out.guidance = clamp(spec.guidance, params.guidance);
    else notes.push("Guidance tidak dikirim: model ini tidak punya parameter itu.");
  }

  let n = params.n ?? 1;
  if (n > spec.maxN) {
    notes.push(`Model ini menghasilkan paling banyak ${spec.maxN} gambar per request, jadi jumlahnya diturunkan dari ${n}.`);
    n = spec.maxN;
  }

  let referencesUsed = referenceCount;
  if (referenceCount > spec.maxInputImages) {
    referencesUsed = spec.maxInputImages;
    notes.push(
      spec.maxInputImages === 0
        ? "Model ini tidak menerima gambar referensi, jadi referensi tidak dikirim."
        : `Model ini menerima paling banyak ${spec.maxInputImages} gambar referensi. ${referenceCount - spec.maxInputImages} referensi terakhir tidak dikirim.`,
    );
  }
  if (params.composer !== undefined) out.composer = params.composer;
  out.n = n;
  return { params: out, n, referencesUsed, notes };
}

export interface PromptReference {
  role?: ImageRole;
  /** The result of the previous turn, carried along so an instruction can change it. */
  previous?: boolean;
}

/**
 * Names each reference by position and role, so the model knows which image is which.
 * With no references the prompt is returned untouched.
 */
export function compileReferencePrompt(prompt: string, refs: PromptReference[]): string {
  if (refs.length === 0) return prompt;
  const lines = refs.map((r, i) =>
    r.previous ? `Image ${i + 1} is the previous result: keep everything the instruction does not ask to change.` : `Image ${i + 1} is a ${ROLE_INSTRUCTIONS[r.role ?? "other"]}.`,
  );
  return `${lines.join("\n")}\nInstruction: ${prompt}`;
}

/**
 * The prompt for an edit: Image 1 is the one to change, the rest are references with their roles,
 * then the instruction and what must stay as it is.
 */
export function compileEditPrompt(instruction: string, refs: PromptReference[], keep: KeepId[]): string {
  const lines = ["Image 1 is the image to edit.", ...refs.map((r, i) => `Image ${i + 2} is a ${ROLE_INSTRUCTIONS[r.role ?? "other"]}.`)];
  const out = [lines.join("\n"), `Instruction: ${instruction}`];
  if (keep.length > 0) out.push(`Keep unchanged from Image 1: ${keep.map((k) => KEEP_PHRASES[k]).join(", ")}.`);
  return out.join("\n");
}

/* ------------------------------------------------------------------ versions */

export interface ImageVersion {
  /** The image itself. */
  assetId: string;
  /** "v0" for the original, then v1, v2 in the order made. */
  label: string;
  /** The version this one was edited from; null for the original. */
  parent: string | null;
  /** Message that produced it; null for the original. */
  messageId: string | null;
  instruction: string | null;
  seed?: number;
  createdAt: string | null;
}

/**
 * The chain of versions in an edit thread. The original is the first turn's target; every result
 * is a child of the target its turn was given, so editing an older version starts a branch
 * and leaves the others untouched.
 */
export function buildVersions(messages: { id: string; role: string; parts: { type: string; assetId?: string; seed?: number }[]; status: string; image: { target?: string; prompt: string } | null; createdAt: string }[]): ImageVersion[] {
  const versions: ImageVersion[] = [];
  const seen = new Set<string>();
  let counter = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.image?.target) continue;
    if (!seen.has(m.image.target)) {
      seen.add(m.image.target);
      versions.push({ assetId: m.image.target, label: `v${counter++}`, parent: null, messageId: null, instruction: null, createdAt: null });
    }
    for (const p of m.parts) {
      if (p.type !== "image" || !p.assetId || seen.has(p.assetId)) continue;
      seen.add(p.assetId);
      versions.push({ assetId: p.assetId, label: `v${counter++}`, parent: m.image.target, messageId: m.id, instruction: m.image.prompt, ...(p.seed !== undefined ? { seed: p.seed } : {}), createdAt: m.createdAt });
    }
  }
  return versions;
}

/* ------------------------------------------------------------------ wire bodies */

export interface ImageBodyInput {
  modelId: string;
  prompt: string;
  params: ImageParams;
  n: number;
  /** data: URLs of the references that fit. */
  references: string[];
}

export function openaiImagesGenerateBody(i: ImageBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    prompt: i.prompt,
    n: i.n,
    ...(i.params.size ? { size: i.params.size } : {}),
    ...(i.params.quality ? { quality: i.params.quality } : {}),
    ...(i.params.format ? { output_format: i.params.format } : {}),
  };
}

/** Fields that accompany the image parts of an /images/edits multipart request. */
export function openaiImagesEditFields(i: ImageBodyInput): Record<string, string> {
  const f: Record<string, string> = { model: i.modelId, prompt: i.prompt, n: String(i.n) };
  if (i.params.size) f.size = i.params.size;
  if (i.params.quality) f.quality = i.params.quality;
  if (i.params.format) f.output_format = i.params.format;
  return f;
}

export function openrouterImagesBody(i: ImageBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    prompt: i.prompt,
    n: i.n,
    ...(i.params.aspectRatio ? { aspect_ratio: i.params.aspectRatio } : {}),
    ...(i.params.resolution ? { resolution: i.params.resolution } : {}),
    ...(i.params.quality ? { quality: i.params.quality } : {}),
    ...(i.params.format ? { output_format: i.params.format } : {}),
    ...(i.params.seed !== undefined ? { seed: i.params.seed } : {}),
    ...(i.references.length ? { input_references: i.references.map((url) => ({ type: "image_url", image_url: { url } })) } : {}),
  };
}

export function veniceGenerateBody(i: ImageBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    prompt: i.prompt,
    variants: i.n,
    ...(i.params.negativePrompt ? { negative_prompt: i.params.negativePrompt } : {}),
    ...(i.params.aspectRatio ? { aspect_ratio: i.params.aspectRatio } : {}),
    ...(i.params.resolution ? { resolution: i.params.resolution } : {}),
    ...(i.params.format ? { format: i.params.format } : {}),
    ...(i.params.seed !== undefined ? { seed: i.params.seed } : {}),
    ...(i.params.steps !== undefined ? { steps: i.params.steps } : {}),
    ...(i.params.guidance !== undefined ? { cfg_scale: i.params.guidance } : {}),
  };
}

/** Venice edit takes one image and no seed, steps or negative prompt. */
export function veniceEditBody(i: ImageBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    prompt: i.prompt,
    image: i.references[0],
    ...(i.params.aspectRatio ? { aspect_ratio: i.params.aspectRatio } : {}),
    ...(i.params.resolution ? { resolution: i.params.resolution } : {}),
    ...(i.params.format ? { output_format: i.params.format } : {}),
  };
}

export function dashscopeSubmitBody(i: ImageBodyInput): Record<string, unknown> {
  return {
    model: i.modelId,
    input: { prompt: i.prompt },
    parameters: {
      n: 1,
      ...(i.params.negativePrompt ? { negative_prompt: i.params.negativePrompt } : {}),
      ...(i.params.size ? { size: i.params.size } : {}),
      ...(i.params.seed !== undefined ? { seed: i.params.seed } : {}),
      watermark: false,
    },
  };
}

export interface ChatImageMessage {
  role: "user" | "assistant";
  text: string;
  /** data: URLs shown to the model in this turn. */
  images: string[];
}

export function chatImageBody(opts: { modelId: string; messages: ChatImageMessage[]; params: ImageParams; textOutput: boolean }): Record<string, unknown> {
  const imageConfig: Record<string, string> = {};
  if (opts.params.aspectRatio) imageConfig.aspect_ratio = opts.params.aspectRatio;
  if (opts.params.resolution) imageConfig.image_size = opts.params.resolution;
  return {
    model: opts.modelId,
    modalities: opts.textOutput ? ["image", "text"] : ["image"],
    messages: opts.messages.map((m) => ({
      role: m.role,
      content:
        m.images.length === 0
          ? m.text
          : [...m.images.map((url) => ({ type: "image_url", image_url: { url } })), { type: "text", text: m.text }],
    })),
    ...(Object.keys(imageConfig).length ? { image_config: imageConfig } : {}),
    ...(opts.params.seed !== undefined ? { seed: opts.params.seed } : {}),
    stream: false,
  };
}

/* -------------------------------------------------------------- wire selection */

/**
 * Picks the wire for a model nobody has configured yet. Always overridable in the model profile.
 * `family` is the endpoint's provider family; `outputsText` is true for models that also answer in text.
 */
export function defaultImageWire(family: string, outputsText: boolean, baseUrl: string): ImageWire {
  if (family === "openrouter") return outputsText ? "chat-modalities" : "openrouter-images";
  if (family === "venice") return "venice-image";
  if (family === "google") return "chat-modalities";
  if (family === "qwen" || /dashscope|aliyuncs/i.test(baseUrl)) return "dashscope-async";
  return "openai-images";
}

/** The DashScope task API lives beside the compatible-mode path, not under it. */
export function dashscopeRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/compatible-mode\/v\d+$/i.test(trimmed)) return trimmed.replace(/\/compatible-mode\/v\d+$/i, "/api/v1");
  if (/\/api\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/api/v1`;
}
