import { randomUUID } from "node:crypto";
import {
  type ApprovalMode,
  type HarnessProfile,
  type ImageTurnMeta,
  type MessageDto,
  type SendMessageInput,
  type SendMessageResponse,
  type ThreadDetailDto,
  type ThreadHarness,
  type ThreadPatch,
  type ThreadSummary,
} from "@ezclaw/core";
import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import { loadProjectInstructions, renderPrompt, renderSystemPrompt, withHarnessMessages, type HarnessService, type RenderedPrompt } from "../agent/harness.js";
import { defaultShell } from "../agent/shell.js";
import { insertMessage, loadHistory } from "../agent/store.js";
import { TOOL_NAMES } from "../agent/toolRegistry.js";
import { Workspace } from "../agent/workspace.js";
import type { Db } from "../db/client.js";
import { messages, models, requestLogs, threads } from "../db/schema.js";
import { HttpError } from "../errors.js";
import type { RunManager } from "../runs.js";
import type { MemoryService } from "./memory.js";
import type { RegistryService } from "./registry.js";

type ThreadRow = typeof threads.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export const DEFAULT_TITLE = "Percakapan baru";
const TITLE_MAX = 60;
const LOG_RETENTION_MS = 30 * 24 * 3600_000;

const CHAT_HARNESS: ThreadHarness = { on: true, profileId: "ezclaw-chat", tools: [] };
const AGENT_HARNESS: ThreadHarness = { on: true, profileId: "ezclaw-agent", tools: [] };

export class ChatService {
  constructor(
    private readonly db: Db,
    private readonly registry: RegistryService,
    private readonly runs: RunManager,
    private readonly harness: HarnessService,
    private readonly codexDir: () => string | null,
    private readonly memory: MemoryService,
  ) {}

  /** Startup housekeeping: answers cut off by a restart, and old request logs. */
  recover() {
    this.db
      .update(messages)
      .set({ status: "error", error: "EZClaw dimatikan atau dimulai ulang saat jawaban ini masih berjalan." })
      .where(eq(messages.status, "streaming"))
      .run();
    this.db.delete(requestLogs).where(lt(requestLogs.startedAt, new Date(Date.now() - LOG_RETENTION_MS))).run();
  }

  list(mode: ThreadRow["mode"]): ThreadSummary[] {
    return this.db
      .select()
      .from(threads)
      .where(and(eq(threads.mode, mode), isNull(threads.archivedAt)))
      .orderBy(desc(threads.pinned), desc(threads.updatedAt))
      .all()
      .map((r) => ({ id: r.id, mode: r.mode, title: r.title, pinned: r.pinned, updatedAt: r.updatedAt.toISOString() }));
  }

  private row(id: string): ThreadRow {
    const row = this.db.select().from(threads).where(eq(threads.id, id)).get();
    if (!row) throw new HttpError(404, "thread_not_found", "Thread tidak ditemukan.");
    return row;
  }

  private checkModel(id: string | null | undefined) {
    if (id && !this.db.select({ id: models.id }).from(models).where(eq(models.id, id)).get()) {
      throw new HttpError(400, "model_not_found", "Model yang dipilih tidak ada.");
    }
  }

  private checkWorkspace(path: string): string {
    const v = Workspace.validate(path);
    if (!v.ok) throw new HttpError(400, "invalid_workspace", v.message);
    return v.root;
  }

  private checkHarness(h: ThreadHarness, mode: "chat" | "agent"): ThreadHarness {
    const profile = this.harness.get(h.profileId);
    if (!profile) throw new HttpError(400, "harness_not_found", `Profil harness "${h.profileId}" tidak ditemukan.`);
    if (profile.mode !== mode) throw new HttpError(400, "harness_mode", `Profil "${profile.name}" untuk mode ${profile.mode}, bukan ${mode}.`);
    const known = new Set<string>(TOOL_NAMES);
    return { on: h.on, profileId: h.profileId, tools: h.tools.filter((t) => known.has(t)) };
  }

  create(input: { mode: "chat" | "agent" | "image" | "edit"; modelId?: string; defaultModelId?: string; workspace?: string; approvalMode?: ApprovalMode; confirmFull?: boolean; harness?: ThreadHarness }): ThreadDetailDto {
    const modelId = input.modelId ?? input.defaultModelId ?? null;
    this.checkModel(modelId);
    let workspace: string | null = null;
    if (input.mode === "agent") {
      if (!input.workspace) throw new HttpError(400, "workspace_required", "Pilih folder workspace untuk thread Agent.");
      workspace = this.checkWorkspace(input.workspace);
    }
    if (input.approvalMode === "full" && input.confirmFull !== true) {
      throw new HttpError(400, "confirm_required", "Mode Otomatis penuh harus dinyalakan lewat dialog konfirmasi.");
    }
    const harness = this.checkHarness(input.harness ?? (input.mode === "agent" ? AGENT_HARNESS : CHAT_HARNESS), input.mode === "agent" ? "agent" : "chat");
    const now = new Date();
    const id = randomUUID();
    this.db
      .insert(threads)
      .values({ id, mode: input.mode, title: DEFAULT_TITLE, modelRowId: modelId, workspace, approvalMode: input.approvalMode ?? "ask", harness, createdAt: now, updatedAt: now })
      .run();
    return this.detail(id);
  }

