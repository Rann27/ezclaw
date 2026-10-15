import { z } from "zod";
import type { ImageTurnMeta } from "./image.js";

/**
 * Canonical message format. Every thread is stored this way and converted per protocol when sent.
 * Tool use is a pair: an assistant message holding `tool_call` parts, then a `tool` message
 * holding the matching `tool_result` parts.
 */
export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string; signature?: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown; /** Set when the model's arguments were not valid JSON. */ argsError?: string }
  | { type: "tool_result"; callId: string; name: string; output: string; isError?: boolean; denied?: boolean }
  /** A stored image (an asset), uploaded as a reference or produced by an image model. */
  | { type: "image"; assetId: string; role?: string; seed?: number };

/**
 * The assistant turn exactly as the provider produced it, in that protocol's own format.
 * Replaying it unchanged keeps signatures, encrypted reasoning, and reasoning_content intact,
 * which several providers require when tools are used.
 */
export interface RawTurn {
  protocol: string;
  data: unknown;
}

export interface CanonicalMessage {
  role: "user" | "assistant" | "tool";
  parts: Part[];
  raw?: RawTurn;
}

export const reasoningRequestSchema = z.object({
  /** default: send nothing about reasoning. off: ask the model not to think. on: think, at `effort` or `budgetTokens`. */
  mode: z.enum(["default", "off", "on"]),
  effort: z.string().optional(),
  budgetTokens: z.number().int().positive().optional(),
});
export type ReasoningRequest = z.infer<typeof reasoningRequestSchema>;

export const chatParamsSchema = z
  .object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    min_p: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    repetition_penalty: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    seed: z.number().int().optional(),
    stop: z.array(z.string()).max(8).optional(),
    reasoning: reasoningRequestSchema.optional(),
    /** Values for the model's provider-specific options, keyed by ExtraParamSpec.key. */
    extras: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
    /** Merged into the request body last, for parameters EZClaw does not know yet. */
    extraBody: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ChatParams = z.infer<typeof chatParamsSchema>;

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  /** Cost in USD when the provider reports it (OpenRouter does). */
  costUsd?: number;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

/** What adapters emit while a response streams. */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_signature"; signature: string }
  /** A finished tool call. `argsText` is the raw JSON the model wrote. */
  | { type: "tool_call"; callId: string; name: string; argsText: string }
  | { type: "raw"; raw: RawTurn }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: FinishReason };

export interface DroppedParam {
  param: string;
  reason: string;
}

export const MESSAGE_STATUSES = ["streaming", "complete", "stopped", "error"] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export interface MessageDto {
  id: string;
  seq: number;
  role: "user" | "assistant" | "tool";
  parts: Part[];
  status: MessageStatus;
  error: string | null;
  notes: string[];
  usage: Usage | null;
  finishReason: FinishReason | null;
  /** "Endpoint name / model id" at the time the answer was generated. */
  modelLabel: string | null;
  durationMs: number | null;
  /** For image turns: what was sent and with which settings. */
  image: ImageTurnMeta | null;
  createdAt: string;
}
