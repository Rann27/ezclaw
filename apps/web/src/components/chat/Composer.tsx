import type { ModelDto } from "@ezclaw/core";
import { ArrowUpIcon, PaperclipIcon, StopIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../api";
import { Dialog } from "../Dialog";
import { ModelChip } from "../ModelPicker";
import { filterSlash, SlashList, slashQuery, type SlashItem } from "./SlashMenu";
import { AttachmentTray, type PendingAttachment } from "./Attachments";

interface ComposerProps {
  /** Agent: as wide as its timeline instead of the reading width. */
  wide?: boolean;
  model: ModelDto | null;
  onPickModel: () => void;
  running: boolean;
  /** True once the chosen model's endpoint is known to lack its key. */
  keyMissing: boolean;
  onSend: (text: string, attachments: string[]) => Promise<void>;
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
  /** Skills and MCP prompts offered when the message starts with "/". */
  slash?: SlashItem[];
  /** Lets the owner attach images and documents (Chat). */
  attachments?: boolean;
  /** The run reads new messages while it works (Agent, Chat with tools): sending stays open. */
  midRun?: boolean;
}

export function Composer({ model, onPickModel, running, keyMissing, onSend, onStop, error, focusSignal, placeholder = "Tulis pesan", extra, blockedBecause, trailing, wide = false, slash = [], attachments: canAttach = false, midRun = false }: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = files.some((f) => !f.assetId && !f.error);

  function addFiles(list: FileList | File[]) {
    for (const file of Array.from(list).slice(0, 20)) {
      const key = `${Date.now()}-${Math.random()}`;
      setFiles((fs) => [...fs, { key, assetId: null, name: file.name || "tempelan", kind: null, error: null }]);
      api<{ id: string; attachmentKind: PendingAttachment["kind"] }>("/attachments", { method: "POST", body: file, headers: { "x-file-name": encodeURIComponent(file.name || "tempelan") } })
        .then((r) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, assetId: r.id, kind: r.attachmentKind } : f))))
        .catch((e: Error) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, error: e.message } : f))));
    }
  }
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const listId = useId();
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [promptItem, setPromptItem] = useState<Extract<SlashItem, { kind: "prompt" }> | null>(null);
  const query = slashQuery(text);
  const matches = query !== null && query !== dismissed ? filterSlash(slash, query) : [];
  const menuOpen = matches.length > 0;

  useEffect(() => setActive(0), [query]);

  async function insertPrompt(item: Extract<SlashItem, { kind: "prompt" }>, args: Record<string, string>) {
    const res = await api<{ text: string }>(`/mcp/${item.serverId}/prompts/${encodeURIComponent(item.prompt.name)}`, { method: "POST", body: JSON.stringify({ arguments: args }) });
    setText(res.text);
    area.current?.focus();
  }

  function pick(item: SlashItem) {
    if (item.kind === "skill") {
      setText(`/${item.name} `);
      area.current?.focus();
    } else if (item.prompt.arguments.length) setPromptItem(item);
    else void insertPrompt(item, {}).catch(() => setText(""));
  }

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
  const canSend = !blocker && text.trim().length > 0 && (!running || midRun) && !sending && !uploading;
  const queueing = running && midRun;

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (running && !midRun) return onStop();
    if (!canSend) return;
    const value = text;
    setSending(true);
    try {
      await onSend(value, files.filter((f) => f.assetId && !f.error).map((f) => f.assetId!));
      setText("");
      setFiles([]);
    } catch {
      // The parent shows the error and the text stays so nothing typed is lost.
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        e.preventDefault();
        pick(matches[active]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(query);
        return;
      }
    }
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
      <div
        className={`grid gap-2 rounded-lg border bg-raised p-3 focus-within:border-line-strong ${dragging ? "border-brand-strong" : "border-line"}`}
        onDragOver={
          canAttach
            ? (e) => {
                if (e.dataTransfer.types.includes("Files")) {
                  e.preventDefault();
                  setDragging(true);
                }
              }
            : undefined
        }
        onDragLeave={canAttach ? () => setDragging(false) : undefined}
        onDrop={
          canAttach
            ? (e) => {
                if (!e.dataTransfer.files.length) return;
                e.preventDefault();
                setDragging(false);
                addFiles(e.dataTransfer.files);
              }
            : undefined
        }
      >
        {menuOpen && <SlashList id={listId} items={matches} active={active} onPick={pick} />}
        <AttachmentTray items={files} onRemove={(key) => setFiles((fs) => fs.filter((f) => f.key !== key))} />
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
          onPaste={
            canAttach
              ? (e) => {
                  if (e.clipboardData.files.length) {
                    e.preventDefault();
                    addFiles(e.clipboardData.files);
                  }
                }
              : undefined
          }
          placeholder={placeholder}
          aria-describedby={hintId}
          role={slash.length ? "combobox" : undefined}
          aria-expanded={slash.length ? menuOpen : undefined}
          aria-controls={menuOpen ? listId : undefined}
          aria-autocomplete={slash.length ? "list" : undefined}
          aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
          className="w-full resize-none border-0 bg-transparent p-1 text-body leading-[1.62] text-fg placeholder:text-fg-3 focus-visible:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <ModelChip model={model} onClick={onPickModel} disabled={running} />
          {canAttach && (
            <>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="sr-only"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,.docx,.txt,.md,.csv,.json,.xml,.html,.yaml,.yml,.srt,.js,.ts,.tsx,.py,.java,.go,.rs,.c,.cpp,.cs,.php,.sql,.css"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <button type="button" className="btn btn-ghost btn-icon" aria-label="Lampirkan file" title="Lampirkan gambar, PDF, DOCX, atau file teks" onClick={() => fileInput.current?.click()}>
                <PaperclipIcon size={18} aria-hidden />
              </button>
            </>
          )}
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
              <>{queueing ? "Pesan dibaca agent setelah langkah ini selesai" : "Ctrl+Enter untuk kirim"}{slash.length ? " · / untuk skill" : ""}</>
            )}
          </span>
          {trailing}
          {queueing ? (
            <>
              <button type="button" className="btn btn-secondary ml-auto" onClick={onStop}>
                <StopIcon size={18} weight="fill" aria-hidden />
                Stop
              </button>
              <button type="submit" className="btn btn-primary" disabled={!canSend} title="Dibaca agent setelah langkah yang sedang berjalan selesai">
                <ArrowUpIcon size={18} aria-hidden />
                Kirim
              </button>
            </>
          ) : (
            <button
              type={running ? "button" : "submit"}
              className={`btn ml-auto ${running ? "btn-secondary" : "btn-primary"}`}
              disabled={!running && !canSend}
              onClick={running ? onStop : undefined}
            >
              {running ? <StopIcon size={18} weight="fill" aria-hidden /> : <ArrowUpIcon size={18} aria-hidden />}
              {running ? "Stop" : "Kirim"}
            </button>
          )}
        </div>
      </div>
      {promptItem && <PromptArgsDialog item={promptItem} onClose={() => setPromptItem(null)} onSubmit={(args) => insertPrompt(promptItem, args).then(() => setPromptItem(null))} />}
    </form>
  );
}

function PromptArgsDialog({ item, onClose, onSubmit }: { item: Extract<SlashItem, { kind: "prompt" }>; onClose: () => void; onSubmit: (args: Record<string, string>) => Promise<void> }) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const missing = item.prompt.arguments.some((a) => a.required && !values[a.name]?.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={`/${item.name}`}
      width="max-w-md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || missing}
            onClick={() => {
              setBusy(true);
              onSubmit(values).catch((e: Error) => {
                setError(e.message);
                setBusy(false);
              });
            }}
          >
            Masukkan ke pesan
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        {item.description && <p className="text-dense text-fg-2">{item.description}</p>}
        {item.prompt.arguments.map((a) => (
          <div key={a.name} className="grid gap-1">
            <label htmlFor={`${id}-${a.name}`} className="text-dense font-semibold">
              {a.name}
              {a.required ? "" : " (opsional)"}
            </label>
            <input id={`${id}-${a.name}`} className="input" value={values[a.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))} />
            {a.description && <p className="text-meta text-fg-3">{a.description}</p>}
          </div>
        ))}
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