  detail(id: string): ThreadDetailDto {
    const row = this.row(id);
    const msgs = this.db.select().from(messages).where(eq(messages.threadId, id)).orderBy(asc(messages.seq)).all();
    return {
      id: row.id,
      mode: row.mode,
      title: row.title,
      pinned: row.pinned,
      modelId: row.modelRowId,
      systemPrompt: row.systemPrompt,
      params: row.params,
      imageParams: row.imageParams,
      workspace: row.workspace,
      approvalMode: row.approvalMode,
      harness: row.harness,
      plan: row.plan,
      summarySeq: row.summarySeq,
      messages: msgs.map(toMessageDto),
      activeRun: this.runs.activeForThread(id),
    };
  }

  patch(id: string, patch: ThreadPatch): ThreadDetailDto {
    const row = this.row(id);
    const running = !!this.runs.activeForThread(id);
    const set: Partial<typeof threads.$inferInsert> = {};
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
    if (patch.systemPrompt !== undefined) set.systemPrompt = patch.systemPrompt;
    if (patch.params !== undefined) set.params = patch.params;
    if (patch.imageParams !== undefined) set.imageParams = patch.imageParams;
    if (patch.modelId !== undefined) {
      this.checkModel(patch.modelId);
      set.modelRowId = patch.modelId;
    }
    if (patch.workspace !== undefined) {
      if (row.mode !== "agent") throw new HttpError(400, "not_agent", "Hanya thread Agent yang punya workspace.");
      if (running) throw new HttpError(409, "run_active", "Workspace tidak bisa diganti saat agent sedang bekerja.");
      set.workspace = this.checkWorkspace(patch.workspace);
    }
    if (patch.approvalMode !== undefined) {
      if (row.mode !== "agent") throw new HttpError(400, "not_agent", "Hanya thread Agent yang punya mode izin.");
      if (patch.approvalMode === "full" && row.approvalMode !== "full" && patch.confirmFull !== true) {
        throw new HttpError(400, "confirm_required", "Otomatis penuh perlu konfirmasi eksplisit.");
      }
      set.approvalMode = patch.approvalMode;
    }
    if (patch.harness !== undefined) {
      if (running) throw new HttpError(409, "run_active", "Harness tidak bisa diganti saat jawaban sedang berjalan. Berlaku mulai giliran berikutnya.");
      set.harness = this.checkHarness(patch.harness, row.mode === "agent" ? "agent" : "chat");
    }
    if (Object.keys(set).length) this.db.update(threads).set(set).where(eq(threads.id, id)).run();
    return this.detail(id);
  }

  remove(id: string) {
    this.row(id);
    if (this.runs.activeForThread(id)) throw new HttpError(409, "run_active", "Hentikan jawaban yang sedang berjalan sebelum menghapus thread.");
    this.db.delete(threads).where(eq(threads.id, id)).run();
  }

