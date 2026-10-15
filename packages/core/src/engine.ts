import { SAMPLING_PARAMS, type CapabilityProfile, type ExtraParamSpec, type ReasoningSpec, type SamplingParam } from "./capabilities.js";
import type { ToolChoice, ToolDef } from "./agent.js";
import type { CanonicalMessage, ChatParams, DroppedParam, ReasoningRequest } from "./chat.js";
import type { Protocol } from "./profile.js";
import { toAnthropicMessages, toOpenAIChatMessages, toResponsesInput } from "./wire.js";

/* ---------------------------------------------------------------- reasoning */

export interface ReasoningState {
  /** Whether the model will reason for this request. Drives which sampling controls are locked. */
  active: boolean;
  /** What to put on the wire: nothing, an explicit off, or an explicit on. */
  send: "nothing" | "off" | "on";
  effort?: string;
  budgetTokens?: number;
  notes: string[];
}

export function pickEffort(spec: ReasoningSpec, requested?: string): string | undefined {
  if (requested && spec.efforts.includes(requested)) return requested;
  if (spec.defaultEffort && spec.efforts.includes(spec.defaultEffort)) return spec.defaultEffort;
  return spec.efforts[Math.floor(spec.efforts.length / 2)];
}

export function resolveReasoning(profile: CapabilityProfile, request: ReasoningRequest | undefined): ReasoningState {
  const spec = profile.reasoning;
  const mode = request?.mode ?? "default";
  const notes: string[] = [];

  if (spec.style === "none") {
    if (mode !== "default") notes.push("Model ini tidak punya kontrol reasoning, pengaturan reasoning diabaikan.");
    return { active: spec.defaultOn, send: "nothing", notes };
  }

  if (mode === "default") return { active: spec.defaultOn, send: "nothing", notes };

  if (mode === "off") {
    if (!spec.canDisable) {
      notes.push("Model ini tidak bisa dimatikan reasoning-nya, permintaan 'off' diabaikan.");
      return { active: true, send: "nothing", notes };
    }
    return { active: false, send: "off", notes };
  }

  let budgetTokens = request?.budgetTokens;
  if (budgetTokens !== undefined && spec.budget) {
    const clamped = Math.min(spec.budget.max, Math.max(spec.budget.min, budgetTokens));
    if (clamped !== budgetTokens) notes.push(`Budget reasoning disesuaikan ke ${clamped} (rentang model ${spec.budget.min} sampai ${spec.budget.max}).`);
    budgetTokens = clamped;
  } else if (budgetTokens !== undefined) {
    budgetTokens = undefined;
  }
  const effort = spec.efforts.length ? pickEffort(spec, request?.effort) : undefined;
  if (request?.effort && effort && request.effort !== effort) {
    notes.push(`Effort "${request.effort}" tidak didukung model ini, memakai "${effort}".`);
  }
  return { active: true, send: "on", effort, budgetTokens, notes };
}

/* ------------------------------------------------------------ parameter panel */

export interface SamplingControl {
  param: SamplingParam;
  spec: { min: number; max: number; step: number; default?: number };
  locked: boolean;
  lockReason?: string;
}

export interface ParamPanel {
  reasoning: {
    available: boolean;
    style: ReasoningSpec["style"];
    canDisable: boolean;
    defaultOn: boolean;
    efforts: string[];
    effort?: string;
    budget?: ReasoningSpec["budget"];
    /** True when the reasoning mode currently chosen will actually reason. */
    active: boolean;
  };
  sampling: SamplingControl[];
  maxOutputTokens: { max: number | null };
  stop: boolean;
  seed: boolean;
  extras: ExtraParamSpec[];
  notes: string[];
}

