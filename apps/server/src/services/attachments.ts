import type { AssetDto, Part } from "@ezclaw/core";
import mammoth from "mammoth";
import { extname } from "node:path";
import { extractText, getDocumentProxy, renderPageAsImage } from "unpdf";
import { HttpError } from "../errors.js";
import type { AssetService } from "./assets.js";
import { sniffImage } from "./imageInfo.js";

const TEXT_EXTS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "log", "srt", "vtt", "js", "jsx", "ts", "tsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "ps1", "bat", "sql", "css", "scss", "vue", "svelte", "lua", "r", "swift", "dart"]);
/** Text sent per attachment; anything longer is cut with a note, so one file cannot fill the context. */
const MAX_TEXT_CHARS = 150_000;
/** Pages of a scanned PDF sent as images. */
const MAX_SCAN_PAGES = 8;
/** Below this many characters per page a PDF is treated as scanned (no text layer). */
const SCANNED_CHARS_PER_PAGE = 40;

export interface StoredAttachment {
  asset: AssetDto;
  kind: "image" | "pdf" | "docx" | "text";
}

function extOf(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

function isUtf8Text(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  return !new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 64 * 1024)).includes("�");
}

/** Decides what a dropped file is from its bytes (and, for text, its name), and stores it. */
export function storeAttachment(assets: AssetService, bytes: Buffer, name: string): StoredAttachment {
  if (sniffImage(bytes)) return { asset: assets.save(bytes, "upload"), kind: "image" };
  const ext = extOf(name);
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return { asset: assets.saveAttachment(bytes, name, "application/pdf", "pdf"), kind: "pdf" };
  if (bytes.subarray(0, 2).toString("latin1") === "PK" && ext === "docx") {
    return { asset: assets.saveAttachment(bytes, name, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"), kind: "docx" };
  }
  if ((TEXT_EXTS.has(ext) || !ext) && isUtf8Text(bytes)) return { asset: assets.saveAttachment(bytes, name, "text/plain", ext || "txt"), kind: "text" };
  throw new HttpError(415, "unsupported_attachment", "Jenis file ini belum didukung. Lampirkan gambar, PDF, DOCX, atau file teks/kode.");
}

function cap(text: string): { text: string; note?: string } {
  const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= MAX_TEXT_CHARS) return { text: clean };
  return { text: clean.slice(0, MAX_TEXT_CHARS), note: `dipotong: hanya ${MAX_TEXT_CHARS.toLocaleString("id-ID")} karakter pertama dari ${clean.length.toLocaleString("id-ID")}` };
}

/**
 * Turns attached assets into message parts. Images stay images. Documents become text, which any
 * model can read and costs far less than images; only a PDF without a text layer (a scan) is
 * rendered page by page into images, which then need a model that sees images.
 */
export async function attachmentParts(assets: AssetService, ids: string[]): Promise<Part[]> {
  const parts: Part[] = [];
  for (const id of ids) {
    const info = assets.dto(id);
    if (info.kind !== "attachment") {
      parts.push({ type: "image", assetId: id, role: "lampiran" });
      continue;
    }
    const { bytes } = assets.read(id);
    const name = info.name ?? "lampiran";
    if (info.mime === "application/pdf") {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const chars = text.reduce((n, t) => n + t.trim().length, 0);
      if (totalPages > 0 && chars / totalPages >= SCANNED_CHARS_PER_PAGE) {
        const joined = text.map((t, i) => `--- halaman ${i + 1} ---\n${t.trim()}`).join("\n\n");
        const c = cap(joined);
        parts.push({ type: "file", assetId: id, name, mime: info.mime, text: c.text, ...(c.note ? { note: c.note } : {}) });
      } else {
        // A scan: the pages are pictures, so they go as images.
        const pages = Math.min(totalPages, MAX_SCAN_PAGES);
        for (let p = 1; p <= pages; p++) {
          const png = await renderPageAsImage(pdf, p, { canvasImport: () => import("@napi-rs/canvas"), scale: 1.5 });
          const asset = assets.save(Buffer.from(png), "upload");
          parts.push({ type: "image", assetId: asset.id, role: `${name} halaman ${p}` });
        }
        parts.push({
          type: "file",
          assetId: id,
          name,
          mime: info.mime,
          text: "",
          note: `PDF hasil scan tanpa lapisan teks; ${pages} dari ${totalPages} halaman dikirim sebagai gambar`,
        });
      }
      await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
    } else if (info.mime.includes("wordprocessingml")) {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      const c = cap(value);
      parts.push({ type: "file", assetId: id, name, mime: info.mime, text: c.text, ...(c.note ? { note: c.note } : {}) });
    } else {
      const c = cap(bytes.toString("utf8"));
      parts.push({ type: "file", assetId: id, name, mime: info.mime, text: c.text, ...(c.note ? { note: c.note } : {}) });
    }
  }
  return parts;
}