  send(threadId: string, input: SendMessageInput): SendMessageResponse {
    const thread = this.row(threadId);
    if (this.runs.activeForThread(threadId)) {
      throw new HttpError(409, "run_active", "Masih ada jawaban yang berjalan di thread ini. Tunggu selesai atau tekan Stop.");
    }
    if (thread.mode !== "chat" && thread.mode !== "agent") throw new HttpError(400, "unsupported_mode", "Mode thread ini belum bisa dipakai.");

    const model = this.registry.resolveModel(input.modelId);
    if (model.row.kind === "image") {
      throw new HttpError(400, "not_a_chat_model", "Model ini menghasilkan gambar. Pakai mode Image untuk model gambar.");
    }
    if (model.endpoint.authType !== "none" && !this.registry.getApiKey(model.endpoint.id)) {
      throw new HttpError(400, "key_missing", `Endpoint ${model.endpoint.name} belum punya key. Isi di Settings, bagian Endpoint.`);
    }

    const params = input.params ?? thread.params;
    const systemPrompt = input.systemPrompt ?? thread.systemPrompt;
    const now = new Date();
    const titlePatch = thread.title === DEFAULT_TITLE ? { title: titleFrom(input.text) } : {};

    if (thread.mode === "agent") {
      if (!thread.workspace) throw new HttpError(400, "workspace_required", "Thread Agent ini belum punya workspace.");
      const check = Workspace.validate(thread.workspace);
      if (!check.ok) throw new HttpError(400, "invalid_workspace", check.message);
      const profile = this.harness.require(thread.harness.profileId);
      if (thread.harness.on && profile.fromCodex) {
        // Fail now, with a clear message, rather than after the user message is saved.
        renderSystemPrompt(profile, { date: "", os: "", shell: defaultShell(), workspace: check.root, approval: thread.approvalMode, modelId: model.row.modelId, userPrompt: "", codexDir: this.codexDir() }, []);
      }

      const user = insertMessage(this.db, { threadId, role: "user", parts: [{ type: "text", text: input.text }], status: "complete" });
      this.db.update(threads).set({ modelRowId: input.modelId, params, systemPrompt, updatedAt: now, ...titlePatch }).where(eq(threads.id, threadId)).run();
      const runId = this.runs.startAgent({
        threadId,
        modelRowId: input.modelId,
        params,
        approvalMode: thread.approvalMode,
        workspace: check.root,
        harness: thread.harness,
        userPrompt: systemPrompt,
        startMessageId: user.id,
      });
      return { runId, userMessageId: user.id, assistantMessageId: null };
    }

    const history = loadHistory(this.db, threadId);
    const userId = randomUUID();
    const assistantId = randomUUID();
    const last = this.db.select({ seq: messages.seq }).from(messages).where(eq(messages.threadId, threadId)).orderBy(desc(messages.seq)).limit(1).get();
    const nextSeq = (last?.seq ?? 0) + 1;

    this.db.transaction((tx) => {
      tx.insert(messages)
        .values({ id: userId, threadId, seq: nextSeq, role: "user", parts: [{ type: "text", text: input.text }], status: "complete", createdAt: now })
        .run();
      tx.insert(messages)
        .values({
          id: assistantId,
          threadId,
          seq: nextSeq + 1,
          role: "assistant",
          parts: [{ type: "text", text: "" }],
          status: "streaming",
          modelLabel: `${model.endpoint.name} / ${model.row.modelId}`,
          createdAt: now,
        })
        .run();
      tx.update(threads).set({ modelRowId: input.modelId, params, systemPrompt, updatedAt: now, ...titlePatch }).where(eq(threads.id, threadId)).run();
    });

    history.push({ role: "user", parts: [{ type: "text", text: input.text }] });
    const prompt = this.chatPrompt(thread, systemPrompt, model.row.modelId);
    const runId = this.runs.startChat({
      threadId,
      assistantMessageId: assistantId,
      modelRowId: input.modelId,
      system: prompt.system,
      params,
      history: prompt.profile ? withHarnessMessages(history, prompt.rendered, prompt.profile.userTag) : history,
    });
    return { runId, userMessageId: userId, assistantMessageId: assistantId };
  }

  /** Chat's system prompt: the harness text when the harness is on, plus the thread's own prompt. */
  private chatPrompt(thread: ThreadRow, userPrompt: string, modelId: string): { system: string | undefined; profile: HarnessProfile | null; rendered: RenderedPrompt } {
    const none = { developer: [], context: "", text: "", stableChars: 0 };
    if (!thread.harness.on) return { system: renderUserPrompt(userPrompt), profile: null, rendered: none };
    const profile = this.harness.get(thread.harness.profileId);
    if (!profile) return { system: renderUserPrompt(userPrompt), profile: null, rendered: none };
    const rendered = renderPrompt(
      profile,
      { date: new Date().toLocaleDateString("sv-SE"), os: process.platform, shell: defaultShell(), workspace: "", approval: "ask", modelId, userPrompt: renderUserPrompt(userPrompt) ?? "", codexDir: this.codexDir(), memories: this.memory.forPrompt(null) },
      loadProjectInstructions("", []),
    );
    return { system: rendered.text || undefined, profile, rendered };
  }

  requestLogs(messageId: string) {
    return this.db.select().from(requestLogs).where(eq(requestLogs.messageId, messageId)).orderBy(asc(requestLogs.attempt), asc(requestLogs.startedAt)).all();
  }
}

export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= TITLE_MAX ? oneLine : `${oneLine.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Fills the few variables a system prompt may use. Unknown {{names}} are left as typed. */
export function renderUserPrompt(prompt: string, now: Date = new Date()): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) return undefined;
  const date = now.toLocaleDateString("sv-SE");
  return trimmed.replaceAll("{{date}}", date).replaceAll("{{os}}", process.platform);
}

export function toMessageDto(m: MessageRow): MessageDto {
  return {
    id: m.id,
    seq: m.seq,
    role: m.role,
    parts: m.parts,
    status: m.status,
    error: m.error,
    notes: m.notes,
    usage: m.usage,
    finishReason: m.finishReason,
    modelLabel: m.modelLabel,
    durationMs: m.durationMs,
    image: m.raw?.protocol === "image" ? (m.raw.data as ImageTurnMeta) : null,
    createdAt: m.createdAt.toISOString(),
  };
}
