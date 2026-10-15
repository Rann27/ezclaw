import { z } from "zod";
import type { CapabilityProfile, ImageSpec, Modality, ProfilePatch, Provenance, ReasoningStyle } from "./capabilities.js";
import { profilePatchSchema } from "./capabilities.js";
import type { ChatParams, MessageDto } from "./chat.js";
import { chatParamsSchema } from "./chat.js";
import { imageParamsSchema, imageReferenceSchema, keepIdSchema, type ImageParams } from "./image.js";
import { approvalModeSchema, threadHarnessSchema, type ApprovalMode, type PlanItem, type ThreadHarness } from "./agent.js";

export const authSchema = z.object({
  type: z.enum(["bearer", "header", "none"]),
  headerName: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9-]+$/, "Nama header hanya boleh huruf, angka, dan tanda hubung.").optional(),
});
export type AuthDto = z.infer<typeof authSchema>;

export const PROTOCOLS = ["openai-chat", "openai-responses", "anthropic"] as const;
export const protocolSchema = z.enum(PROTOCOLS);
export const PROTOCOL_LABELS: Record<(typeof PROTOCOLS)[number], string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
};

const headerNameRe = /^[A-Za-z0-9-]+$/;

export const endpointInputSchema = z
  .object({
    name: z.string().trim().min(1, "Nama wajib diisi.").max(60),
    /** Catalog preset id, or "custom". */
    presetId: z.string().trim().min(1).max(40),
    protocol: protocolSchema,
    baseUrl: z
      .string()
      .trim()
      .url("Base URL tidak valid.")
      .refine((u) => /^https?:\/\//i.test(u), "Base URL harus diawali http:// atau https://.")
      .refine((u) => {
        try {
          const url = new URL(u);
          return !url.username && !url.password && !url.search && !url.hash;
        } catch {
          return false;
        }
      }, "Base URL tidak boleh berisi kredensial, query, atau fragment."),
    auth: authSchema,
    /** For custom endpoints: which provider's parameter rules to borrow. */
    family: z.string().trim().max(40).nullable().optional(),
    extraHeaders: z
      .record(z.string(), z.string())
      .refine((h) => Object.keys(h).every((k) => headerNameRe.test(k)), "Nama header tidak valid.")
      .optional(),
    /** Only on create; use PUT /endpoints/:id/key afterwards. */
    apiKey: z.string().trim().min(1).max(4096).optional(),
  })
  .refine((v) => v.auth.type !== "header" || !!v.auth.headerName, { message: "Nama header wajib diisi untuk auth header.", path: ["auth", "headerName"] });
export type EndpointInput = z.infer<typeof endpointInputSchema>;

export const endpointPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    baseUrl: endpointInputSchema.shape.baseUrl,
    auth: authSchema,
    family: z.string().trim().max(40).nullable(),
    extraHeaders: z.record(z.string(), z.string()),
  })
  .partial()
  .strict();
export type EndpointPatch = z.infer<typeof endpointPatchSchema>;

export const keyInputSchema = z.object({ key: z.string().trim().min(1, "Key kosong.").max(4096) });

export interface EndpointDto {
  id: string;
  name: string;
  kind: "provider" | "gateway" | "local" | "custom";
  presetId: string;
  family: string | null;
  protocol: (typeof PROTOCOLS)[number];
  baseUrl: string;
  auth: AuthDto;
  extraHeaders: Record<string, string>;
  needsKey: boolean;
  hasKey: boolean;
  keyLast4: string | null;
  modelCount: number;
  lastTest: { at: string; ok: boolean; message: string } | null;
}

export interface CatalogPresetDto {
  id: string;
  name: string;
  kind: EndpointDto["kind"];
  protocol: EndpointDto["protocol"];
  /** Protocols this provider accepts, the preferred one first. */
  protocols: EndpointDto["protocol"][];
  baseUrl: string;
  regions: { id: string; label: string; baseUrl: string }[];
  auth: AuthDto;
  needsKey: boolean;
  docsUrl: string | null;
  notes: string[];
}

export interface CatalogResponse {
  presets: CatalogPresetDto[];
  families: { id: string; name: string }[];
}

export interface EndpointListResponse {
  endpoints: EndpointDto[];
}

export interface EndpointTestResponse {
  ok: boolean;
  message: string;
  modelCount: number;
  /** True when the provider's model list was unavailable and suggested models were used instead. */
  usedSuggestions: boolean;
}

export interface ModelSummary {
  inputModalities: Modality[];
  outputModalities: Modality[];
  tools: boolean;
  reasoning: boolean;
  reasoningStyle: ReasoningStyle;
  contextLength: number | null;
}

export interface ModelDto {
  id: string;
  endpointId: string;
  endpointName: string;
  endpointKind: EndpointDto["kind"];
  modelId: string;
  name: string;
  alias: string | null;
  favorite: boolean;
  source: "discovered" | "manual" | "suggested";
  kind: "text" | "image" | "other";
  summary: ModelSummary;
  hasOverride: boolean;
  omitCount: number;
}

export interface ModelListResponse {
  models: ModelDto[];
}

