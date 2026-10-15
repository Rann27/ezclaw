import { IMAGE_ROLE_LABELS, IMAGE_WIRE_LABELS, type ImageParams, type ImageReference, type ImageRole, type ImageWire, type MessageDto } from "@ezclaw/core";
import { Link } from "@tanstack/react-router";
import { ArrowsOutIcon, PaintBrushIcon, ClipboardTextIcon, CodeIcon, DownloadSimpleIcon, DiceFiveIcon, PlusIcon } from "@phosphor-icons/react";
import { useRef, useState, type ReactNode } from "react";
import { downloadAsset } from "../../lib/assets";
import { Dialog } from "../Dialog";
import { AssetImage } from "./AssetImage";
import type { LiveImageRun, Slot } from "./useImageRun";

export interface RunRequest {
  text: string;
  exact: boolean;
  references: ImageReference[];
  params: ImageParams;
}

const textOf = (m: MessageDto) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

export function UserTurn({ message }: { message: MessageDto }) {
  const refs = message.parts.flatMap((p) => (p.type === "image" ? [p] : []));
  return (
    <div className="flex justify-end">
      <div className="grid max-w-[min(56ch,100%)] gap-2 rounded-md bg-sunken px-4 py-3">
        {refs.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Gambar referensi">
            {refs.map((r, i) => (
              <li key={r.assetId} className="grid w-20 gap-1">
                <AssetImage assetId={r.assetId} alt={`Referensi ${i + 1}`} className="h-20 w-20 rounded-sm" />
                {r.role && <span className="truncate text-meta text-fg-2">{IMAGE_ROLE_LABELS[r.role as ImageRole] ?? r.role}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="whitespace-pre-wrap break-words text-body">{textOf(message)}</p>
      </div>
    </div>
  );
}

interface TurnProps {
  message: MessageDto;
  live: LiveImageRun | null;
  running: boolean;
  /** How many reference images the current model takes; 0 disables "use as reference". */
  maxReferences: number;
  onShowRequest: (messageId: string) => void;
  onRun: (r: RunRequest) => Promise<void>;
  onUseAsReference: (assetId: string) => void;
}

export function AssistantTurn({ message, live, running, maxReferences, onShowRequest, onRun, onUseAsReference }: TurnProps) {
  const meta = message.image;
  const streaming = live ? !live.disconnected : message.status === "streaming";
  const composed = live?.composed ?? null;
  const notes = live ? live.notes : message.notes;
  const [zoom, setZoom] = useState<string | null>(null);

  const done = message.parts.flatMap((p) => (p.type === "image" ? [p] : []));
  const slots: Slot[] = live && live.slots.length > 0 ? live.slots : done.map((p) => ({ status: "done" as const, assetId: p.assetId, ...(p.seed !== undefined ? { seed: p.seed } : {}) }));
  const sentPrompt = meta?.sentPrompt ?? (composed ? composed.prompt : null);
  const wasComposed = meta?.composed ?? composed !== null;
  const text = textOf(message);

  return (
    <article className="grid gap-3" aria-label="Hasil gambar" aria-busy={streaming}>
      {sentPrompt !== null && <PromptBlock key={message.id + (sentPrompt ?? "")} prompt={sentPrompt} composed={wasComposed} references={meta?.references ?? []} disabled={running} onResend={(t) => onRun({ text: t, exact: true, references: meta?.references ?? [], params: meta?.params ?? {} })} />}

      {slots.length > 0 && (
        <ul className={`grid gap-3 ${slots.length === 1 ? "max-w-md" : "sm:grid-cols-2"}`} aria-label="Gambar">
          {slots.map((s, i) => (
            <li key={s.assetId ?? i} className="grid content-start gap-2">
              <SlotView slot={s} index={i} onZoom={() => s.assetId && setZoom(s.assetId)} />
              {s.status === "done" && s.assetId && (
                <div className="flex flex-wrap gap-1">
                  <ActionButton icon={<ArrowsOutIcon size={14} aria-hidden />} label="Perbesar" onClick={() => setZoom(s.assetId!)} />
                  <Link to="/edit" search={{ target: s.assetId }} className="btn btn-ghost min-h-8 px-2 text-dense no-underline">
                    <PaintBrushIcon size={14} aria-hidden />
                    Edit gambar ini
                  </Link>
                  <ActionButton icon={<DownloadSimpleIcon size={14} aria-hidden />} label="Unduh" onClick={() => void downloadAsset(s.assetId!, `ezclaw-${s.assetId!.slice(0, 8)}.png`)} />
                  <ActionButton
                    icon={<PlusIcon size={14} aria-hidden />}
                    label="Jadikan referensi"
                    disabled={maxReferences === 0}
                    title={maxReferences === 0 ? "Model yang dipilih tidak menerima gambar referensi." : undefined}
                    onClick={() => onUseAsReference(s.assetId!)}
                  />
                  {sentPrompt && <CopyButton text={sentPrompt} />}
                  {s.seed !== undefined && meta && (
                    <ActionButton
                      icon={<DiceFiveIcon size={14} aria-hidden />}
                      label={`Ulangi, seed ${s.seed}`}
                      disabled={running}
                      onClick={() => void onRun({ text: meta.sentPrompt, exact: true, references: meta.references, params: { ...meta.params, seed: s.seed, n: 1 } }).catch(() => {})}
                    />
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {slots.length === 0 && streaming && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          {composed ? "Menyusun gambar" : "Menyiapkan permintaan"}
        </p>
      )}

      {text && <p className="whitespace-pre-wrap text-body text-fg-2">{text}</p>}

      {notes.length > 0 && (
        <ul className="grid gap-1 rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2" aria-label="Catatan">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      {live?.disconnected && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {live.disconnected}
        </p>
      )}
      {message.status === "error" && message.error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {message.error}
        </p>
      )}
      {message.status === "stopped" && <p className="text-dense text-fg-3">Dihentikan. Gambar yang sudah jadi tetap disimpan.</p>}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
        {message.modelLabel && <span className="font-code">{message.modelLabel}</span>}
        {meta && <span>{IMAGE_WIRE_LABELS[meta.wire as ImageWire] ?? meta.wire}</span>}
        {message.durationMs !== null && <span>{(message.durationMs / 1000).toFixed(1)} dtk</span>}
        <button type="button" className="inline-flex items-center gap-1 text-fg-2 underline" onClick={() => onShowRequest(message.id)}>
          <CodeIcon size={12} aria-hidden />
          Lihat request
        </button>
      </footer>

      <Dialog open={zoom !== null} onClose={() => setZoom(null)} title="Gambar" width="max-w-4xl">
        {zoom && <AssetImage assetId={zoom} alt="Gambar diperbesar" natural className="max-h-[75vh] rounded-sm object-contain" ratio="1 / 1" />}
      </Dialog>
    </article>
  );
}

function SlotView({ slot, index, onZoom }: { slot: Slot; index: number; onZoom: () => void }) {
  if (slot.status === "done" && slot.assetId) {
    return (
      <button type="button" className="block overflow-hidden rounded-md border border-line text-left" onClick={onZoom} aria-label={`Perbesar gambar ${index + 1}`}>
        <AssetImage assetId={slot.assetId} alt={`Hasil ${index + 1}`} natural ratio="1 / 1" />
      </button>
    );
  }
  if (slot.status === "error") {
    return (
      <div className="grid min-h-32 content-center gap-1 rounded-md bg-danger-soft p-4 text-dense text-danger-text" role="alert">
        <strong className="font-semibold">Gambar {index + 1} gagal</strong>
        <span className="break-words">{slot.error}</span>
      </div>
    );
  }
  return (
    <div className="grid aspect-square place-items-center rounded-md bg-sunken text-ui text-fg-2" role="status">
      <span className="grid justify-items-center gap-2">
        <span className={slot.status === "running" ? "node node-run" : "node"} aria-hidden />
        {slot.status === "running" ? "Sedang dibuat" : "Antri"}
      </span>
    </div>
  );
}

function ActionButton({ icon, label, onClick, disabled, title }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" onClick={onClick} disabled={disabled} title={title}>
      {icon}
      {label}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  return (
    <ActionButton
      icon={<ClipboardTextIcon size={14} aria-hidden />}
      label={copied ? "Tersalin" : "Salin prompt"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}

/** The prompt that went to the model, always visible, editable, and sendable again. Nothing is hidden. */
function PromptBlock({ prompt, composed, references, disabled, onResend }: { prompt: string; composed: boolean; references: ImageReference[]; disabled: boolean; onResend: (text: string) => Promise<void> }) {
  const [text, setText] = useState(prompt);
  const [error, setError] = useState<string | null>(null);
  const changed = text.trim() !== prompt.trim();
  return (
    <section aria-label="Prompt yang dikirim ke model" className="grid gap-2 rounded-md border border-line bg-surface p-3">
      <h3 className="text-meta font-semibold text-fg-2">{composed ? "Prompt hasil susunan Composer" : "Prompt yang dikirim"}</h3>
      {references.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Gambar input yang ikut dikirim">
          {references.map((r, i) => (
            <li key={r.assetId} className="flex items-center gap-2 rounded-sm bg-sunken p-1 pr-2 text-meta text-fg-2">
              <AssetImage assetId={r.assetId} alt={`Gambar input ${i + 1}`} className="h-10 w-10 rounded-sm" />
              Gambar {i + 1}
              {r.role ? `: ${IMAGE_ROLE_LABELS[r.role]}` : ""}
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="textarea min-h-16 text-dense"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        aria-label="Prompt yang dikirim, bisa diubah"
        spellCheck={false}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || !text.trim()}
          onClick={() => {
            setError(null);
            onResend(text).catch((e: unknown) => setError(e instanceof Error ? e.message : "Gagal mengirim."));
          }}
        >
          {changed ? "Kirim prompt yang diubah" : "Kirim ulang persis"}
        </button>
        {changed && (
          <button type="button" className="btn btn-ghost" onClick={() => setText(prompt)}>
            Kembalikan
          </button>
        )}
        <span className="text-meta text-fg-3">Dikirim apa adanya, tanpa Composer.</span>
      </div>
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
