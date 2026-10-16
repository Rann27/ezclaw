import { z } from "zod";
import type { FinishReason, Usage } from "./chat.js";

/** A function the model may call. `parameters` is a JSON Schema object. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolChoice = "auto" | "none" | "required";

/** How much the agent may do without asking. Shown to the owner as "Tanya dulu", "Edit otomatis", "Otomatis penuh". */
export const APPROVAL_MODES = ["ask", "edit", "full"] as const;
export const approvalModeSchema = z.enum(APPROVAL_MODES);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "Tanya dulu",
  edit: "Edit otomatis",
  full: "Otomatis penuh",
};

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

/** "web" is a request that sends something off this computer (a page fetch or a search). */
export type ApprovalKind = "shell" | "write" | "edit" | "outside" | "web";

/** What the owner is asked to allow. */
export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  /** Shell: the command as written. */
  command?: string;
  cwd?: string;
  /** Write/edit: the file, relative to the workspace when inside it. */
  path?: string;
  /** Write/edit: unified-style preview of the change. */
  diff?: string;
  /** Why this needs a decision even in an automatic mode. */
  reason?: string;
  /** Pattern that "allow always" would remember, as argument words. */
  rulePattern?: string[];
}

export const approvalDecisionSchema = z.object({
  decision: z.enum(["allow", "allow_always", "deny"]),
  /** Sent to the model when denying. */
  reason: z.string().max(2000).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const askAnswerSchema = z.object({ answer: z.string().trim().min(1, "Jawaban kosong.").max(20000) });

export type RunStopReason = "max_steps" | "blocked";

/** Events a client sees on a run's SSE stream. */
export type RunEvent =
  | { type: "start"; messageId: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "note"; text: string }
  | { type: "usage"; usage: Usage }
  /** A new model call begins; `messageId` is the assistant message it will be saved as. */
  | { type: "step_start"; messageId: string; step: number }
  | { type: "step_end"; messageId: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown; argsError?: string }
  | { type: "tool_start"; callId: string }
  | { type: "tool_result"; callId: string; name: string; ok: boolean; output: string; denied?: boolean; truncated?: boolean; durationMs: number }
  | { type: "approval"; approvalId: string; callId: string; request: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string; decision: "allow" | "allow_always" | "deny" }
  | { type: "ask"; askId: string; callId: string; question: string; options?: string[] }
  | { type: "ask_resolved"; askId: string }
  | { type: "plan"; items: PlanItem[] }
  /** The model proposed something to remember; it waits for the owner. */
  | { type: "memory_proposed"; memoryId: string; text: string; scope: "global" | "workspace" }
  /** Files changed in this run were recorded, so the run can be undone. */
  | { type: "checkpoint"; files: number }
  | { type: "context"; usedTokens: number; windowTokens: number | null }
  | { type: "compaction"; before: number; after: number }
  /** One image of an image run changed state. Failed slots carry their reason. */
  | { type: "image_slot"; index: number; status: "queued" | "running" | "done" | "error"; assetId?: string; seed?: number; error?: string }
  /** The Prompt Composer turned the conversation into the prompt that is sent. */
  | { type: "composed"; prompt: string; useLastImage: boolean }
  | { type: "done"; status: "complete" | "stopped" | "error"; finishReason?: FinishReason; error?: string; stopReason?: RunStopReason };

export interface AgentLoopConfig {
  maxSteps: number;
  /** Tool output longer than this many characters keeps its head and tail. */
  toolOutputLimit: number;
  /** Compact the conversation when the estimated context passes this share of the window. */
  compactAt: number;
  shellTimeoutMs: number;
}

export const DEFAULT_LOOP: AgentLoopConfig = {
  maxSteps: 60,
  toolOutputLimit: 40_000,
  compactAt: 0.8,
  shellTimeoutMs: 120_000,
};

/** Per-thread harness choice. `tools` is used only while the harness is off. */
export interface ThreadHarness {
  on: boolean;
  profileId: string;
  tools: string[];
}

export const threadHarnessSchema = z.object({
  on: z.boolean(),
  profileId: z.string().min(1).max(80),
  tools: z.array(z.string().max(60)).max(40),
});

const loopSchema = z.object({
  maxSteps: z.number().int().min(1).max(500),
  toolOutputLimit: z.number().int().min(1000).max(400_000),
  compactAt: z.number().min(0.3).max(0.95),
  shellTimeoutMs: z.number().int().min(1000).max(600_000),
});

/**
 * One part of a wrapper prompt: who the model is, how it works, how it talks, and so on. Segments are
 * joined in order; the owner can switch each one off or rewrite it without touching the rest.
 */
export const harnessSegmentSchema = z.object({
  id: z.string().min(1).max(60),
  /** Shown in the editor, and used as the tag name when the profile wraps segments in tags. */
  title: z.string().trim().min(1).max(80),
  /** What this part is for, in the owner's words. Never sent to the model. */
  purpose: z.string().max(300),
  enabled: z.boolean(),
  /** Variables: {{date}} {{os}} {{shell}} {{workspace}} {{approval}} {{model}}. */
  content: z.string().max(60_000),
  /** Changes between requests (date, folder, mode). Sent after everything stable so the prompt prefix can be cached. */
  dynamic: z.boolean().default(false),
  /**
   * Where the text goes. "system": the system prompt (instructions). "developer": its own developer
   * message after the system prompt, the way Codex sends permissions. "context": a user message
   * placed just before the owner's latest message, the way Codex sends AGENTS.md and <environment_context>.
   */
  placement: z.enum(["system", "developer", "context"]).default("system"),
});
export const SEGMENT_PLACEMENTS = ["system", "developer", "context"] as const;
export type SegmentPlacement = (typeof SEGMENT_PLACEMENTS)[number];
export type HarnessSegment = z.infer<typeof harnessSegmentSchema>;

export const SEGMENT_WRAPS = ["plain", "tags"] as const;
export const segmentWrapSchema = z.enum(SEGMENT_WRAPS);
export type SegmentWrap = z.infer<typeof segmentWrapSchema>;

/** A harness: the wrapper prompt, tools, and loop settings that turn a model into an agent (or steady a chat). */
export const harnessProfileSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(400),
  builtin: z.boolean(),
  /** Which kind of thread it is for. */
  mode: z.enum(["chat", "agent"]),
  /** Where the wording comes from, shown as a label: written for EZClaw, read from Codex, imported, and so on. */
  origin: z.string().max(80).default(""),
  segments: z.array(harnessSegmentSchema).max(60),
  /** "plain" joins segments with blank lines; "tags" wraps each one as <title>...</title>, like Antigravity's wrapper. */
  wrap: segmentWrapSchema.default("plain"),
  /** Take the segments from the owner's Codex install (models.json) each time, instead of storing them. */
  fromCodex: z.boolean(),
  tools: z.array(z.string().max(60)).max(40),
  loop: loopSchema,
  /** Files read from the workspace (and its parent folders) and added to the prompt. */
  projectInstructions: z.array(z.string().min(1).max(80)).max(8),
  /** Add the saved memories to the prompt. */
  memory: z.boolean().default(true),
  /**
   * How project instruction files are sent. "ezclaw": inside the system prompt. "codex": as a context
   * message "# AGENTS.md instructions for <folder>" with the text in <INSTRUCTIONS>, as Codex does.
   */
  instructionsStyle: z.enum(["ezclaw", "codex"]).default("ezclaw"),
  /** Tool descriptions the model sees. "codex" uses Codex's wording and parameters for the tools Codex also has. */
  toolStyle: z.enum(["ezclaw", "codex"]).default("ezclaw"),
  /** Wrap the owner's messages in this tag, e.g. USER_REQUEST for a wrapper that says requests arrive as <USER_REQUEST>. */
  userTag: z.string().regex(/^[A-Za-z_][\w-]*$/).max(40).nullable().default(null),
});
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

