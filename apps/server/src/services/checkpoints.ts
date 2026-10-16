import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CheckpointDto, RestoreResponse } from "@ezclaw/core";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { fileSnapshots, messages } from "../db/schema.js";
import { HttpError } from "../errors.js";
import type { RunManager } from "../runs.js";

/**
 * Undo for agent runs. Only file changes made through EZClaw's file tools (write_file, edit_file,
 * apply_patch) are recorded; what a shell command changed cannot be put back from here.
 */
export class CheckpointService {
  constructor(
    private readonly db: Db,
    private readonly runs: RunManager,
  ) {}

  list(threadId: string): CheckpointDto[] {
    const rows = this.db.select().from(fileSnapshots).where(eq(fileSnapshots.threadId, threadId)).orderBy(asc(fileSnapshots.createdAt)).all();
    const byRun = new Map<string, CheckpointDto>();
    for (const r of rows) {
      let cp = byRun.get(r.runMessageId);
      if (!cp) {
        const msg = this.db.select({ parts: messages.parts }).from(messages).where(eq(messages.id, r.runMessageId)).get();
        const text = msg?.parts.map((p) => (p.type === "text" ? p.text : "")).join("") ?? "";
        cp = { runMessageId: r.runMessageId, prompt: text.length > 120 ? `${text.slice(0, 119)}…` : text, createdAt: r.createdAt.toISOString(), restoredAt: null, files: [] };
        byRun.set(r.runMessageId, cp);
      }
      if (r.restoredAt) cp.restoredAt = r.restoredAt.toISOString();
      cp.files.push({ path: r.path, created: !r.existed, restorable: !r.existed || r.content !== null });
    }
    return [...byRun.values()].reverse();
  }

  /** Puts every file the run changed back the way it was before the run. Files the run created are removed. */
  restore(threadId: string, runMessageId: string): RestoreResponse {
    if (this.runs.activeForThread(threadId)) throw new HttpError(409, "run_active", "Hentikan agent dulu sebelum mengembalikan file.");
    const rows = this.db
      .select()
      .from(fileSnapshots)
      .where(and(eq(fileSnapshots.threadId, threadId), eq(fileSnapshots.runMessageId, runMessageId), isNull(fileSnapshots.restoredAt)))
      .all();
    if (!rows.length) throw new HttpError(404, "checkpoint_not_found", "Tidak ada perubahan file dari run ini yang bisa dikembalikan.");
    const out: RestoreResponse = { restored: [], skipped: [] };
    for (const r of rows) {
      try {
        if (!r.existed) {
          if (existsSync(r.path)) unlinkSync(r.path);
          out.restored.push(r.path);
        } else if (r.content) {
          mkdirSync(dirname(r.path), { recursive: true });
          writeFileSync(r.path, r.content);
          out.restored.push(r.path);
        } else {
          out.skipped.push({ path: r.path, reason: "File terlalu besar untuk disimpan sebelum diubah." });
          continue;
        }
        this.db.update(fileSnapshots).set({ restoredAt: new Date() }).where(eq(fileSnapshots.id, r.id)).run();
      } catch (err) {
        out.skipped.push({ path: r.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}