/** What the parameter panel should render for this model and the current settings. */
export function buildParamPanel(profile: CapabilityProfile, params: ChatParams): ParamPanel {
  const state = resolveReasoning(profile, params.reasoning);
  const spec = profile.reasoning;
  const locked = new Set<SamplingParam>(state.active ? spec.lockedWhileActive : []);

  const sampling: SamplingControl[] = [];
  for (const param of SAMPLING_PARAMS) {
    const s = profile.sampling[param];
    if (!s) continue;
    const isLocked = locked.has(param);
    sampling.push({
      param,
      spec: s,
      locked: isLocked,
      lockReason: isLocked ? (spec.lockReason ?? "Diabaikan oleh model saat reasoning aktif.") : undefined,
    });
  }

  return {
    reasoning: {
      available: spec.style !== "none",
      style: spec.style,
      canDisable: spec.canDisable,
      defaultOn: spec.defaultOn,
      efforts: spec.efforts,
      effort: state.effort,
      budget: spec.budget,
      active: state.active,
    },
    sampling,
    maxOutputTokens: { max: profile.maxOutputTokens },
    stop: profile.stop,
    seed: profile.seed,
    extras: profile.extras,
    notes: profile.notes,
  };
}

/* ------------------------------------------------------------------ requests */

export interface ChatRequestInput {
  protocol: Protocol;
  modelId: string;
  profile: CapabilityProfile;
  params: ChatParams;
  system?: string;
  messages: CanonicalMessage[];
  /** Wire body keys to leave out because this model rejected them before. */
  omit?: string[];
  /** Functions the model may call. Omit for plain chat. */
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
}

export interface BuiltRequest {
  /** Path appended to the endpoint's base URL. */
  path: string;
  body: Record<string, unknown>;
  dropped: DroppedParam[];
  notes: string[];
  reasoning: ReasoningState;
}

const PROTECTED_KEYS = new Set(["model", "messages", "input", "instructions", "tools", "stream", "max_tokens", "system"]);
const DEFAULT_ANTHROPIC_MAX_TOKENS = 16000;
const DEFAULT_ANTHROPIC_BUDGET = 8000;
const MIN_ANTHROPIC_BUDGET = 1024;

