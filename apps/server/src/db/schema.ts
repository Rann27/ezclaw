import type { ChatParams, FinishReason, ImageParams, MessageStatus, Part, PlanItem, ProfilePatch, RawTurn, ThreadHarness, Usage } from "@ezclaw/core";
import { MESSAGE_STATUSES, MODES } from "@ezclaw/core";
import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Key/value app settings. Each value is validated against its key's schema on read. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** One connection: base URL, protocol and auth. The API key itself lives in the secret store. */
export const endpoints = sqliteTable("endpoints", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["provider", "gateway", "local", "custom"] }).notNull(),
  presetId: text("preset_id").notNull(),
  /** Provider whose parameter rules apply; null means the preset's own. */
  family: text("family"),
  protocol: text("protocol", { enum: ["openai-chat", "openai-responses", "anthropic"] }).notNull(),
  baseUrl: text("base_url").notNull(),
  authType: text("auth_type", { enum: ["bearer", "header", "none"] }).notNull(),
  authHeader: text("auth_header"),
  extraHeaders: text("extra_headers", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
  keyLast4: text("key_last4"),
  lastTestAt: integer("last_test_at", { mode: "timestamp_ms" }),
  lastTestOk: integer("last_test_ok", { mode: "boolean" }),
  lastTestMessage: text("last_test_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const models = sqliteTable(
  "models",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoints.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    name: text("name").notNull(),
    alias: text("alias"),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    source: text("source", { enum: ["discovered", "manual", "suggested"] }).notNull(),
    kind: text("kind", { enum: ["text", "image", "other"] }).notNull().default("text"),
    /** Profile facts the provider reported at the last refresh (the discovery layer). */
    discoveredPatch: text("discovered_patch", { mode: "json" }).$type<ProfilePatch>().notNull().default({}),
    /** The owner's profile override. */
    override: text("override", { mode: "json" }).$type<ProfilePatch>(),
    /** Request fields this model rejected before; never sent again. */
    omit: text("omit", { mode: "json" }).$type<string[]>().notNull().default([]),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    discoveredAt: integer("discovered_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("models_endpoint_model_idx").on(t.endpointId, t.modelId)],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    mode: text("mode", { enum: MODES }).notNull(),
    title: text("title").notNull(),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    modelRowId: text("model_row_id").references(() => models.id, { onDelete: "set null" }),
    systemPrompt: text("system_prompt").notNull().default(""),
    params: text("params", { mode: "json" }).$type<ChatParams>().notNull().default({}),
    /** Agent threads: the folder the agent works in. */
    workspace: text("workspace"),
    approvalMode: text("approval_mode", { enum: ["ask", "edit", "full"] }).notNull().default("ask"),
    /** Harness switch and choice; see agent/harness.ts. */
    harness: text("harness", { mode: "json" }).$type<ThreadHarness>().notNull().default({ on: true, profileId: "ezclaw-agent", tools: [] }),
    /** Image threads: size, aspect ratio, count and other settings shown in the composer. */
    imageParams: text("image_params", { mode: "json" }).$type<ImageParams>().notNull().default({}),
    /** The agent's current plan, as last written with update_plan. */
    plan: text("plan", { mode: "json" }).$type<PlanItem[]>().notNull().default([]),
    /** Compaction: messages up to `summarySeq` are replaced by `summary` when sent to the model. */
    summary: text("summary"),
    summarySeq: integer("summary_seq").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("threads_mode_updated_idx").on(t.mode, t.updatedAt)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant", "tool"] }).notNull(),
    parts: text("parts", { mode: "json" }).$type<Part[]>().notNull(),
    /** The provider's own form of this assistant turn, replayed unchanged on later requests. */
    raw: text("raw", { mode: "json" }).$type<RawTurn>(),
    status: text("status", { enum: MESSAGE_STATUSES }).$type<MessageStatus>().notNull(),
    error: text("error"),
    notes: text("notes", { mode: "json" }).$type<string[]>().notNull().default([]),
    usage: text("usage", { mode: "json" }).$type<Usage>(),
    finishReason: text("finish_reason").$type<FinishReason>(),
    modelLabel: text("model_label"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("messages_thread_seq_idx").on(t.threadId, t.seq)],
);

/** Every provider call made for an assistant message, with secrets redacted. Pruned after 30 days. */
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    requestHeaders: text("request_headers", { mode: "json" }).$type<Record<string, string>>().notNull(),
    requestBody: text("request_body").notNull(),
    status: integer("status"),
    responseText: text("response_text"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    durationMs: integer("duration_ms"),
  },
  (t) => [index("request_logs_message_idx").on(t.messageId), index("request_logs_started_idx").on(t.startedAt)],
);

/** "Always allow" decisions, remembered per workspace as the leading words of a command. */
export const approvalRules = sqliteTable(
  "approval_rules",
  {
    id: text("id").primaryKey(),
    workspace: text("workspace").notNull(),
    pattern: text("pattern", { mode: "json" }).$type<string[]>().notNull(),
    /** JSON of `pattern`, so the same rule cannot be stored twice. */
    patternKey: text("pattern_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("approval_rules_unique_idx").on(t.workspace, t.patternKey)],
);

/** Harness profiles the owner made by copying a built-in one. */
export const harnessProfiles = sqliteTable("harness_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** The full profile (see HarnessProfile in core). */
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

/** Images EZClaw keeps: uploads used as references and results from image models. The bytes live on disk. */
export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["upload", "generated"] }).notNull(),
    mime: text("mime").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    /** File name under the assets folder of the data directory. */
    file: text("file").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("assets_sha_idx").on(t.sha256)],
);

/** Things to remember across threads. Models can only add proposals; the owner approves them. */
export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    text: text("text").notNull(),
    scope: text("scope", { enum: ["global", "workspace"] }).notNull(),
    workspace: text("workspace"),
    status: text("status", { enum: ["active", "proposed"] }).notNull(),
    source: text("source", { enum: ["user", "agent"] }).notNull(),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("memories_status_idx").on(t.status)],
);

/**
 * The content of a file just before an agent run first changed it, so the run can be undone.
 * One row per file per run; `existed` false means the run created the file.
 */
export const fileSnapshots = sqliteTable(
  "file_snapshots",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** The user message that started the run. */
    runMessageId: text("run_message_id").notNull(),
    path: text("path").notNull(),
    existed: integer("existed", { mode: "boolean" }).notNull(),
    content: blob("content", { mode: "buffer" }),
    restoredAt: integer("restored_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [uniqueIndex("file_snapshots_run_path_idx").on(t.runMessageId, t.path), index("file_snapshots_thread_idx").on(t.threadId)],
);