export const harnessProfilePatchSchema = harnessProfileSchema
  .omit({ id: true, builtin: true, mode: true })
  .partial()
  // Fields with defaults are redeclared without them, so a patch never resets what it did not send.
  .extend({
    loop: loopSchema.partial().optional(),
    origin: z.string().max(80).optional(),
    wrap: segmentWrapSchema.optional(),
    memory: z.boolean().optional(),
    instructionsStyle: z.enum(["ezclaw", "codex"]).optional(),
    toolStyle: z.enum(["ezclaw", "codex"]).optional(),
    userTag: z.string().regex(/^[A-Za-z_][\w-]*$/).max(40).nullable().optional(),
  })
  .strict();
export type HarnessProfilePatch = z.infer<typeof harnessProfilePatchSchema>;

/** Turns any wrapper text into a new profile, split into segments by its tags or headings. */
export const harnessImportSchema = z.object({
  name: z.string().trim().min(1).max(60),
  mode: z.enum(["chat", "agent"]),
  text: z.string().min(1, "Teks wrapper kosong.").max(200_000),
});

export interface HarnessPreviewResponse {
  /** The system prompt as it would be sent now, with the stable part first. */
  text: string;
  /** Developer messages sent right after the system prompt. */
  developer: string[];
  /** Text sent as a user message just before the owner's latest message. */
  context: string;
  /** How the owner's message itself is wrapped, with "…" standing for its text. */
  userMessage: string;
  /** Tools the model is offered, as it sees them. */
  tools: { name: string; description: string }[];
  /** Characters in the part that stays the same between requests, the part a provider can cache. */
  stableChars: number;
  /** Rough token estimate (characters / 4). */
  approxTokens: number;
}

