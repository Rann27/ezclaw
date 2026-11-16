import { VIDEO_WIRE_LABELS, type MessageDto, type VideoParams } from "@ezclaw/core";
import { ArrowClockwiseIcon, CodeIcon, DownloadSimpleIcon, FilmSlateIcon, FilmStripIcon, ImageSquareIcon, SkipForwardIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { downloadAsset, uploadAsset, useAssetUrl } from "../../lib/assets";
import { AssetImage } from "../image/AssetImage";
import type { LiveVideoRun } from "./useVideoRun";

const textOf = (m: MessageDto) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");

export function UserTurn({ message }: { message: MessageDto }) {
  const frames = message.parts.flatMap((p) => (p.type === "image" ? [p] : []));
  const text = textOf(message);
  return (
    <div className="flex justify-end">
      <div className="grid max-w-[min(56ch,100%)] gap-2 rounded-md bg-sunken px-4 py-3">
        {frames.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Frame">
            {frames.map((f) => (
              <li key={f.assetId} className="grid w-28 gap-1">
                <AssetImage assetId={f.assetId} alt={f.role === "end_frame" ? "Frame akhir" : "Frame awal"} className="h-20 w-28 rounded-sm" ratio="7 / 5" />
                <span className="text-meta text-fg-2">{f.role === "end_frame" ? "Frame akhir" : "Frame awal"}</span>
              </li>
            ))}
          </ul>
        )}
        {text ? <p className="whitespace-pre-wrap break-words text-body">{text}</p> : <p className="text-dense text-fg-3">Tanpa prompt: gerakan dari gambarnya saja.</p>}
      </div>
    </div>
  );
}

export interface ResendRequest {
  text: string;
  params: VideoParams;
  startFrame?: string;
  endFrame?: string;
}

interface TurnProps {
  message: MessageDto;
  live: LiveVideoRun | null;
  running: boolean;
  onShowRequest: (messageId: string) => void;
  onResend: (r: ResendRequest) => Promise<void>;
  /** Puts a picture taken from a result into the composer as the next start frame. */
  onUseFrame: (assetId: string) => void;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Waiting view: what the job is doing, time so far, and the provider's progress or estimate when it gives one. */
function Progress({ live }: { live: LiveVideoRun | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const stage = live?.stage ?? null;
  const elapsed = live ? live.elapsedMs + (stage ? Date.now() - live.reportedAt : 0) : 0;
  const pct = live?.progress ?? null;
  const label = stage === null ? "Menyiapkan job" : stage === "submitted" ? "Mengirim job ke provider" : stage === "downloading" ? "Mengunduh video" : "Video sedang dibuat di provider";
  return (
    <div className="video-pending" role="status" aria-live="polite">
      <FilmStripIcon size={28} weight="duotone" aria-hidden className="text-fg-3" />
      <p className="text-ui text-fg">{label}</p>
      <p className="text-dense text-fg-2">
        {stage ? clock(elapsed) : ""}
        {live?.etaMs ? ` dari perkiraan ${clock(live.etaMs)}` : ""}
      </p>
      <div className="video-progress" aria-hidden>
        <span className={pct === null ? "video-progress-indeterminate" : ""} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <p className="text-meta text-fg-3">Boleh pindah halaman atau menutup tab. Job tetap ditunggu di server, juga setelah EZClaw dimulai ulang.</p>
    </div>
  );
}

function Player({ assetId, onUseFrame }: { assetId: string; onUseFrame: (assetId: string) => void }) {
  const url = useAssetUrl(assetId);
  const video = useRef<HTMLVideoElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Draws the frame on show into a picture and stores it, so it can start the next video. */
  async function capture(last: boolean) {
    const v = video.current;
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      if (last && Number.isFinite(v.duration)) {
        v.pause();
        await new Promise<void>((resolve) => {
          v.addEventListener("seeked", () => resolve(), { once: true });
          v.currentTime = Math.max(0, v.duration - 0.05);
        });
      }
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      canvas.getContext("2d")!.drawImage(v, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Frame tidak bisa diambil.");
      onUseFrame((await uploadAsset(blob)).id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Frame tidak bisa diambil.");
    } finally {
      setBusy(false);
    }
  }

  if (url.isError) return <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text">{url.error.message}</p>;
  return (
    <div className="grid gap-2">
      {url.data ? (
        // Generated clips carry no captions to offer.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video ref={video} src={url.data} controls loop playsInline className="video-result" aria-label="Video hasil" />
      ) : (
        <div className="video-pending" role="status">
          <span className="node node-run" aria-hidden />
          <p className="text-dense text-fg-2">Memuat video</p>
        </div>
      )}
      <div className="flex flex-wrap gap-1">
        <ActionButton icon={<DownloadSimpleIcon size={14} aria-hidden />} label="Unduh" onClick={() => void downloadAsset(assetId, `ezclaw-${assetId.slice(0, 8)}.mp4`)} />
        <ActionButton icon={<ImageSquareIcon size={14} aria-hidden />} label="Frame ini jadi frame awal" disabled={!url.data || busy} onClick={() => void capture(false)} />
        <ActionButton icon={<SkipForwardIcon size={14} aria-hidden />} label="Lanjutkan dari frame terakhir" disabled={!url.data || busy} onClick={() => void capture(true)} />
      </div>
      {error && (
        <p className="text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function AssistantTurn({ message, live, running, onShowRequest, onResend, onUseFrame }: TurnProps) {
  const meta = message.video;
  const streaming = message.status === "streaming";
  const result = message.parts.find((p) => p.type === "video");
  const notes = [...message.notes, ...(live?.notes ?? []).filter((n) => !message.notes.includes(n))];

  return (
    <article className="grid gap-3" aria-label="Hasil video" aria-busy={streaming}>
      {result && result.type === "video" ? <Player assetId={result.assetId} onUseFrame={onUseFrame} /> : streaming ? <Progress live={live} /> : null}

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
      {message.status === "stopped" && <p className="text-dense text-fg-3">Berhenti menunggu video ini.</p>}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
        {message.modelLabel && <span className="font-code">{message.modelLabel}</span>}
        {meta && <span>{VIDEO_WIRE_LABELS[meta.wire] ?? meta.wire}</span>}
        {meta?.params.duration !== undefined && <span>{meta.params.duration} detik</span>}
        {meta?.params.resolution && <span>{meta.params.resolution}</span>}
        {message.usage?.costUsd !== undefined && <span>${message.usage.costUsd.toFixed(3)}</span>}
        {message.durationMs !== null && !streaming && <span>dibuat dalam {clock(message.durationMs)}</span>}
        {meta && !streaming && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-fg-2 underline disabled:opacity-50"
            disabled={running}
            onClick={() => void onResend({ text: meta.prompt, params: meta.params, ...(meta.startFrame ? { startFrame: meta.startFrame } : {}), ...(meta.endFrame ? { endFrame: meta.endFrame } : {}) }).catch(() => {})}
          >
            <ArrowClockwiseIcon size={12} aria-hidden />
            Buat lagi
          </button>
        )}
        <button type="button" className="inline-flex items-center gap-1 text-fg-2 underline" onClick={() => onShowRequest(message.id)}>
          <CodeIcon size={12} aria-hidden />
          Lihat request
        </button>
      </footer>
    </article>
  );
}

export function VideoEmptyIcon() {
  return <FilmSlateIcon size={30} weight="duotone" aria-hidden />;
}

function ActionButton({ icon, label, onClick, disabled, title }: { icon: ReactNode; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" onClick={onClick} disabled={disabled} title={title}>
      {icon}
      {label}
    </button>
  );
}
