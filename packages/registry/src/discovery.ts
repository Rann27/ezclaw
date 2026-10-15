import {
  MODALITIES,
  SAMPLING_PARAMS,
  SAMPLING_SPEC_DEFAULTS,
  type Modality,
  type NumberSpec,
  type ProfilePatch,
  type SamplingParam,
} from "@ezclaw/core";
import type { DiscoveryParser } from "./catalog.js";

export type ModelKind = "text" | "image" | "other";

export interface DiscoveredModel {
  modelId: string;
  name: string;
  kind: ModelKind;
  /** Profile facts the provider reported; this is the "discovery" layer. */
  patch: ProfilePatch;
  /** Provider data kept for later milestones (pricing, image constraints). Never contains secrets. */
  meta: Record<string, unknown>;
}

/** Path of the model list, relative to the endpoint base URL. */
export function listPath(parser: DiscoveryParser): string {
  return parser === "anthropic" ? "/v1/models?limit=1000" : "/models";
}

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function modalities(v: unknown): Modality[] {
  const known = new Set<string>(MODALITIES);
  return asArray(v).filter((m): m is Modality => typeof m === "string" && known.has(m));
}

export class DiscoveryParseError extends Error {}

/** Turns one provider's model list response into discovered models. Unknown shapes throw. */
export function parseModelList(parser: DiscoveryParser, json: unknown): DiscoveredModel[] {
  const root = asRecord(json);
  const data = root ? asArray(root.data) : [];
  if (!root || !Array.isArray(root.data)) {
    throw new DiscoveryParseError("Respons daftar model tidak berbentuk { data: [...] }.");
  }
  const parse = PARSERS[parser];
  const out: DiscoveredModel[] = [];
  for (const entry of data) {
    const item = asRecord(entry);
    if (!item) continue;
    const parsed = parse(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

const PARSERS: Record<DiscoveryParser, (item: Json) => DiscoveredModel | null> = {
  openai: parseOpenAI,
  openrouter: parseOpenRouter,
  venice: parseVenice,
  anthropic: parseAnthropic,
};

function parseOpenAI(item: Json): DiscoveredModel | null {
  const raw = asString(item.id);
  if (!raw) return null;
  // Gemini's compatibility layer prefixes ids with "models/".
  const modelId = raw.replace(/^models\//, "");
  return { modelId, name: modelId, kind: "text", patch: {}, meta: {} };
}

const OPENROUTER_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const OPENROUTER_BUDGET_PREFIXES = ["anthropic/", "google/", "qwen/"];

function samplingFromSupported(supported: Set<string>, defaults: Json | null): ProfilePatch["sampling"] {
  const out: NonNullable<ProfilePatch["sampling"]> = {};
  for (const param of SAMPLING_PARAMS) {
    if (!supported.has(param)) {
      out[param] = null;
      continue;
    }
    const spec: NumberSpec = { ...SAMPLING_SPEC_DEFAULTS[param] };
    const d = defaults ? asNumber(defaults[param]) : null;
    if (d !== null) spec.default = d;
    out[param] = spec;
  }
  return out;
}

function parseOpenRouter(item: Json): DiscoveredModel | null {
  const modelId = asString(item.id);
  if (!modelId) return null;
  const arch = asRecord(item.architecture);
  const input = modalities(arch?.input_modalities);
  const output = modalities(arch?.output_modalities);
  const supported = new Set(asArray(item.supported_parameters).filter((p): p is string => typeof p === "string"));
  const top = asRecord(item.top_provider);

  const patch: ProfilePatch = {
    inputModalities: input.length ? input : ["text"],
    outputModalities: output.length ? output : ["text"],
    contextLength: asNumber(item.context_length),
    maxOutputTokens: asNumber(top?.max_completion_tokens),
    tools: supported.has("tools"),
    stop: supported.has("stop"),
    seed: supported.has("seed"),
    jsonMode: supported.has("response_format"),
    sampling: samplingFromSupported(supported, asRecord(item.default_parameters)),
  };

  if (supported.has("reasoning") || supported.has("include_reasoning")) {
    const withBudget = OPENROUTER_BUDGET_PREFIXES.some((p) => modelId.startsWith(p));
    patch.reasoning = {
      style: "openrouter",
      canDisable: true,
      efforts: OPENROUTER_EFFORTS,
      defaultEffort: "medium",
      lockedWhileActive: [],
      ...(withBudget ? { budget: { min: 1024, max: 32000, step: 256 } } : {}),
    };
  } else {
    patch.reasoning = { style: "none" };
  }

  const isImageOut = output.includes("image") && !output.includes("text");
  return {
    modelId,
    name: asString(item.name) ?? modelId,
    kind: isImageOut ? "image" : output.includes("text") || output.length === 0 ? "text" : "other",
    patch,
    meta: { pricing: item.pricing ?? null },
  };
}

function parseVenice(item: Json): DiscoveredModel | null {
  const modelId = asString(item.id);
  const type = asString(item.type);
  if (!modelId || (type !== "text" && type !== "image")) return null;
  const spec = asRecord(item.model_spec);
  const name = asString(spec?.name) ?? modelId;
  const meta: Record<string, unknown> = { constraints: spec?.constraints ?? null, pricing: spec?.pricing ?? null };

  if (type === "image") {
    return {
      modelId,
      name,
      kind: "image",
      patch: { inputModalities: ["text"], outputModalities: ["image"], tools: false },
      meta,
    };
  }

  const caps = asRecord(spec?.capabilities);
  const constraints = asRecord(spec?.constraints);
  const input: Modality[] = ["text"];
  if (caps?.supportsVision === true) input.push("image");

  const patch: ProfilePatch = {
    inputModalities: input,
    outputModalities: ["text"],
    contextLength: asNumber(spec?.availableContextTokens) ?? asNumber(item.context_length),
    maxOutputTokens: asNumber(spec?.maxCompletionTokens),
    tools: caps?.supportsFunctionCalling === true,
    jsonMode: caps?.supportsResponseSchema === true,
    maxTokensField: "max_completion_tokens",
  };

  const sampling: NonNullable<ProfilePatch["sampling"]> = {};
  for (const param of ["temperature", "top_p"] as SamplingParam[]) {
    const d = asNumber(asRecord(constraints?.[param])?.default);
    if (d !== null) sampling[param] = { ...SAMPLING_SPEC_DEFAULTS[param], default: d };
  }
  if (Object.keys(sampling).length) patch.sampling = sampling;

  if (caps?.supportsReasoning === true) {
    patch.reasoning = {
      style: "venice",
      canDisable: true,
      defaultOn: true,
      efforts: caps.supportsReasoningEffort === true ? ["low", "medium", "high"] : [],
      defaultEffort: "medium",
      lockedWhileActive: [],
    };
  } else {
    patch.reasoning = { style: "none" };
  }
  return { modelId, name, kind: "text", patch, meta };
}

function parseAnthropic(item: Json): DiscoveredModel | null {
  const modelId = asString(item.id);
  if (!modelId) return null;
  const caps = asRecord(item.capabilities);
  const supports = (v: unknown): boolean => asRecord(v)?.supported === true;

  const input: Modality[] = ["text"];
  if (supports(caps?.image_input)) input.push("image");
  if (supports(caps?.pdf_input)) input.push("file");

  const patch: ProfilePatch = {
    inputModalities: input,
    outputModalities: ["text"],
    contextLength: asNumber(item.max_input_tokens),
    maxOutputTokens: asNumber(item.max_tokens),
  };

  const thinking = asRecord(caps?.thinking);
  if (thinking?.supported === true) {
    const types = asRecord(thinking.types);
    const effort = asRecord(caps?.effort);
    const efforts = ["low", "medium", "high", "xhigh", "max"].filter((level) => supports(effort?.[level]));
    const adaptive = supports(types?.adaptive);
    patch.reasoning = {
      style: adaptive ? "anthropic-adaptive" : "anthropic-budget",
      canDisable: types ? supports(types.disabled) : true,
      efforts: adaptive ? efforts : [],
      ...(adaptive ? {} : { budget: { min: 1024, max: 64000, step: 256, default: 8000 } }),
      lockedWhileActive: [],
    };
  } else if (thinking) {
    patch.reasoning = { style: "none" };
  }

  return { modelId, name: asString(item.display_name) ?? modelId, kind: "text", patch, meta: { lifecycle: item.lifecycle ?? null } };
}
