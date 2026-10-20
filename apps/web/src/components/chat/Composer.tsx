import type { ModelDto } from "@ezclaw/core";
import { ArrowUpIcon, StopIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ModelChip } from "../ModelPicker";

interface ComposerProps {
  /** Agent: as wide as its timeline instead of the reading width. */
  wide?: boolean;
  model: ModelDto | null;
  onPickModel: () => void;
  running: boolean;
  /** True once the chosen model's endpoint is known to lack its key. */
  keyMissing: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  error: string | null;
  /** Bumped to focus the field, e.g. after "New thread". */
  focusSignal: number;
  placeholder?: string;
  /** Extra controls shown next to the model chip. */
  extra?: ReactNode;
  /** Another reason sending is blocked (for example, no workspace yet). */
  blockedBecause?: string | null;
  /** Shown at the end of the footer row, before the send button. */
  trailing?: ReactNode;
}

export function Composer({ model, onPickModel, running, keyMissing, onSend, onStop, error, focusSignal, placeholder = "Tulis pesan", extra, blockedBecause, trailing, wide = false }: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  useEffect(() => {
    area.current?.focus();
  }, [focusSignal]);

  // Grow with the content up to roughly eight lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const blocker = !model ? "Pilih model untuk mengirim pesan." : keyMissing ? `Endpoint ${model.endpointName} belum punya key.` : (blockedBecause ?? null);
  const canSend = !blocker && text.trim().length > 0 && !running && !sending;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (running) return onStop();
    if (!canSend) return;
    const value = text;
    setSending(true);
    try {
      await onSend(value);
      setText("");
    } catch {
      // The parent shows the error and the text stays so nothing typed is lost.
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className={`mx-auto w-full ${wide ? "max-w-[72rem]" : "max-w-[calc(var(--read-max)+3rem)]"} px-4 pb-4`} aria-label="Tulis pesan">
      {error && (
        <p className="mb-2 rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
      <div className="grid gap-2 rounded-lg border border-line bg-raised p-3 focus-within:border-line-strong">
        <label htmlFor="composer-input" className="sr-only">
          Pesan
        </label>
        <textarea
          id="composer-input"
          ref={area}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-describedby={hintId}
          className="w-full resize-none border-0 bg-transparent p-1 text-body leading-[1.62] text-fg placeholder:text-fg-3 focus-visible:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <ModelChip model={model} onClick={onPickModel} disabled={running} />
          {extra}
          <span id={hintId} className="text-meta text-fg-3">
            {blocker ? (
              <>
                {blocker}{" "}
                {model && keyMissing && (
                  <Link to="/settings/endpoints" className="text-brand-text underline">
                    Isi key
                  </Link>
                )}
              </>
            ) : (
              "Ctrl+Enter untuk kirim"
            )}
          </span>
          {trailing}
          <button
            type={running ? "button" : "submit"}
            className={`btn ml-auto ${running ? "btn-secondary" : "btn-primary"}`}
            disabled={!running && !canSend}
            onClick={running ? onStop : undefined}
          >
            {running ? <StopIcon size={18} weight="fill" aria-hidden /> : <ArrowUpIcon size={18} aria-hidden />}
            {running ? "Stop" : "Kirim"}
          </button>
        </div>
      </div>
    </form>
  );
}