export interface HarnessListResponse {
  profiles: HarnessProfile[];
  /** Names of every tool EZClaw can offer, for the profile editor. */
  tools: { name: string; description: string; readOnly: boolean }[];
}

/* ------------------------------------------------------------------ memory */

/**
 * Something to remember across threads: a preference, a fact about the user or a project. Global
 * memories go to every thread whose wrapper uses memory; workspace memories only to Agent threads in
 * that folder. Models can only propose; a proposal waits until the owner approves it.
 */
export interface MemoryDto {
  id: string;
  text: string;
  scope: "global" | "workspace";
  workspace: string | null;
  status: "active" | "proposed";
  source: "user" | "agent";
  threadId: string | null;
  createdAt: string;
}

export const memoryCreateSchema = z.object({
  text: z.string().trim().min(1, "Memori kosong.").max(1000),
  scope: z.enum(["global", "workspace"]).default("global"),
  workspace: z.string().trim().min(1).max(1000).nullable().optional(),
});

export const memoryPatchSchema = z
  .object({
    text: z.string().trim().min(1).max(1000),
    scope: z.enum(["global", "workspace"]),
    workspace: z.string().trim().min(1).max(1000).nullable(),
    status: z.enum(["active", "proposed"]),
  })
  .partial()
  .strict();

export interface MemoryListResponse {
  memories: MemoryDto[];
}

/* ------------------------------------------------------------- checkpoints */

/** Files an agent run changed, recorded just before the first change, so the run can be undone. */
export interface CheckpointDto {
  /** The user message that started the run. */
  runMessageId: string;
  /** That message's text, shortened. */
  prompt: string;
  createdAt: string;
  restoredAt: string | null;
  files: { path: string; created: boolean; restorable: boolean }[];
}

export interface CheckpointListResponse {
  checkpoints: CheckpointDto[];
}

export interface RestoreResponse {
  restored: string[];
  /** Files that could not be put back, with the reason. */
  skipped: { path: string; reason: string }[];
}

export interface WebSearchStatus {
  provider: "brave" | "tavily" | "exa" | null;
  hasKey: boolean;
}

export const webSearchKeySchema = z.object({
  provider: z.enum(["brave", "tavily", "exa"]),
  key: z.string().trim().min(8, "Key terlalu pendek.").max(400),
});
