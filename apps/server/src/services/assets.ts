import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetDto } from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { assets } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { sniffImage } from "./imageInfo.js";

type AssetRow = typeof assets.$inferSelect;

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export function toAssetDto(r: AssetRow): AssetDto {
  return { id: r.id, kind: r.kind, mime: r.mime, bytes: r.bytes, width: r.width, height: r.height, createdAt: r.createdAt.toISOString() };
}

/** Image files kept by EZClaw, stored as plain files beside the database so they can be backed up or opened directly. */
export class AssetService {
  constructor(
    private readonly db: Db,
    private readonly dir: string,
  ) {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Stores image bytes. Throws a 400/413 HttpError when the bytes are not a supported image or are too large. */
  save(bytes: Buffer, kind: AssetRow["kind"]): AssetDto {
    if (bytes.length === 0) throw new HttpError(400, "empty_file", "File kosong.");
    if (bytes.length > MAX_ASSET_BYTES) throw new HttpError(413, "file_too_large", `Gambar lebih besar dari ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
    const info = sniffImage(bytes);
    if (!info) throw new HttpError(400, "not_an_image", "File ini bukan gambar yang didukung. Pakai PNG, JPEG, WebP, atau GIF.");

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (kind === "upload") {
      // The same upload twice is one file.
      const existing = this.db.select().from(assets).where(eq(assets.sha256, sha256)).all().find((a) => a.kind === "upload");
      if (existing) return toAssetDto(existing);
    }
    const id = randomUUID();
    const file = `${id}.${info.ext}`;
    writeFileSync(join(this.dir, file), bytes);
    const row: typeof assets.$inferInsert = { id, kind, mime: info.mime, bytes: bytes.length, width: info.width, height: info.height, sha256, file, createdAt: new Date() };
    this.db.insert(assets).values(row).run();
    return toAssetDto(this.row(id));
  }

  private row(id: string): AssetRow {
    const row = this.db.select().from(assets).where(eq(assets.id, id)).get();
    if (!row) throw new HttpError(404, "asset_not_found", "Gambar tidak ditemukan.");
    return row;
  }

  dto(id: string): AssetDto {
    return toAssetDto(this.row(id));
  }

  read(id: string): { bytes: Buffer; mime: string; file: string } {
    const row = this.row(id);
    try {
      return { bytes: readFileSync(join(this.dir, row.file)), mime: row.mime, file: row.file };
    } catch {
      throw new HttpError(404, "asset_missing", "File gambar ini hilang dari folder data EZClaw.");
    }
  }
}
