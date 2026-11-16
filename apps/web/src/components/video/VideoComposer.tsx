import { FOLLOW_FRAME, type ModelDto, type VideoParams, type VideoQuoteResponse, type VideoSpec } from "@ezclaw/core";
import { ArrowUpIcon, ImageSquareIcon, SpeakerHighIcon, SpeakerSlashIcon, StopIcon, XIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent } from "react";
import { ACCEPTED_IMAGE_TYPES, uploadAsset } from "../../lib/assets";
import { ModelChip } from "../ModelPicker";
import { AssetImage } from "../image/AssetImage";

export interface Frames {
  start?: string;
  end?: string;
}

interface Props {
  model: ModelDto | null;
  spec: VideoSpec | null;
  onPickModel: () => void;
  running: boolean;
  keyMissing: boolean;
  text: string;
  onText: (v: string) => void;
  frames: Frames;
  onFrames: (f: Frames) => void;
  params: VideoParams;
  onParams: (p: VideoParams) => void;
  onSend: () => Promise<void>;
  onStop: () => void;
  error: string | null;
  focusSignal: number;
  /** Price of the job with the settings shown; undefined while it is being asked. */
  estimate: VideoQuoteResponse | null | undefined;
}

/** Durations the owner can pick: the model's list, or every whole second in its range. */
export function durationOptions(spec: VideoSpec | null): number[] {
  if (!spec) return [];
  if (spec.durations.length) return spec.durations;
  if (spec.durationRange) return Array.from({ length: spec.durationRange.max - spec.durationRange.min + 1 }, (_, i) => spec.durationRange!.min + i);
  return [];
}

