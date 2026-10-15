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

export type ApprovalKind = "shell" | "write" | "edit" | "outside";

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

/** A harness: the system prompt, tools, and loop settings that turn a model into an agent. */
export const harnessProfileSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(60),
  description: z.string().max(400),
  builtin: z.boolean(),
  /** Which kind of thread it is for. */
  mode: z.enum(["chat", "agent"]),
  /** Prompt template. Variables: {{date}} {{os}} {{shell}} {{workspace}} {{approval}}. */
  systemPrompt: z.string().max(60_000),
  /** Take the instructions from the owner's Codex install (models.json) instead of `systemPrompt`. */
  fromCodex: z.boolean(),
  tools: z.array(z.string().max(60)).max(40),
  loop: loopSchema,
  /** Files read from the workspace (and its parent folders) and added to the prompt. */
  projectInstructions: z.array(z.string().min(1).max(80)).max(8),
});
export type HarnessProfile = z.infer<typeof harnessProfileSchema>;

export const harnessProfilePatchSchema = harnessProfileSchema
  .omit({ id: true, builtin: true, mode: true })
  .partial()
  .extend({ loop: loopSchema.partial().optional() })
  .strict();
export type HarnessProfilePatch = z.infer<typeof harnessProfilePatchSchema>;

export interface HarnessListResponse {
  profiles: HarnessProfile[];
  /** Names of every tool EZClaw can offer, for the profile editor. */
  tools: { name: string; description: string; readOnly: boolean }[];
}
