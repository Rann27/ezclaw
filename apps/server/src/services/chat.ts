import { randomUUID } from "node:crypto";
import {
  type Part,
  type SearchHit,
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
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
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
import type { McpService } from "../mcp/service.js";
import type { SkillService } from "./skills.js";
import { slashSkill, usableSkills } from "../agent/skills.js";
import { getSettings } from "../settings.js";
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
    private readonly mcp: McpService,
    private readonly skills: SkillService,
  ) {}

  /** Chat runs through the tool loop when there is something for the model to call. */
  private chatHasTools(text: string): boolean {
    if (this.mcp.activeRows("chat").length) return true;
    const usable = usableSkills(this.skills.discover(null), this.skills.states(), "chat");
    return usable.length > 0 || !!slashSkill(text, usableSkills(this.skills.discover(null), this.skills.states(), "agent"));
  }

  /** Startup housekeeping: answers cut off by a restart, and old request logs. */
  recover() {
    this.db
      .update(messages)
      .set({ status: "error", error: "EZClaw dimatikan atau dimulai ulang saat jawaban ini masih berjalan." })
      .where(eq(messages.status, "streaming"))
      .run();
    this.db.delete(requestLogs).where(lt(requestLogs.startedAt, new Date(Date.now() - LOG_RETENTION_MS))).run();
  }

  list(mode: ThreadRow["mode"], archived = false): ThreadSummary[] {
    return this.db
      .select()
      .from(threads)
      .where(and(eq(threads.mode, mode), archived ? isNotNull(threads.archivedAt) : isNull(threads.archivedAt)))
      .orderBy(desc(threads.pinned), desc(archived ? threads.archivedAt : threads.updatedAt))
      .all()
      .map((r) => ({ id: r.id, mode: r.mode, title: r.title, pinned: r.pinned, group: r.groupName, archived: r.archivedAt !== null, updatedAt: r.updatedAt.toISOString() }));
  }

  /** Titles and message text containing `q`, newest first. Plain substring match, case-insensitive. */
  search(q: string, limit = 60): SearchHit[] {
    const needle = q.trim();
    if (needle.length < 2) return [];
    const like = `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const lower = needle.toLowerCase();
    const live = this.db.select().from(threads).where(isNull(threads.archivedAt)).all();
    const byId = new Map(live.map((t) => [t.id, t]));
    const hits: SearchHit[] = [];
    const cut = (text: string, at: number, len: number) => ({
      before: (at > 60 ? "…" : "") + text.slice(Math.max(0, at - 60), at),
      match: text.slice(at, at + len),
      after: text.slice(at + len, at + len + 100) + (text.length > at + len + 100 ? "…" : ""),
    });
    for (const t of live) {
      const at = t.title.toLowerCase().indexOf(lower);
      if (at >= 0) hits.push({ threadId: t.id, mode: t.mode, title: t.title, in: "title", messageId: null, role: null, ...cut(t.title, at, needle.length), updatedAt: t.updatedAt.toISOString() });
    }
    // The parts column is JSON text, so LIKE finds candidates; the real text is checked below.
    const rows = this.db
      .select({ id: messages.id, threadId: messages.threadId, role: messages.role, parts: messages.parts, createdAt: messages.createdAt })
      .from(messages)
      .where(sql`${messages.parts} LIKE ${like} ESCAPE '\\'`)
      .orderBy(desc(messages.createdAt))
      .limit(400)
      .all();
    const seen = new Set<string>();
    for (const m of rows) {
      const t = byId.get(m.threadId);
      if (!t || seen.has(m.threadId) || hits.length >= limit) continue;
      const text = m.parts
        .map((p) => (p.type === "text" ? p.text : p.type === "tool_result" ? p.output : ""))
        .join("\n")
        .replace(/\s+/g, " ");
      const at = text.toLowerCase().indexOf(lower);
      if (at < 0) continue;
      seen.add(m.threadId);
      hits.push({ threadId: t.id, mode: t.mode, title: t.title, in: "message", messageId: m.id, role: m.role, ...cut(text, at, needle.length), updatedAt: m.createdAt.toISOString() });
    }
    return hits.slice(0, limit);
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
    if (patch.group !== undefined) set.groupName = patch.group;
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

  /**
   * A model that can look at the images in this message: the chosen one if it can, else the
   * "vision" role from Settings, else a text model that takes images (same endpoint first).
   */
  private visionModel(chosenId: string): { id: string; note: string | null } {
    const chosen = this.registry.resolveModel(chosenId);
    if (chosen.resolved.profile.inputModalities.includes("image")) return { id: chosenId, note: null };
    const all = this.registry.listModels().filter((m) => m.kind === "text" && m.summary.inputModalities.includes("image"));
    const role = getSettings(this.db).defaultModels.vision;
    const pick = all.find((m) => m.id === role) ?? all.find((m) => m.endpointId === chosen.endpoint.id && m.favorite) ?? all.find((m) => m.endpointId === chosen.endpoint.id) ?? all.find((m) => m.favorite) ?? all[0];
    if (!pick) {
      throw new HttpError(400, "no_vision_model", `${chosen.row.modelId} tidak bisa membaca gambar dan tidak ada model lain yang bisa. Tambahkan model yang menerima gambar, atau atur Cadangan vision di Settings, Umum.`);
    }
    return { id: pick.id, note: `${chosen.row.modelId} tidak menerima gambar, jadi pesan ini dijawab ${pick.endpointName} / ${pick.modelId}.` };
  }

  send(threadId: string, input: SendMessageInput, extraParts: Part[] = []): SendMessageResponse {
    const thread = this.row(threadId);
    // Images in this message need a model that can see them; the thread keeps the owner's choice.
    const vision = extraParts.some((p) => p.type === "image") ? this.visionModel(input.modelId) : { id: input.modelId, note: null };
    const userParts: Part[] = [{ type: "text", text: input.text }, ...extraParts];
    const active = this.runs.activeForThread(threadId);
    if (active) {
      // An agent run takes the message and reads it after its current step; a plain answer cannot.
      const runId = this.runs.enqueue(threadId, [{ type: "text", text: input.text }, ...extraParts]);
      if (runId) return { runId, userMessageId: "", assistantMessageId: null, queued: true };
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

      const user = insertMessage(this.db, { threadId, role: "user", parts: userParts, status: "complete" });
      this.db.update(threads).set({ modelRowId: input.modelId, params, systemPrompt, updatedAt: now, ...titlePatch }).where(eq(threads.id, threadId)).run();
      const runId = this.runs.startAgent({
        threadId,
        modelRowId: vision.id,
        ...(vision.note ? { note: vision.note } : {}),
        params,
        approvalMode: thread.approvalMode,
        workspace: check.root,
        harness: thread.harness,
        userPrompt: systemPrompt,
        startMessageId: user.id,
      });
      return { runId, userMessageId: user.id, assistantMessageId: null };
    }

    if (input.web || this.chatHasTools(input.text)) {
      // Web search, MCP tools or skills for Chat: the same loop as Agent, without a folder.
      const user = insertMessage(this.db, { threadId, role: "user", parts: userParts, status: "complete" });
      this.db.update(threads).set({ modelRowId: input.modelId, params, systemPrompt, updatedAt: now, ...titlePatch }).where(eq(threads.id, threadId)).run();
      const prompt = this.chatPrompt(thread, systemPrompt, model.row.modelId);
      const runId = this.runs.startAgent({
        threadId,
        modelRowId: vision.id,
        ...(vision.note ? { note: vision.note } : {}),
        params,
        approvalMode: "ask",
        workspace: null,
        harness: thread.harness,
        userPrompt: systemPrompt,
        startMessageId: user.id,
        chat: { system: prompt.system, developer: prompt.rendered.developer, context: prompt.rendered.context, userTag: prompt.profile?.userTag ?? null, ...(input.web ? { web: true } : {}) },
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
        .values({ id: userId, threadId, seq: nextSeq, role: "user", parts: userParts, status: "complete", createdAt: now })
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

    history.push({ role: "user", parts: userParts });
    const prompt = this.chatPrompt(thread, systemPrompt, model.row.modelId);
    const runId = this.runs.startChat({
      threadId,
      assistantMessageId: assistantId,
      modelRowId: vision.id,
      ...(vision.note ? { note: vision.note } : {}),
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