export function VideoComposer({ model, spec, onPickModel, running, keyMissing, text, onText, frames, onFrames, params, onParams, onSend, onStop, error, focusSignal, estimate }: Props) {
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const target = useRef<"start" | "end">("start");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<"start" | "end" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const id = useId();

  useEffect(() => {
    area.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  // A text model with an image-to-video sibling still takes a start frame: the server switches models.
  const startOk = !!spec && (spec.startFrame || !!spec.pairedModelId);
  const endOk = !!spec?.endFrame;
  const framesReason = !model ? "Pilih model dulu." : !spec ? "Memuat kemampuan model." : !startOk ? "Model ini hanya membuat video dari teks." : null;
  const needsFrame = !!spec && !spec.textToVideo && !spec.pairedModelId;
  const blocker = !model ? "Pilih model video untuk mulai." : keyMissing ? `Endpoint ${model.endpointName} belum punya key.` : needsFrame && !frames.start ? "Model ini butuh frame awal." : null;
  const hasPrompt = text.trim().length > 0;
  const canSend = !blocker && (hasPrompt || !!frames.start) && !running && !sending && uploading === null;

  async function setFrame(slot: "start" | "end", f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setUploadError("File yang dipilih bukan gambar.");
    if (framesReason) return setUploadError(framesReason);
    if (slot === "end" && !endOk) return setUploadError("Model ini tidak menerima frame akhir.");
    setUploadError(null);
    setUploading(slot);
    try {
      const asset = await uploadAsset(f);
      onFrames({ ...frames, [slot]: asset.id });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Gambar tidak bisa diunggah.");
    } finally {
      setUploading(null);
    }
  }

  const nextSlot = (): "start" | "end" => (!frames.start ? "start" : endOk && !frames.end ? "end" : "start");

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (running) return onStop();
    if (!canSend) return;
    setSending(true);
    try {
      await onSend();
    } catch {
      // The parent shows the error; the prompt and frames stay.
    } finally {
      setSending(false);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void submit();
  };
  const onPaste = (e: ClipboardEvent) => {
    const f = [...e.clipboardData.files][0];
    if (f) {
      e.preventDefault();
      void setFrame(nextSlot(), f);
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void setFrame(nextSlot(), [...e.dataTransfer.files][0]);
  };

  const durations = durationOptions(spec);
  // "adaptive" / "auto" are shown as the empty choice: follow the frame.
  const fixedRatios = spec?.aspectRatios.filter((r) => !FOLLOW_FRAME.includes(r)) ?? [];
  const followsFrame = !!frames.start && !!spec?.aspectRatios.some((r) => FOLLOW_FRAME.includes(r));
  const ratioLocked = !!frames.start && !followsFrame && spec?.wire !== "venice-video";

  const slot = (which: "start" | "end", label: string) => {
    const assetId = frames[which];
    if (assetId) {
      return (
        <div className="relative">
          <AssetImage assetId={assetId} alt={label} className="h-20 w-28 rounded-sm" ratio="7 / 5" />
          <span className="absolute bottom-1 left-1 rounded-xs bg-surface px-1 text-meta text-fg-2">{label}</span>
          <button
            type="button"
            className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-surface text-fg shadow-popover"
            aria-label={`Hapus ${label.toLowerCase()}`}
            disabled={running}
            onClick={() => onFrames(which === "start" ? {} : { ...frames, end: undefined })}
          >
            <XIcon size={12} aria-hidden />
          </button>
        </div>
      );
    }
    return (
      <button
        type="button"
        className="frame-slot"
        disabled={running || !!framesReason || (which === "end" && !frames.start)}
        title={framesReason ?? (which === "end" && !frames.start ? "Pasang frame awal dulu." : undefined)}
        onClick={() => {
          target.current = which;
          file.current?.click();
        }}
      >
        {uploading === which ? <span className="node node-run" aria-hidden /> : <ImageSquareIcon size={18} aria-hidden />}
        <span>{uploading === which ? "Mengunggah" : label}</span>
      </button>
    );
  };

  return (
    <form
      onSubmit={submit}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`composer-surface mx-auto mb-3 grid w-[calc(100%-2rem)] max-w-[var(--work-max)] gap-1.5 ${dragging ? "border-brand-strong" : ""}`}
      aria-label="Buat video"
    >
      {(startOk || frames.start) && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Frame untuk image-to-video">
          {slot("start", "Frame awal")}
          {(endOk || frames.end) && slot("end", "Frame akhir")}
          <input
            ref={file}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            hidden
            onChange={(e) => {
              void setFrame(target.current, e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      )}

      <label htmlFor={`${id}-prompt`} className="composer-label">
        Prompt video
      </label>
      <textarea
        id={`${id}-prompt`}
        ref={area}
        value={text}
        rows={1}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        placeholder={frames.start ? "Gerakan, kamera, dan suasana yang diinginkan dari frame awal" : "Jelaskan adegan, gerakan, dan kameranya"}
        aria-describedby={`${id}-hint`}
        className="w-full resize-none border-0 bg-transparent p-1 text-body leading-[1.62] text-fg placeholder:text-fg-3 focus-visible:outline-none"
      />

      <div className="composer-toolbar flex flex-wrap items-center gap-2">
        <ModelChip model={model} onClick={onPickModel} disabled={running} />
        {durations.length > 0 && (
          <>
            <label htmlFor={`${id}-dur`} className="sr-only">
              Durasi
            </label>
            <select id={`${id}-dur`} className="select w-auto" value={params.duration ?? ""} disabled={running} onChange={(e) => onParams({ ...params, duration: e.target.value ? Number(e.target.value) : undefined })}>
              <option value="">Durasi: bawaan</option>
              {durations.map((d) => (
                <option key={d} value={d}>
                  {d} detik
                </option>
              ))}
            </select>
          </>
        )}
        {spec && spec.resolutions.length > 0 && (
          <>
            <label htmlFor={`${id}-res`} className="sr-only">
              Resolusi
            </label>
            <select id={`${id}-res`} className="select w-auto" value={params.resolution ?? ""} disabled={running} onChange={(e) => onParams({ ...params, resolution: e.target.value || undefined })}>
              <option value="">Resolusi: bawaan</option>
              {spec.resolutions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </>
        )}
        {spec && fixedRatios.length > 0 && (
          <>
            <label htmlFor={`${id}-ratio`} className="sr-only">
              Rasio
            </label>
            <select
              id={`${id}-ratio`}
              className="select w-auto"
              value={ratioLocked ? "" : (params.aspectRatio ?? "")}
              disabled={running || ratioLocked}
              title={ratioLocked ? "Rasio mengikuti frame awal." : undefined}
              onChange={(e) => onParams({ ...params, aspectRatio: e.target.value || undefined })}
            >
              <option value="">{ratioLocked || followsFrame ? "Rasio: ikut frame" : "Rasio: bawaan"}</option>
              {fixedRatios.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </>
        )}
        {spec?.audio === "optional" && (
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={params.audio !== false}
            disabled={running}
            onClick={() => onParams({ ...params, audio: params.audio === false })}
            title={params.audio === false ? "Tanpa suara. Klik untuk menyalakan suara." : "Dengan suara. Klik untuk membuat video tanpa suara."}
          >
            {params.audio === false ? <SpeakerSlashIcon size={16} aria-hidden /> : <SpeakerHighIcon size={16} aria-hidden />}
            {params.audio === false ? "Tanpa suara" : "Suara"}
          </button>
        )}
        <span className="flex-1" />
        {model && !running && (
          <span className="text-dense text-fg-2" aria-live="polite" title={estimate?.error ?? estimate?.source ?? undefined}>
            {estimate === undefined ? "Menghitung biaya" : estimate === null ? "" : estimate.error ? "Tidak bisa dikirim" : estimate.usd !== null ? `Perkiraan $${estimate.usd.toFixed(3)}` : "Biaya diketahui setelah selesai"}
          </span>
        )}
        <button type="submit" className={running ? "btn btn-secondary" : "btn btn-primary"} disabled={!running && !canSend}>
          {running ? <StopIcon size={16} weight="fill" aria-hidden /> : <ArrowUpIcon size={16} aria-hidden />}
          {running ? "Stop" : "Buat"}
        </button>
      </div>

      <p id={`${id}-hint`} className="text-meta text-fg-3">
        {blocker ?? (
          <>
            Ctrl+Enter untuk membuat. {startOk ? "Tempel atau seret gambar ke sini untuk frame awal." : framesReason}
            {spec?.audio === "always" ? " Model ini selalu menambahkan suara." : ""}
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
      {estimate?.error && !running && !error && (
        <p className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2" role="status">
          {estimate.error}
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
