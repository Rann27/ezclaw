import type { MessageDto } from "@ezclaw/core";
import { FileTextIcon, XIcon } from "@phosphor-icons/react";
import { AssetImage } from "../image/AssetImage";

export interface PendingAttachment {
  /** Local key while uploading; the asset id once stored. */
  key: string;
  assetId: string | null;
  name: string;
  kind: "image" | "pdf" | "docx" | "text" | null;
  error: string | null;
}

const KIND_LABEL = { pdf: "PDF", docx: "DOCX", text: "Teks", image: "Gambar" } as const;

/** Files waiting to go with the next message. */
export function AttachmentTray({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Lampiran">
      {items.map((a) => (
        <li key={a.key} className={`flex max-w-64 items-center gap-2 rounded-sm border px-2 py-1 text-dense ${a.error ? "border-danger bg-danger-soft text-danger-text" : "border-line bg-surface"}`}>
          {a.kind === "image" && a.assetId ? (
            <AssetImage assetId={a.assetId} alt="" className="h-8 w-8 shrink-0 rounded-xs" />
          ) : (
            <FileTextIcon size={18} className="shrink-0 text-fg-3" aria-hidden />
          )}
          <span className="grid min-w-0">
            <span className="truncate">{a.name}</span>
            <span className="text-meta text-fg-3">{a.error ?? (a.assetId ? (a.kind ? KIND_LABEL[a.kind] : "") : "Mengunggah")}</span>
          </span>
          <button type="button" className="btn btn-ghost min-h-7 shrink-0 px-1" aria-label={`Hapus lampiran ${a.name}`} onClick={() => onRemove(a.key)}>
            <XIcon size={14} aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Attachments of a sent message: images as thumbnails, documents as chips. */
export function MessageAttachments({ message }: { message: Pick<MessageDto, "parts"> }) {
  const images = message.parts.filter((p) => p.type === "image");
  const files = message.parts.filter((p) => p.type === "file");
  if (!images.length && !files.length) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {images.map((p) =>
        p.type === "image" ? (
          <AssetImage key={p.assetId} assetId={p.assetId} alt={p.role ?? "Lampiran"} className="h-24 w-24 rounded-sm border border-line" />
        ) : null,
      )}
      {files.map((p) =>
        p.type === "file" ? (
          <span key={p.assetId} className="flex max-w-72 items-center gap-2 rounded-sm border border-line bg-surface px-2 py-1 text-dense" title={p.note ?? undefined}>
            <FileTextIcon size={16} className="shrink-0 text-fg-3" aria-hidden />
            <span className="grid min-w-0">
              <span className="truncate">{p.name}</span>
              <span className="truncate text-meta text-fg-3">{p.note ?? `${p.text.length.toLocaleString("id-ID")} karakter dibaca`}</span>
            </span>
          </span>
        ) : null,
      )}
    </div>
  );
}