export interface ModelProfileResponse {
  model: ModelDto;
  profile: CapabilityProfile;
  provenance: Provenance;
  omit: string[];
  override: ProfilePatch | null;
  /** For image models: the wire and limits in effect (defaults merged with what is known). */
  imageSpec: ImageSpec | null;
  /** Which curated preset files matched, for the "Inspect profile" view. */
  presetSources: { source: string; checked: string }[];
}

export const modelPatchSchema = z
  .object({
    alias: z.string().trim().max(60).nullable(),
    favorite: z.boolean(),
    /** Whether the model answers in text or makes images; manual and discovered models can be wrong. */
    kind: z.enum(["text", "image"]),
    override: profilePatchSchema.nullable(),
    /** Replaces the learned list; used to clear entries. */
    omit: z.array(z.string()),
  })
  .partial()
  .strict();
export type ModelPatch = z.infer<typeof modelPatchSchema>;

export const manualModelSchema = z.object({
  modelId: z.string().trim().min(1, "ID model wajib diisi.").max(200),
  name: z.string().trim().max(100).optional(),
  /** Models added by hand are text models unless said otherwise. */
  kind: z.enum(["text", "image"]).optional(),
});

/* ------------------------------------------------------------------ threads */

export const threadCreateSchema = z.object({
  mode: z.enum(["chat", "agent", "image", "edit"]),
  modelId: z.string().optional(),
  /** Agent threads: absolute path of the folder to work in. */
  workspace: z.string().trim().min(1).max(1000).optional(),
  approvalMode: approvalModeSchema.optional(),
  harness: threadHarnessSchema.optional(),
});

export const threadPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    pinned: z.boolean(),
    archived: z.boolean(),
    modelId: z.string().nullable(),
    systemPrompt: z.string().max(20000),
    params: chatParamsSchema,
    workspace: z.string().trim().min(1).max(1000),
    approvalMode: approvalModeSchema,
    /** Required (true) to switch to the automatic mode, so it cannot happen by accident. */
    confirmFull: z.boolean(),
    harness: threadHarnessSchema,
    imageParams: imageParamsSchema,
  })
  .partial()
  .strict();
export type ThreadPatch = z.infer<typeof threadPatchSchema>;

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1, "Pesan kosong.").max(200_000),
  /** The model, system prompt and params currently shown in the UI; saved to the thread. */
  modelId: z.string().min(1),
  systemPrompt: z.string().max(20000).optional(),
  params: chatParamsSchema.optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const sendImageSchema = z.object({
  text: z.string().trim().min(1, "Prompt kosong.").max(30_000),
  modelId: z.string().min(1),
  references: z.array(imageReferenceSchema).max(16).default([]),
  params: imageParamsSchema.optional(),
  /** Send the text exactly as written: no Prompt Composer, no reference template (used to resend an edited prompt). */
  exact: z.boolean().optional(),
});
export type SendImageInput = z.infer<typeof sendImageSchema>;

/** One edit: the image to change, references with roles, what to keep, and the instruction. */
export const sendEditSchema = z.object({
  text: z.string().trim().min(1, "Instruksi kosong.").max(30_000),
  modelId: z.string().min(1),
  /** Asset to edit; an upload, a result from Image, or a version from an earlier edit. */
  target: z.string().min(1).max(80),
  references: z.array(imageReferenceSchema).max(15).default([]),
  keep: z.array(keepIdSchema).max(5).default([]),
  params: imageParamsSchema.optional(),
  /** Send the text exactly as written, with the images in order: no template, no Prompt Composer. */
  exact: z.boolean().optional(),
});
export type SendEditInput = z.infer<typeof sendEditSchema>;

export interface AssetDto {
  id: string;
  kind: "upload" | "generated";
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface ThreadDetailDto {
  id: string;
  mode: "chat" | "agent" | "image" | "edit";
  title: string;
  pinned: boolean;
  modelId: string | null;
  systemPrompt: string;
  params: ChatParams;
  imageParams: ImageParams;
  workspace: string | null;
  approvalMode: ApprovalMode;
  harness: ThreadHarness;
  plan: PlanItem[];
  /** Message sequence up to which history was compacted into a summary, 0 if never. */
  summarySeq: number;
  messages: MessageDto[];
  activeRun: { runId: string; messageId: string } | null;
}

export interface SendMessageResponse {
  runId: string;
  userMessageId: string;
  /** Chat: the answer being written. Agent runs create their messages step by step, so this is null. */
  assistantMessageId: string | null;
}

export interface RequestLogDto {
  attempt: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  status: number | null;
  responseText: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: string;
}

export interface RequestLogResponse {
  logs: RequestLogDto[];
}

export interface ApprovalRuleDto {
  id: string;
  pattern: string[];
}

export interface CodexStatusResponse {
  ok: boolean;
  message: string;
  models: string[];
}

export const codexDirSchema = z.object({ dir: z.string().trim().min(1).max(1000) });

export const workspaceCheckSchema = z.object({ path: z.string().trim().min(1).max(1000) });

export interface WorkspaceCheckResponse {
  ok: boolean;
  /** The folder as it resolves on disk, when ok. */
  root?: string;
  message?: string;
}

export interface RecentWorkspacesResponse {
  workspaces: string[];
}
