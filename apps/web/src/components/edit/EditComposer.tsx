import { IMAGE_ROLES, IMAGE_ROLE_LABELS, KEEP_IDS, KEEP_LABELS, type ImageParams, type ImageReference, type ImageRole, type ImageSpec, type KeepId, type ModelDto } from "@ezclaw/core";
import { ArrowUpIcon, ImagesIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { ACCEPTED_IMAGE_TYPES } from "../../lib/assets";
import { ModelChip } from "../ModelPicker";
import { AssetImage } from "../image/AssetImage";

export interface EditRef {
  assetId: string;
  /** Required before sending: the model has to be told what each reference is for. */
  role?: ImageRole;
}

interface Props {
  model: ModelDto | null;
  spec: ImageSpec | null;
  hasTarget: boolean;
  targetLabel: string | null;
  onPickModel: () => void;
  running: boolean;
  keyMissing: boolean;
  text: string;
  onText: (v: string) => void;
  references: EditRef[];
  onReferences: (r: EditRef[]) => void;
  keep: KeepId[];
  onKeep: (k: KeepId[]) => void;
  params: ImageParams;
  onParams: (p: ImageParams) => void;
  /** The prompt the template produces from what is filled in. */
  compiled: string;
  /** The owner's own version of the prompt; null while the template is used. */
  manual: string | null;
  onManual: (v: string | null) => void;
  onAddFiles: (files: File[]) => Promise<string | null>;
  uploading: number;
  onSend: () => Promise<void>;
  onStop: () => void;
  error: string | null;
  focusSignal: number;
}

export function EditComposer(p: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const uid = useId();

  useEffect(() => {
    area.current?.focus();
  }, [p.focusSignal]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [p.text]);

  const maxInputs = p.spec?.maxInputImages ?? 0;
  const maxRefs = Math.max(0, maxInputs - 1);
  const cannotEdit = !!p.model && !!p.spec && maxInputs < 1;
  const refsReason = !p.model ? "Pilih model dulu." : !p.spec ? "Memuat kemampuan model." : cannotEdit ? "Model ini tidak menerima gambar input." : maxRefs === 0 ? "Model ini hanya menerima gambar yang diedit, tanpa referensi." : null;
  const missingRole = p.references.some((r) => !r.role);
  const overLimit = p.references.length > maxRefs && maxRefs >= 0 && p.spec ? p.references.length - maxRefs : 0;

  const blocker = !p.model
    ? "Pilih model gambar untuk mulai."
    : p.keyMissing
      ? `Endpoint ${p.model.endpointName} belum punya key.`
      : cannotEdit
        ? "Model ini tidak bisa mengedit: tidak menerima gambar input. Pilih model lain."
        : !p.hasTarget
          ? "Pilih gambar yang akan diedit."
          : missingRole
            ? "Pilih peran untuk setiap referensi."
            : null;
  const canSend = !blocker && (p.manual ?? p.text).trim().length > 0 && !p.running && !sending && p.uploading === 0;

  async function add(files: File[]) {
    setFileError(await p.onAddFiles(files));
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (p.running) return p.onStop();
    if (!canSend) return;
    setSending(true);
    try {
      await p.onSend();
    } catch {
      // The page shows the error and everything typed stays.
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
      void add(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void add([...e.dataTransfer.files]);
  };

  const ratios = p.spec?.aspectRatios.length ? { label: "Rasio", key: "aspectRatio" as const, options: p.spec.aspectRatios } : p.spec?.sizes.length ? { label: "Ukuran", key: "size" as const, options: p.spec.sizes } : null;
  const maxN = p.spec?.maxN ?? 1;
  const toggleKeep = (k: KeepId) => p.onKeep(p.keep.includes(k) ? p.keep.filter((x) => x !== k) : [...p.keep, k]);

  return (
    <form
      onSubmit={submit}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      aria-label="Edit gambar"
      className={`mx-auto mb-4 grid w-[calc(100%-2rem)] max-w-[calc(var(--read-max)+3rem)] gap-3 rounded-lg border bg-raised p-3 focus-within:border-line-strong ${dragging ? "border-brand-strong" : "border-line"}`}
    >
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-meta font-semibold text-fg-2">Referensi {p.references.length > 0 && `(${p.references.length})`}</h3>
          {p.references.length === 0 && p.uploading === 0 && (
            <button type="button" className="btn btn-secondary min-h-8 px-2 text-dense" disabled={!!refsReason || p.running} title={refsReason ?? "Tambah gambar referensi"} onClick={() => file.current?.click()}>
              <ImagesIcon size={14} aria-hidden />
              Tambah referensi
            </button>
          )}
          {refsReason && p.references.length === 0 && <span className="text-meta text-fg-3">{refsReason}</span>}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {p.references.map((r, i) => (
            <div key={r.assetId} className="grid w-24 gap-1">
              <div className="relative">
                <AssetImage assetId={r.assetId} alt={`Referensi ${i + 1}`} className="h-24 w-24 rounded-sm" />
                <button type="button" className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-surface text-fg shadow-popover" aria-label={`Hapus referensi ${i + 1}`} onClick={() => p.onReferences(p.references.filter((x) => x.assetId !== r.assetId))}>
                  <XIcon size={12} aria-hidden />
                </button>
                {i >= maxRefs && p.spec && <span className="absolute bottom-1 left-1 rounded-sm bg-surface px-1 text-meta text-fg-2">tidak dikirim</span>}
              </div>
              <label className="sr-only" htmlFor={`${uid}-role-${i}`}>
                Peran referensi {i + 1}
              </label>
              <select
                id={`${uid}-role-${i}`}
                className="select min-h-7 py-0 text-meta"
                value={r.role ?? ""}
                aria-invalid={!r.role}
                onChange={(e) => p.onReferences(p.references.map((x) => (x.assetId === r.assetId ? { assetId: x.assetId, ...(e.target.value ? { role: e.target.value as ImageRole } : {}) } : x)))}
              >
                <option value="" disabled>
                  Pilih peran
                </option>
                {IMAGE_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {IMAGE_ROLE_LABELS[role]}
                  </option>
                ))}
              </select>
            </div>
          ))}
          {p.uploading > 0 && (
            <div className="grid h-24 w-24 place-items-center rounded-sm bg-sunken text-meta text-fg-2" role="status">
              <span className="node node-run" aria-hidden />
              Mengunggah
            </div>
          )}
          <input ref={file} type="file" accept={ACCEPTED_IMAGE_TYPES} multiple hidden onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ""; }} />
          {p.references.length > 0 && (
            <button type="button" className="btn btn-secondary h-24 w-24 flex-col" disabled={!!refsReason || p.running} title={refsReason ?? "Tambah gambar referensi"} onClick={() => file.current?.click()}>
              <ImagesIcon size={18} aria-hidden />
              Tambah
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-1">
        <h3 id={`${uid}-keep`} className="text-meta font-semibold text-fg-2">
          Pertahankan
        </h3>
        <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby={`${uid}-keep`}>
          {KEEP_IDS.map((k) => (
            <button key={k} type="button" className="chip-toggle" aria-pressed={p.keep.includes(k)} onClick={() => toggleKeep(k)} disabled={p.running}>
              {KEEP_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      <label htmlFor={`${uid}-text`} className="sr-only">
        Instruksi edit
      </label>
      <textarea
        id={`${uid}-text`}
        ref={area}
        value={p.text}
        rows={2}
        onChange={(e) => p.onText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        placeholder={p.hasTarget ? "Apa yang diubah? Contoh: jadikan senja, hapus tiang lampu" : "Pilih gambar yang diedit dulu, lalu tulis instruksinya"}
        className="w-full resize-none border-0 bg-transparent p-1 text-body leading-[1.62] text-fg placeholder:text-fg-3 focus-visible:outline-none"
      />

      <details className="rounded-sm bg-sunken px-3 py-2">
        <summary className="cursor-pointer text-dense font-semibold text-fg-2">{p.manual !== null ? "Prompt diubah manual" : "Lihat atau ubah prompt yang akan dikirim"}</summary>
        <div className="mt-2 grid gap-2">
          <label htmlFor={`${uid}-compiled`} className="sr-only">
            Prompt hasil kompilasi
          </label>
          <textarea
            id={`${uid}-compiled`}
            className="textarea min-h-28 text-dense"
            value={p.manual ?? p.compiled}
            onChange={(e) => p.onManual(e.target.value)}
            spellCheck={false}
            readOnly={p.running}
          />
          <div className="flex flex-wrap items-center gap-2">
            {p.manual !== null && (
              <button type="button" className="btn btn-ghost" onClick={() => p.onManual(null)}>
                Kembali ke template
              </button>
            )}
            <span className="text-meta text-fg-3">{p.manual !== null ? "Dikirim apa adanya, dengan gambar tetap berurutan: yang diedit lebih dulu." : "Template ini menyebut urutan gambar, peran referensi, dan hal yang dipertahankan."}</span>
          </div>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2">
        <ModelChip model={p.model} onClick={p.onPickModel} disabled={p.running} />
        {ratios && (
          <>
            <label htmlFor={`${uid}-ratio`} className="sr-only">
              {ratios.label}
            </label>
            <select id={`${uid}-ratio`} className="select w-auto" value={p.params[ratios.key] ?? ""} disabled={p.running} onChange={(e) => p.onParams({ ...p.params, [ratios.key]: e.target.value || undefined })}>
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
            <label htmlFor={`${uid}-n`} className="sr-only">
              Jumlah hasil
            </label>
            <select id={`${uid}-n`} className="select w-auto" value={p.params.n ?? 1} disabled={p.running} onChange={(e) => p.onParams({ ...p.params, n: Number(e.target.value) })}>
              {Array.from({ length: maxN }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} hasil
                </option>
              ))}
            </select>
          </>
        )}
        <span className="flex-1" />
        <button type="submit" className={p.running ? "btn btn-secondary" : "btn btn-primary"} disabled={!p.running && !canSend}>
          {p.running ? <StopIcon size={16} weight="fill" aria-hidden /> : <ArrowUpIcon size={16} aria-hidden />}
          {p.running ? "Stop" : "Edit"}
        </button>
      </div>

      <p className="text-meta text-fg-3">
        {blocker ?? (p.targetLabel ? `Mengedit ${p.targetLabel}. Ctrl+Enter untuk mengirim.` : "Ctrl+Enter untuk mengirim.")}
        {p.keyMissing && (
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
          Model ini menerima {maxInputs} gambar input: 1 yang diedit dan {maxRefs} referensi. {overLimit} referensi terakhir tidak akan dikirim.
        </p>
      )}
      {(fileError || p.error) && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {fileError ?? p.error}
        </p>
      )}
    </form>
  );
}
