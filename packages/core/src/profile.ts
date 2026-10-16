import type {
  CapabilityProfile,
  NumberSpec,
  ProfileLayer,
  ProfilePatch,
  Provenance,
  ResolvedProfile,
  SamplingParam,
} from "./capabilities.js";

export type Protocol = "openai-chat" | "openai-responses" | "anthropic";

/** Typical range for each sampling control; used when a provider says a param exists but not its range. */
export const SAMPLING_SPEC_DEFAULTS: Record<SamplingParam, NumberSpec> = {
  temperature: { min: 0, max: 2, step: 0.05 },
  top_p: { min: 0, max: 1, step: 0.01 },
  top_k: { min: 0, max: 200, step: 1 },
  min_p: { min: 0, max: 1, step: 0.01 },
  frequency_penalty: { min: -2, max: 2, step: 0.1 },
  presence_penalty: { min: -2, max: 2, step: 0.1 },
  repetition_penalty: { min: 0, max: 2, step: 0.05 },
};

/** Baseline for a protocol before anything is known about the specific model. */
export function protocolDefaults(protocol: Protocol): CapabilityProfile {
  if (protocol === "anthropic") {
    return {
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      contextLength: null,
      maxOutputTokens: null,
      tools: true,
      maxTokensField: "max_tokens",
      systemRole: "system",
      sampling: {
        temperature: { min: 0, max: 1, step: 0.05 },
        top_p: { min: 0, max: 1, step: 0.01 },
        top_k: { min: 0, max: 500, step: 1 },
      },
      stop: true,
      seed: false,
      jsonMode: false,
      streamUsage: false,
      reasoning: {
        style: "anthropic-adaptive",
        canDisable: true,
        defaultOn: false,
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
        lockedWhileActive: [],
      },
      reasoningReplay: "signature",
      promptCache: true,
      extras: [],
      bodyDefaults: {},
      notes: [],
    };
  }
  const chat: CapabilityProfile = {
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextLength: null,
    maxOutputTokens: null,
    /** Unknown until a provider reports it or a preset states it, so it is not claimed. */
    tools: false,
    maxTokensField: "max_tokens",
    systemRole: "system",
    sampling: {
      temperature: { min: 0, max: 2, step: 0.05 },
      top_p: { min: 0, max: 1, step: 0.01 },
      frequency_penalty: { min: -2, max: 2, step: 0.1 },
      presence_penalty: { min: -2, max: 2, step: 0.1 },
    },
    stop: true,
    seed: true,
    jsonMode: true,
    streamUsage: true,
    reasoning: {
      style: "none",
      canDisable: false,
      defaultOn: false,
      efforts: [],
      lockedWhileActive: [],
    },
    reasoningReplay: "never",
    promptCache: false,
    extras: [],
    bodyDefaults: {},
    notes: [],
  };
  if (protocol === "openai-responses") {
    return {
      ...chat,
      sampling: {
        temperature: { min: 0, max: 2, step: 0.05 },
        top_p: { min: 0, max: 1, step: 0.01 },
      },
      stop: false,
      seed: false,
      streamUsage: false,
      // Stateless: the whole transcript travels in `input`, and nothing is stored on the provider.
      bodyDefaults: { store: false },
    };
  }
  return chat;
}

interface Layered {
  layer: ProfileLayer;
  patch: ProfilePatch;
}

/** Applies one layer on top of `base`, recording provenance for every field it touches. */
export function applyPatch(
  base: CapabilityProfile,
  patch: ProfilePatch,
  layer: ProfileLayer,
  provenance: Provenance,
): CapabilityProfile {
  const next = JSON.parse(JSON.stringify(base)) as CapabilityProfile;

  for (const key of Object.keys(patch) as (keyof ProfilePatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;

    if (key === "sampling") {
      const entries = Object.entries(value as NonNullable<ProfilePatch["sampling"]>) as [SamplingParam, unknown][];
      for (const [param, spec] of entries) {
        if (spec === null) delete next.sampling[param];
        else next.sampling[param] = spec as NonNullable<CapabilityProfile["sampling"][SamplingParam]>;
        provenance[`sampling.${param}`] = layer;
      }
    } else if (key === "reasoning") {
      const entries = Object.entries(value as NonNullable<ProfilePatch["reasoning"]>);
      for (const [field, fieldValue] of entries) {
        if (fieldValue === undefined) continue;
        (next.reasoning as unknown as Record<string, unknown>)[field] = fieldValue;
        provenance[`reasoning.${field}`] = layer;
      }
    } else if (key === "extras") {
      // Same key replaces; new keys append.
      const incoming = value as CapabilityProfile["extras"];
      const merged = [...next.extras];
      for (const extra of incoming) {
        const at = merged.findIndex((e) => e.key === extra.key);
        if (at >= 0) merged[at] = extra;
        else merged.push(extra);
      }
      next.extras = merged;
      provenance.extras = layer;
    } else if (key === "image") {
      next.image = { ...next.image, ...(value as NonNullable<CapabilityProfile["image"]>) };
      provenance.image = layer;
    } else if (key === "bodyDefaults") {
      next.bodyDefaults = { ...next.bodyDefaults, ...(value as Record<string, unknown>) };
      provenance.bodyDefaults = layer;
    } else if (key === "notes") {
      // Notes accumulate across layers instead of replacing each other.
      next.notes = [...next.notes, ...(value as string[]).filter((n) => !next.notes.includes(n))];
      provenance.notes = layer;
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
      provenance[key] = layer;
    }
  }
  return next;
}

export interface ResolveInput {
  protocol: Protocol;
  discovery?: ProfilePatch | null;
  /** Curated patches that only fill gaps: applied before discovery so provider-reported facts win. */
  fallbackPresets?: ProfilePatch[];
  /** Curated corrections, applied after discovery, for things providers do not report (quirks, defaults). */
  presets?: ProfilePatch[];
  override?: ProfilePatch | null;
  /** Wire body keys this model rejected before. */
  omit?: string[];
}

/**
 * Effective capability profile: protocol defaults, then discovery, then curated presets,
 * then the owner's override. Later layers win. Learned rejections do not change the
 * profile; they are returned as `omit` and applied to the wire body by the engine.
 */
export function resolveProfile(input: ResolveInput): ResolvedProfile {
  const provenance: Provenance = {};
  let profile = protocolDefaults(input.protocol);

  const layers: Layered[] = [];
  for (const patch of input.fallbackPresets ?? []) layers.push({ layer: "preset", patch });
  if (input.discovery) layers.push({ layer: "discovery", patch: input.discovery });
  for (const patch of input.presets ?? []) layers.push({ layer: "preset", patch });
  if (input.override) layers.push({ layer: "override", patch: input.override });

  for (const { layer, patch } of layers) profile = applyPatch(profile, patch, layer, provenance);

  return { profile, provenance, omit: [...new Set(input.omit ?? [])] };
}
