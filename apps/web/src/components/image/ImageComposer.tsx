import { IMAGE_ROLES, IMAGE_ROLE_LABELS, type ImageParams, type ImageReference, type ImageRole, type ImageSpec, type ModelDto } from "@ezclaw/core";
import { ArrowUpIcon, ImagesIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { ACCEPTED_IMAGE_TYPES, uploadAsset } from "../../lib/assets";
import { ModelChip } from "../ModelPicker";
import { AssetImage } from "./AssetImage";

interface Props {
  model: ModelDto | null;
  /** What the model accepts; null while it loads or when no model is chosen. */
  spec: ImageSpec | null;
  onPickModel: () => void;
  running: boolean;
  keyMissing: boolean;
  text: string;
  onText: (v: string) => void;
  references: ImageReference[];
  onReferences: (r: ImageReference[]) => void;
  params: ImageParams;
  onParams: (p: ImageParams) => void;
  onSend: () => Promise<void>;
  onStop: () => void;
  error: string | null;
  focusSignal: number;
}

export function ImageComposer({ model, spec, onPickModel, running, keyMissing, text, onText, references, onReferences, params, onParams, onSend, onStop, error, focusSignal }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const hintId = useId();
  const countId = useId();
  const ratioId = useId();

  useEffect(() => {
    area.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const maxRefs = spec?.maxInputImages ?? 0;
  const refsDisabledReason = !model ? "Pilih model dulu." : !spec ? "Memuat kemampuan model." : maxRefs === 0 ? "Model ini tidak menerima gambar referensi." : null;
  const overLimit = spec && references.length > maxRefs && maxRefs > 0 ? references.length - maxRefs : 0;
  const blocker = !model ? "Pilih model gambar untuk mulai." : keyMissing ? `Endpoint ${model.endpointName} belum punya key.` : null;
  const canSend = !blocker && text.trim().length > 0 && !running && !sending && uploading === 0;

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      if (files.length) setUploadError("File yang dipilih bukan gambar.");
      return;
    }
    if (refsDisabledReason) {
      setUploadError(refsDisabledReason);
      return;
    }
    setUploadError(null);
    setUploading((n) => n + images.length);
    const added: ImageReference[] = [];
    for (const f of images) {
      try {
        const asset = await uploadAsset(f);
        added.push({ assetId: asset.id });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Gambar tidak bisa diunggah.");
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (added.length) onReferences([...references, ...added.filter((a) => !references.some((r) => r.assetId === a.assetId))]);
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (running) return onStop();
    if (!canSend) return;
    setSending(true);
    try {
      await onSend();
    } catch {
      // The parent shows the error and everything typed stays.
    } finally {
      setSending(false);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files];
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void addFiles([...e.dataTransfer.files]);
  };

  const ratios = spec?.aspectRatios.length ? { label: "Rasio", key: "aspectRatio" as const, options: spec.aspectRatios } : spec?.sizes.length ? { label: "Ukuran", key: "size" as const, options: spec.sizes } : null;
  const maxN = spec?.maxN ?? 1;

  return (
    <form
      onSubmit={submit}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`mx-auto mb-4 grid w-[calc(100%-2rem)] max-w-[calc(var(--read-max)+3rem)] gap-2 rounded-lg border bg-raised p-3 focus-within:border-line-strong ${dragging ? "border-brand-strong" : "border-line"}`}
      aria-label="Buat gambar"
    >
      {(references.length > 0 || refsDisabledReason === null) && (
        <div className="flex flex-wrap items-start gap-2" aria-label="Gambar referensi">
          {references.map((r, i) => (
            <div key={r.assetId} className="grid w-24 gap-1">
              <div className="relative">
                <AssetImage assetId={r.assetId} alt={`Referensi ${i + 1}`} className="h-24 w-24 rounded-sm" />
                <button
                  type="button"
                  className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-surface text-fg shadow-popover"
                  aria-label={`Hapus referensi ${i + 1}`}
                  onClick={() => onReferences(references.filter((x) => x.assetId !== r.assetId))}
                >
                  <XIcon size={12} aria-hidden />
                </button>
                {maxRefs > 0 && i >= maxRefs && <span className="absolute bottom-1 left-1 rounded-sm bg-surface px-1 text-meta text-fg-2">tidak dikirim</span>}
              </div>
              <label className="sr-only" htmlFor={`${hintId}-role-${i}`}>
                Peran referensi {i + 1}
              </label>
              <select
                id={`${hintId}-role-${i}`}
                className="select min-h-7 py-0 text-meta"
                value={r.role ?? ""}
                onChange={(e) => onReferences(references.map((x) => (x.assetId === r.assetId ? { assetId: x.assetId, ...(e.target.value ? { role: e.target.value as ImageRole } : {}) } : x)))}
              >
                <option value="">Tanpa peran</option>
                {IMAGE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {IMAGE_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {uploading > 0 && (
            <div className="grid h-24 w-24 place-items-center rounded-sm bg-sunken text-meta text-fg-2" role="status">
              <span className="node node-run" aria-hidden />
              Mengunggah
            </div>
          )}
        </div>
      )}

      <label htmlFor={`${hintId}-prompt`} className="sr-only">
        Prompt gambar
      </label>
      <textarea
        id={`${hintId}-prompt`}
        ref={area}
        value={text}
        rows={2}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        placeholder={references.length ? "Jelaskan gambar yang diinginkan, dengan referensi di atas" : "Jelaskan gambar yang diinginkan"}
        aria-describedby={hintId}
        className="w-full resize-none border-0 bg-transparent p-1 text-body leading-[1.62] text-fg placeholder:text-fg-3 focus-visible:outline-none"
      />

      <div className="flex flex-wrap items-center gap-2">
        <ModelChip model={model} onClick={onPickModel} disabled={running} />
        <input ref={file} type="file" accept={ACCEPTED_IMAGE_TYPES} multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => file.current?.click()}
          disabled={!!refsDisabledReason || running}
          title={refsDisabledReason ?? "Tambah gambar referensi (atau tempel dan seret ke sini)"}
        >
          <ImagesIcon size={16} aria-hidden />
          Referensi
        </button>
        {ratios && (
          <>
            <label htmlFor={ratioId} className="sr-only">
              {ratios.label}
            </label>
            <select id={ratioId} className="select w-auto" value={params[ratios.key] ?? ""} disabled={running} onChange={(e) => onParams({ ...params, [ratios.key]: e.target.value || undefined })}>
              <option value="">{ratios.label}: bawaan</option>
              {ratios.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </>
        )}
        {maxN > 1 && (
          <>
            <label htmlFor={countId} className="sr-only">
              Jumlah gambar
            </label>
            <select id={countId} className="select w-auto" value={params.n ?? 1} disabled={running} onChange={(e) => onParams({ ...params, n: Number(e.target.value) })}>
              {Array.from({ length: maxN }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} gambar
                </option>
              ))}
            </select>
          </>
        )}
        <span className="flex-1" />
        <button type="submit" className={running ? "btn btn-secondary" : "btn btn-primary"} disabled={!running && !canSend}>
          {running ? <StopIcon size={16} weight="fill" aria-hidden /> : <ArrowUpIcon size={16} aria-hidden />}
          {running ? "Stop" : "Buat"}
        </button>
      </div>

      <p id={hintId} className="text-meta text-fg-3">
        {blocker ?? (
          <>
            Ctrl+Enter untuk membuat.{" "}
            {refsDisabledReason && references.length === 0 ? refsDisabledReason : "Tempel atau seret gambar ke sini untuk menambah referensi."}
          </>
        )}
        {keyMissing && (
          <>
            {" "}
            <Link to="/settings/endpoints" className="text-brand-text underline">
              Buka Settings
            </Link>
          </>
        )}
      </p>
      {overLimit > 0 && (
        <p className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2" role="status">
          Model ini menerima paling banyak {maxRefs} referensi. {overLimit} referensi terakhir tidak akan dikirim.
        </p>
      )}
      {(uploadError || error) && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {uploadError ?? error}
        </p>
      )}
    </form>
  );
}
