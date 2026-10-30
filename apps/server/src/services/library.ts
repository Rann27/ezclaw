import type { ImageTurnMeta, LibraryItem, LibraryResponse } from "@ezclaw/core";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assets, messages, threads } from "../db/schema.js";

export interface LibraryQuery {
  q?: string;
  mode?: "image" | "edit";
  model?: string;
  favorite?: boolean;
  offset?: number;
  limit?: number;
}

/** Every image made in Image and Edit, newest first, with the prompt and thread it came from. */
export function listLibrary(db: Db, query: LibraryQuery): LibraryResponse {
  const rows = db
    .select({ m: messages, title: threads.title, mode: threads.mode })
    .from(messages)
    .innerJoin(threads, eq(messages.threadId, threads.id))
    .where(and(eq(messages.role, "assistant"), inArray(threads.mode, ["image", "edit"])))
    .all();

  const ids = rows.flatMap((r) => r.m.parts.flatMap((p) => (p.type === "image" ? [p.assetId] : [])));
  const info = new Map(
    (ids.length ? db.select().from(assets).where(inArray(assets.id, ids)).all() : []).map((a) => [a.id, a]),
  );

  const all: LibraryItem[] = [];
  const models = new Set<string>();
  for (const { m, title, mode } of rows) {
    const meta = m.raw?.protocol === "image" ? (m.raw.data as ImageTurnMeta) : null;
    for (const p of m.parts) {
      if (p.type !== "image") continue;
      const a = info.get(p.assetId);
      if (!a) continue;
      if (m.modelLabel) models.add(m.modelLabel);
      all.push({
        assetId: p.assetId,
        threadId: m.threadId,
        threadTitle: title,
        mode: mode as "image" | "edit",
        messageId: m.id,
        prompt: meta?.prompt ?? "",
        sentPrompt: meta?.sentPrompt ?? "",
        model: m.modelLabel,
        seed: p.seed ?? null,
        width: a.width,
        height: a.height,
        favorite: a.favorite,
        createdAt: a.createdAt.toISOString(),
      });
    }
  }
  const q = query.q?.trim().toLowerCase();
  const filtered = all
    .filter((i) => !query.mode || i.mode === query.mode)
    .filter((i) => !query.model || i.model === query.model)
    .filter((i) => !query.favorite || i.favorite)
    .filter((i) => !q || `${i.prompt} ${i.sentPrompt} ${i.threadTitle}`.toLowerCase().includes(q))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const offset = query.offset ?? 0;
  const limit = Math.min(query.limit ?? 60, 200);
  return { items: filtered.slice(offset, offset + limit), total: filtered.length, models: [...models].sort() };
}
