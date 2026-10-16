import { z } from "zod";

/** Sampling controls EZClaw knows how to map. Anything else goes through "extras" or the extra body. */
export const SAMPLING_PARAMS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
] as const;
export const samplingParamSchema = z.enum(SAMPLING_PARAMS);
export type SamplingParam = z.infer<typeof samplingParamSchema>;

export const SAMPLING_LABELS: Record<SamplingParam, string> = {
  temperature: "temperature",
  top_p: "top_p",
  top_k: "top_k",
  min_p: "min_p",
  frequency_penalty: "frequency_penalty",
  presence_penalty: "presence_penalty",
  repetition_penalty: "repetition_penalty",
};

export const numberSpecSchema = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  default: z.number().optional(),
});
export type NumberSpec = z.infer<typeof numberSpecSchema>;

export const MODALITIES = ["text", "image", "file", "audio", "video"] as const;
export const modalitySchema = z.enum(MODALITIES);
export type Modality = z.infer<typeof modalitySchema>;

/**
 * How a model's reasoning is switched on and tuned on the wire. Each style is one
 * mapping in the Parameter Engine, so adding a provider quirk means adding a style
 * (or using extras) rather than changing call sites.
 */
export const REASONING_STYLES = [
  "none",
  "openai-effort",
  "openrouter",
  "deepseek",
  "zai",
  "qwen",
  "venice",
  "anthropic-adaptive",
  "anthropic-budget",
] as const;
export const reasoningStyleSchema = z.enum(REASONING_STYLES);
export type ReasoningStyle = z.infer<typeof reasoningStyleSchema>;

export const REASONING_REPLAY = ["never", "with-tools", "always", "signature"] as const;
export const reasoningReplaySchema = z.enum(REASONING_REPLAY);
export type ReasoningReplay = z.infer<typeof reasoningReplaySchema>;

export const reasoningSpecSchema = z.object({
  style: reasoningStyleSchema,
  /** True when the model accepts an explicit "off". */
  canDisable: z.boolean(),
  /** True when the model reasons if the request says nothing about it. */
  defaultOn: z.boolean(),
  efforts: z.array(z.string()),
  defaultEffort: z.string().optional(),
  /** Token budget range, for styles that take one. */
  budget: numberSpecSchema.optional(),
  /** Sampling params that the provider ignores or rejects while reasoning is active. */
  lockedWhileActive: z.array(samplingParamSchema),
  lockReason: z.string().optional(),
});
export type ReasoningSpec = z.infer<typeof reasoningSpecSchema>;

/** A provider-specific option rendered in the parameter panel and written at a dotted wire path. */
export const extraParamSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  /** Dotted path in the request body, e.g. "venice_parameters.enable_web_search". */
  path: z.string().min(1),
  type: z.enum(["boolean", "enum", "number"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  /** What the provider assumes when the field is absent; shown as the control's starting value. */
  default: z.union([z.boolean(), z.string(), z.number()]).optional(),
});
export type ExtraParamSpec = z.infer<typeof extraParamSchema>;

/**
 * How an image model is reached. One model, one wire: the wire decides the endpoint path,
 * the body shape and how reference images travel.
 *  - chat-modalities: a chat request that asks for image output (Gemini image models, many OpenRouter models).
 *  - openai-images: /images/generations and /images/edits (OpenAI, xAI, most compatible servers).
 *  - openrouter-images: OpenRouter's /images with `input_references`.
 *  - venice-image: Venice /image/generate and /image/edit (edit takes one image).
 *  - dashscope-async: Alibaba DashScope task submit, then polling.
 */
export const IMAGE_WIRES = ["chat-modalities", "openai-images", "openrouter-images", "venice-image", "dashscope-async"] as const;
export const imageWireSchema = z.enum(IMAGE_WIRES);
export type ImageWire = z.infer<typeof imageWireSchema>;

export const imageSpecSchema = z.object({
  wire: imageWireSchema,
  /** Pixel sizes as "WIDTHxHEIGHT" (or "auto"). Empty when the model takes an aspect ratio or resolution tier instead. */
  sizes: z.array(z.string()),
  aspectRatios: z.array(z.string()),
  resolutions: z.array(z.string()),
  qualities: z.array(z.string()),
  formats: z.array(z.string()),
  /** Most images one request can return. */
  maxN: z.number().int().min(1).max(10),
  /** Most reference images one request can carry; 0 means text-to-image only. */
  maxInputImages: z.number().int().min(0).max(16),
  negativePrompt: z.boolean(),
  seed: z.boolean(),
  steps: numberSpecSchema.nullable(),
  guidance: numberSpecSchema.nullable(),
  /** True when the model sees the conversation, so a follow-up needs no rewritten prompt. */
  conversational: z.boolean(),
});
export type ImageSpec = z.infer<typeof imageSpecSchema>;

export const imageSpecPatchSchema = imageSpecSchema.partial();
export type ImageSpecPatch = z.infer<typeof imageSpecPatchSchema>;


export const capabilityProfileSchema = z.object({
  inputModalities: z.array(modalitySchema),
  outputModalities: z.array(modalitySchema),
  contextLength: z.number().nullable(),
  maxOutputTokens: z.number().nullable(),
  tools: z.boolean(),
  maxTokensField: z.enum(["max_tokens", "max_completion_tokens"]),
  systemRole: z.enum(["system", "developer"]),
  sampling: z.partialRecord(samplingParamSchema, numberSpecSchema),
  stop: z.boolean(),
  seed: z.boolean(),
  jsonMode: z.boolean(),
  /** Ask for token usage in the stream (OpenAI-style stream_options). */
  streamUsage: z.boolean(),
  reasoning: reasoningSpecSchema,
  reasoningReplay: reasoningReplaySchema,
  extras: z.array(extraParamSchema),
  /** Present for image models: which wire to use and what it accepts. Facts here refine the wire's defaults. */
  image: imageSpecPatchSchema.optional(),
  /**
   * Mark the prompt for provider-side caching (Anthropic cache_control, also passed through by OpenRouter
   * for Claude models). Cached input is billed at a fraction of the normal price on later requests.
   */
  promptCache: z.boolean().default(false),
  /** Fields always sent for this model unless a param or the extra body overrides them (e.g. MiniMax reasoning_split). */
  bodyDefaults: z.record(z.string(), z.unknown()),
  notes: z.array(z.string()),
});
export type CapabilityProfile = z.infer<typeof capabilityProfileSchema>;

/**
 * A layer of the profile stack. Sampling entries set to null remove that control, and
 * `extras` entries replace earlier ones with the same key.
 */
export const profilePatchSchema = capabilityProfileSchema
  .omit({ sampling: true, reasoning: true })
  .partial()
  .extend({
    sampling: z.partialRecord(samplingParamSchema, numberSpecSchema.nullable()).optional(),
    reasoning: reasoningSpecSchema.partial().optional(),
  });
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

export const PROFILE_LAYERS = ["protocol", "discovery", "preset", "override", "learned"] as const;
export type ProfileLayer = (typeof PROFILE_LAYERS)[number];

/** Which layer last wrote each field, keyed by "field" or "field.subfield" (e.g. "reasoning.style"). */
export type Provenance = Record<string, ProfileLayer>;

export interface ResolvedProfile {
  profile: CapabilityProfile;
  provenance: Provenance;
  /** Wire body keys the model rejected before; they are omitted from every request. */
  omit: string[];
}
