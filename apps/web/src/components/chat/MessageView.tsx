import type { MessageDto, Usage } from "@ezclaw/core";
import { ArrowClockwiseIcon, CheckIcon, CodeIcon, CopyIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useRef, useState } from "react";
import type { LiveRun } from "./useLiveRun";

// Markdown pulls in the maths and table renderers, so it loads only once an answer is on screen.
const Markdown = lazy(() => import("../Markdown").then((m) => ({ default: m.Markdown })));

function textOf(m: MessageDto): string {
  return m.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function reasoningOf(m: MessageDto): string {
  return m.parts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

function formatUsage(u: Usage | null): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`${u.inputTokens} masuk`);
  if (u.outputTokens !== undefined) parts.push(`${u.outputTokens} keluar`);
  if (u.reasoningTokens) parts.push(`${u.reasoningTokens} reasoning`);
  if (u.cachedTokens) parts.push(`${u.cachedTokens} cache`);
  if (u.costUsd !== undefined) parts.push(`US$${u.costUsd.toFixed(u.costUsd < 0.01 ? 5 : 3)}`);
  return parts.length ? `${parts.join(" · ")} token` : null;
}

export function UserMessage({ message }: { message: MessageDto }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[min(56ch,100%)] whitespace-pre-wrap rounded-md bg-sunken px-4 py-3 text-body break-words">{textOf(message)}</div>
    </div>
  );
}

interface AssistantProps {
  message: MessageDto;
  /** Present while this message is the one being written. */
  live: LiveRun | null;
  onShowRequest: (messageId: string) => void;
  onRetry?: () => void;
  canRetry: boolean;
}

export function AssistantMessage({ message, live, onShowRequest, onRetry, canRetry }: AssistantProps) {
  // A message still marked streaming without a live view is one whose stream is about to attach.
  const streaming = live ? !live.disconnected : message.status === "streaming";
  const text = live ? live.text : textOf(message);
  const reasoning = live ? live.reasoning : reasoningOf(message);
  const notes = live ? live.notes : message.notes;
  const usage = live ? live.usage : message.usage;
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  const failed = !live && message.status === "error";
  const stopped = !live && message.status === "stopped";
  const waiting = streaming && !text && !reasoning;

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const nodeClass = streaming ? "node-run" : failed ? "node-fail" : stopped ? "node-skip" : "node-done";
  const statusLabel = streaming ? "Sedang menjawab" : failed ? "Gagal" : stopped ? "Dihentikan" : "Selesai";
  const usageText = formatUsage(usage);

  return (
    <article className="grid max-w-[var(--read-max)] gap-3" aria-label="Jawaban asisten" aria-busy={streaming}>
      {reasoning && (
        <details open={streaming && !text} className="rounded-sm border border-line">
          <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-dense text-fg-2">
            <span className={`node ${streaming && !text ? "node-run" : "node-done"}`} aria-hidden />
            {streaming && !text ? "Berpikir" : "Reasoning"}
            <span className="text-fg-3">{reasoning.length} karakter</span>
          </summary>
          <div className="max-h-72 overflow-y-auto border-t border-line px-3 py-2 text-dense whitespace-pre-wrap text-fg-2 break-words">{reasoning}</div>
        </details>
      )}

      {waiting && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Menunggu respons {message.modelLabel ?? "model"}
        </p>
      )}

      {text && (
        <Suspense fallback={<p className="whitespace-pre-wrap text-body">{text}</p>}>
          <Markdown text={text} streaming={streaming} />
        </Suspense>
      )}

      {notes.length > 0 && (
        <ul className="grid gap-1.5">
          {notes.map((n) => (
            <li key={n} className="rounded-sm bg-sunken px-3 py-1.5 text-dense text-fg-2">
              {n}
            </li>
          ))}
        </ul>
      )}

      {live?.disconnected && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {live.disconnected}
        </p>
      )}

      {failed && (
        <div className="grid gap-2 rounded-sm bg-danger-soft px-3 py-2 text-ui text-danger-text" role="alert">
          <p>{message.error ?? "Jawaban gagal dibuat."}</p>
          {canRetry && onRetry && (
            <button type="button" className="btn btn-secondary justify-self-start" onClick={onRetry}>
              <ArrowClockwiseIcon size={16} aria-hidden />
              Kirim ulang pesan terakhir
            </button>
          )}
        </div>
      )}

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
        <span className="flex items-center gap-1.5">
          <span className={`node ${nodeClass}`} aria-hidden />
          {statusLabel}
        </span>
        {message.modelLabel && <span className="font-code">{message.modelLabel}</span>}
        {usageText && <span>{usageText}</span>}
        {!live && message.durationMs !== null && <span>{(message.durationMs / 1000).toFixed(1)} dtk</span>}
        {!streaming && (
          <span className="ml-auto flex gap-1">
            {text && (
              <button type="button" className="btn btn-ghost min-h-7 px-2 text-meta" onClick={() => void copy()}>
                {copied ? <CheckIcon size={14} aria-hidden /> : <CopyIcon size={14} aria-hidden />}
                {copied ? "Tersalin" : "Salin"}
              </button>
            )}
            <button type="button" className="btn btn-ghost min-h-7 px-2 text-meta" onClick={() => onShowRequest(message.id)}>
              <CodeIcon size={14} aria-hidden />
              Lihat request
            </button>
          </span>
        )}
      </footer>
    </article>
  );
}
