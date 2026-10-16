import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { MemoryDto } from "@ezclaw/core";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { memories } from "../db/schema.js";
import { HttpError } from "../errors.js";

type Row = typeof memories.$inferSelect;

/** How many memories go into one prompt at most, newest first, so a long list cannot crowd out the task. */
const MAX_IN_PROMPT = 60;

const toDto = (r: Row): MemoryDto => ({
  id: r.id,
  text: r.text,
  scope: r.scope,
  workspace: r.workspace,
  status: r.status,
  source: r.source,
  threadId: r.threadId,
  createdAt: r.createdAt.toISOString(),
});

/** Same folder regardless of case and trailing slash on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export class MemoryService {
  constructor(private readonly db: Db) {}

  list(): MemoryDto[] {
    return this.db.select().from(memories).orderBy(asc(memories.createdAt)).all().map(toDto);
  }

  private row(id: string): Row {
    const row = this.db.select().from(memories).where(eq(memories.id, id)).get();
    if (!row) throw new HttpError(404, "memory_not_found", "Memori tidak ditemukan.");
    return row;
  }

  create(input: { text: string; scope: "global" | "workspace"; workspace?: string | null; source: "user" | "agent"; status: "active" | "proposed"; threadId?: string | null }): MemoryDto {
    if (input.scope === "workspace" && !input.workspace) throw new HttpError(400, "workspace_required", "Memori folder butuh path folder.");
    const id = randomUUID();
    this.db
      .insert(memories)
      .values({
        id,
        text: input.text.trim(),
        scope: input.scope,
        workspace: input.scope === "workspace" ? (input.workspace ?? null) : null,
        status: input.status,
        source: input.source,
        threadId: input.threadId ?? null,
        createdAt: new Date(),
      })
      .run();
    return toDto(this.row(id));
  }

  update(id: string, patch: { text?: string; scope?: "global" | "workspace"; workspace?: string | null; status?: "active" | "proposed" }): MemoryDto {
    const current = this.row(id);
    const scope = patch.scope ?? current.scope;
    const workspace = scope === "workspace" ? (patch.workspace !== undefined ? patch.workspace : current.workspace) : null;
    if (scope === "workspace" && !workspace) throw new HttpError(400, "workspace_required", "Memori folder butuh path folder.");
    this.db
      .update(memories)
      .set({ ...(patch.text !== undefined ? { text: patch.text.trim() } : {}), ...(patch.status ? { status: patch.status } : {}), scope, workspace })
      .where(eq(memories.id, id))
      .run();
    return toDto(this.row(id));
  }

  remove(id: string) {
    this.row(id);
    this.db.delete(memories).where(eq(memories.id, id)).run();
  }

  /** Approved memories for a prompt: every global one, plus those for this folder. */
  forPrompt(workspace: string | null): string[] {
    return this.db
      .select()
      .from(memories)
      .where(eq(memories.status, "active"))
      .orderBy(asc(memories.createdAt))
      .all()
      .filter((m) => m.scope === "global" || (workspace && m.workspace && samePath(m.workspace, workspace)))
      .slice(-MAX_IN_PROMPT)
      .map((m) => m.text);
  }
}