export function buildChatRequest(input: ChatRequestInput): BuiltRequest {
  const { protocol, profile, params } = input;
  const dropped: DroppedParam[] = [];
  const notes: string[] = [];
  const reasoning = resolveReasoning(profile, params.reasoning);
  notes.push(...reasoning.notes);

  const body: Record<string, unknown> = { model: input.modelId, stream: true };
  if (protocol === "anthropic") {
    body.messages = toAnthropicMessages(input.messages);
    if (input.system) body.system = input.system;
  } else if (protocol === "openai-responses") {
    body.input = toResponsesInput(input.messages);
    if (input.system) body.instructions = input.system;
  } else {
    body.messages = toOpenAIChatMessages(input.messages, input.system, { systemRole: profile.systemRole, reasoningReplay: profile.reasoningReplay });
    if (profile.streamUsage) body.stream_options = { include_usage: true };
  }
  applyTools(body, protocol, input.tools, input.toolChoice);
  // Stateless reasoning models need their encrypted reasoning back on the next turn (OpenAI, xAI).
  if (protocol === "openai-responses" && profile.reasoning.style === "openai-effort") body.include = ["reasoning.encrypted_content"];

  for (const [key, value] of Object.entries(profile.bodyDefaults)) body[key] = mergeValue(body[key], value);

  const locked = new Set<SamplingParam>(reasoning.active ? profile.reasoning.lockedWhileActive : []);
  for (const param of SAMPLING_PARAMS) {
    const value = params[param];
    if (value === undefined) continue;
    const spec = profile.sampling[param];
    if (!spec || (protocol === "openai-responses" && param !== "temperature" && param !== "top_p")) {
      dropped.push({ param, reason: protocol === "openai-responses" && spec ? "Responses API tidak mendukung parameter ini." : "Tidak didukung model ini." });
      continue;
    }
    if (locked.has(param)) {
      dropped.push({ param, reason: profile.reasoning.lockReason ?? "Diabaikan oleh model saat reasoning aktif." });
      continue;
    }
    const clamped = Math.min(spec.max, Math.max(spec.min, value));
    if (clamped !== value) notes.push(`${param} disesuaikan dari ${value} ke ${clamped} (rentang model ${spec.min} sampai ${spec.max}).`);
    body[param] = clamped;
  }

  if (params.seed !== undefined) {
    if (profile.seed && protocol === "openai-chat") body.seed = params.seed;
    else dropped.push({ param: "seed", reason: "Tidak didukung model ini." });
  }
  if (params.stop?.length) {
    if (!profile.stop || protocol === "openai-responses") dropped.push({ param: "stop", reason: "Tidak didukung model ini." });
    else if (protocol === "anthropic") body.stop_sequences = params.stop;
    else body.stop = params.stop;
  }

  let maxTokens = params.max_output_tokens;
  if (maxTokens !== undefined && profile.maxOutputTokens && maxTokens > profile.maxOutputTokens) {
    notes.push(`max_output_tokens disesuaikan ke ${profile.maxOutputTokens} (batas model).`);
    maxTokens = profile.maxOutputTokens;
  }
  if (protocol === "anthropic") {
    body.max_tokens = maxTokens ?? Math.min(profile.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS, DEFAULT_ANTHROPIC_MAX_TOKENS);
  } else if (maxTokens !== undefined) {
    body[protocol === "openai-responses" ? "max_output_tokens" : profile.maxTokensField] = maxTokens;
  }

  applyReasoning(body, protocol, profile.reasoning, reasoning, dropped, notes);

  for (const extra of profile.extras) {
    const value = params.extras?.[extra.key];
    if (value === undefined) continue;
    setPath(body, extra.path, value);
  }

  if (params.extraBody) {
    const overwritten = Object.keys(params.extraBody).filter((k) => k in body && !PROTECTED_KEYS.has(k));
    if (overwritten.length) notes.push(`Extra body menimpa field yang dikelola EZClaw: ${overwritten.join(", ")}.`);
    for (const key of Object.keys(params.extraBody)) {
      if (PROTECTED_KEYS.has(key)) {
        dropped.push({ param: key, reason: "Field ini dikelola EZClaw dan tidak bisa ditimpa lewat extra body." });
        continue;
      }
      body[key] = mergeValue(body[key], params.extraBody[key]);
    }
  }

  for (const key of input.omit ?? []) {
    if (PROTECTED_KEYS.has(key) || !(key in body)) continue;
    delete body[key];
    dropped.push({ param: key, reason: "Ditolak model ini sebelumnya, tidak dikirim lagi." });
  }

  return {
    path: protocol === "anthropic" ? "/v1/messages" : protocol === "openai-responses" ? "/responses" : "/chat/completions",
    body,
    dropped,
    notes,
    reasoning,
  };
}

