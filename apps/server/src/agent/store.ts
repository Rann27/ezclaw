import { randomUUID } from "node:crypto";
import type { CanonicalMessage, FinishReason, MessageStatus, Part, RawTurn, Usage } from "@ezclaw/core";
import { asc, eq, max } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { messages, threads } from "../db/schema.js";

export interface NewMessage {
  threadId: string;
  role: "user" | "assistant" | "tool";
  parts: Part[];
  status: MessageStatus;
  modelLabel?: string | null;
  raw?: RawTurn | null;
}

/** Appends a message to a thread, taking the next sequence number. */
export function insertMessage(db: Db, m: NewMessage): { id: string; seq: number } {
  const id = randomUUID();
  const seq = (db.select({ n: max(messages.seq) }).from(messages).where(eq(messages.threadId, m.threadId)).get()?.n ?? 0) + 1;
  db.insert(messages)
    .values({ id, threadId: m.threadId, seq, role: m.role, parts: m.parts, status: m.status, modelLabel: m.modelLabel ?? null, raw: m.raw ?? null, createdAt: new Date() })
    .run();
  return { id, seq };
}

export interface MessageUpdate {
  parts?: Part[];
  status?: MessageStatus;
  error?: string | null;
  notes?: string[];
  usage?: Usage | null;
  finishReason?: FinishReason | null;
  modelLabel?: string | null;
  durationMs?: number | null;
  raw?: RawTurn | null;
}

export function updateMessage(db: Db, id: string, patch: MessageUpdate) {
  const set: Partial<typeof messages.$inferInsert> = {};
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (set as Record<string, unknown>)[k] = v;
  if (Object.keys(set).length) db.update(messages).set(set).where(eq(messages.id, id)).run();
}

export function touchThread(db: Db, threadId: string) {
  db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId)).run();
}

const SUMMARY_PREFIX = "Ringkasan percakapan sebelumnya (dibuat otomatis karena konteks hampir penuh):\n\n";

export interface HistoryEntry {
  message: CanonicalMessage;
  /** Sequence number in the thread; 0 for the compaction summary standing in for older messages. */
  seq: number;
}

/**
 * The transcript as it should be sent to the model: the compaction summary (if any) standing in
 * for the oldest messages, then everything after it. Failed answers are left out.
 */
export function loadHistoryEntries(db: Db, threadId: string): HistoryEntry[] {
  const thread = db.select({ summary: threads.summary, summarySeq: threads.summarySeq }).from(threads).where(eq(threads.id, threadId)).get();
  const rows = db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.seq)).all();
  const out: HistoryEntry[] = [];
  if (thread?.summary) out.push({ seq: 0, message: { role: "user", parts: [{ type: "text", text: `${SUMMARY_PREFIX}${thread.summary}` }] } });

  for (const m of rows) {
    if (m.seq <= (thread?.summarySeq ?? 0)) continue;
    if (m.status === "streaming") continue;
    if (m.role === "assistant" && m.status === "error" && !m.parts.some((p) => p.type === "tool_call")) continue;
    const parts = m.parts.filter((p) => !(p.type === "text" && p.text.length === 0));
    if (!parts.length) continue;
    out.push({ seq: m.seq, message: { role: m.role, parts, ...(m.raw ? { raw: m.raw } : {}) } });
  }
  return out;
}

export function loadHistory(db: Db, threadId: string): CanonicalMessage[] {
  return loadHistoryEntries(db, threadId).map((e) => e.message);
}