function applyReasoning(
  body: Record<string, unknown>,
  protocol: Protocol,
  spec: ReasoningSpec,
  state: ReasoningState,
  dropped: DroppedParam[],
  notes: string[],
) {
  const { send, effort, budgetTokens } = state;

  // The Responses API has one reasoning object whatever the provider calls its own switch.
  if (protocol === "openai-responses" && spec.style !== "none") {
    if (send === "on") {
      body.reasoning = { ...(effort ? { effort } : {}), ...(spec.style === "openai-effort" ? { summary: "auto" } : {}) };
    } else if (send === "off") {
      body.reasoning = { effort: "none" };
    } else if (spec.style === "openai-effort" && spec.defaultOn) {
      body.reasoning = { summary: "auto" };
    }
    return;
  }

  switch (spec.style) {
    case "none":
      return;

    case "openai-effort":
      if (send === "on" && effort) body.reasoning_effort = effort;
      else if (send === "off") body.reasoning_effort = spec.efforts.includes("none") ? "none" : "minimal";
      return;

    case "openrouter":
      if (send === "on") {
        if (budgetTokens !== undefined) body.reasoning = { max_tokens: budgetTokens };
        else if (effort) body.reasoning = { effort };
        else body.reasoning = { enabled: true };
      } else if (send === "off") body.reasoning = { effort: "none" };
      return;

    case "deepseek":
      if (send === "on") {
        body.thinking = { type: "enabled" };
        if (effort) body.reasoning_effort = effort;
      } else if (send === "off") body.thinking = { type: "disabled" };
      return;

    case "zai":
      if (send === "on") body.thinking = { type: "enabled" };
      else if (send === "off") body.thinking = { type: "disabled" };
      return;

    case "qwen":
      if (send === "on") {
        body.enable_thinking = true;
        if (budgetTokens !== undefined) body.thinking_budget = budgetTokens;
      } else if (send === "off") body.enable_thinking = false;
      return;

    case "venice":
      if (send === "on" && effort) body.reasoning_effort = effort;
      else if (send === "off") setPath(body, "venice_parameters.disable_thinking", true);
      return;

    case "anthropic-adaptive": {
      // Claude 5.x thinks by default but hides the text unless display is "summarized".
      const wantText = send === "on" || (send === "nothing" && spec.defaultOn);
      if (send === "off") body.thinking = { type: "disabled" };
      else if (wantText) body.thinking = { type: "adaptive", display: "summarized" };
      if (send === "on" && effort) body.output_config = { effort };
      return;
    }

    case "anthropic-budget": {
      if (send !== "on") {
        if (send === "off") body.thinking = { type: "disabled" };
        return;
      }
      const maxTokens = body.max_tokens as number;
      let budget = budgetTokens ?? DEFAULT_ANTHROPIC_BUDGET;
      if (budget >= maxTokens) budget = maxTokens - 1;
      if (budget < MIN_ANTHROPIC_BUDGET) {
        dropped.push({
          param: "reasoning",
          reason: `Budget reasoning minimal ${MIN_ANTHROPIC_BUDGET} token dan harus lebih kecil dari max_tokens (${maxTokens}). Naikkan max_output_tokens.`,
        });
        return;
      }
      if (budget !== (budgetTokens ?? DEFAULT_ANTHROPIC_BUDGET)) notes.push(`Budget reasoning diturunkan ke ${budget} karena harus lebih kecil dari max_tokens.`);
      body.thinking = { type: "enabled", budget_tokens: budget };
      return;
    }
  }
}

/* ----------------------------------------------------------------------- tools */

function applyTools(body: Record<string, unknown>, protocol: Protocol, tools: ToolDef[] | undefined, choice: ToolChoice | undefined) {
  if (!tools?.length) return;
  if (protocol === "anthropic") {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (choice === "required") body.tool_choice = { type: "any" };
    else if (choice === "none") body.tool_choice = { type: "none" };
    return;
  }
  if (protocol === "openai-responses") {
    body.tools = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  } else {
    body.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (choice) body.tool_choice = choice;
}

/* ------------------------------------------------------------------ helpers */

export function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (last) node[last] = value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeValue(base: unknown, incoming: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(incoming)) return incoming;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(incoming)) out[k] = mergeValue(out[k], v);
  return out;
}

/**
 * Finds which top-level request field a 400 error blames, so the field can be dropped and
 * the request retried once. Returns null when the error does not clearly name one.
 */
export function findRejectedKey(opts: { message: string; param?: string | null; bodyKeys: string[] }): string | null {
  const keys = new Set(opts.bodyKeys.filter((k) => !PROTECTED_KEYS.has(k)));
  const topLevel = (token: string): string | null => {
    const first = token.split(".")[0] ?? "";
    return keys.has(first) ? first : null;
  };

  if (opts.param) {
    const hit = topLevel(opts.param);
    if (hit) return hit;
  }

  const patterns = [
    /['"`]([A-Za-z_][\w.]*)['"`]/g,
    /(?:parameter|argument|field|param|property)s?\b[^:\n'"`]{0,24}:\s*([A-Za-z_][\w.]*)/gi,
    /(?:parameter|argument|field|param|property)s?\s+([A-Za-z_][\w.]*)/gi,
    /^([A-Za-z_][\w.]*):\s/g,
  ];
  const found: { index: number; key: string }[] = [];
  for (const pattern of patterns) {
    for (const match of opts.message.matchAll(pattern)) {
      const key = topLevel(match[1] ?? "");
      if (key) found.push({ index: match.index ?? 0, key });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return found[0]?.key ?? null;
}
