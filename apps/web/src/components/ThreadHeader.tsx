import type { ThreadDetailDto } from "@ezclaw/core";
import { PencilSimpleIcon, SlidersHorizontalIcon, TrashIcon, XIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api";
import { keys } from "../lib/queries";

/** Title, pin, rename and delete for a thread, with room for mode-specific controls. */
export function ThreadHeader({
  thread,
  renaming,
  setRenaming,
  onDelete,
  showInspectorToggle,
  inspectorOpen,
  onToggleInspector,
  fallbackTitle = "Percakapan baru",
  children,
}: {
  thread: ThreadDetailDto | undefined;
  renaming: boolean;
  setRenaming: (v: boolean) => void;
  onDelete: () => void;
  showInspectorToggle: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  fallbackTitle?: string;
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${thread?.title ?? fallbackTitle} · EZClaw`;
  }, [thread?.title, fallbackTitle]);

  useEffect(() => {
    if (renaming) setTitle(thread?.title ?? "");
  }, [renaming, thread?.title]);

  async function patch(body: object) {
    if (!thread) return;
    setError(null);
    try {
      await api(`/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await Promise.all([qc.invalidateQueries({ queryKey: keys.thread(thread.id) }), qc.invalidateQueries({ queryKey: ["threads"] })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan perubahan.");
    }
  }

  async function commitRename() {
    const next = title.trim();
    setRenaming(false);
    if (next && next !== thread?.title) await patch({ title: next });
  }

  return (
    <header className="flex min-h-12 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void commitRename();
          }}
        >
          <label htmlFor="rename-input" className="sr-only">
            Nama thread
          </label>
          <input
            id="rename-input"
            autoFocus
            className="input max-w-md"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setRenaming(false)}
          />
          <button type="submit" className="btn btn-primary">
            Simpan
          </button>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Batal ganti nama" onClick={() => setRenaming(false)}>
            <XIcon size={18} aria-hidden />
          </button>
        </form>
      ) : (
        <>
          <h1 className="min-w-0 basis-full truncate text-title font-semibold sm:flex-1 sm:basis-0">{thread?.title ?? fallbackTitle}</h1>
          {thread && (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => void patch({ pinned: !thread.pinned })} aria-pressed={thread.pinned}>
                {thread.pinned ? "Lepas sematan" : "Sematkan"}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setRenaming(true)}>
                <PencilSimpleIcon size={16} aria-hidden />
                Ganti nama
              </button>
              <button type="button" className="btn btn-ghost" onClick={onDelete}>
                <TrashIcon size={16} aria-hidden />
                Hapus
              </button>
            </>
          )}
        </>
      )}
      {children}
      {showInspectorToggle && (
        <button type="button" className="btn btn-secondary" aria-expanded={inspectorOpen} onClick={onToggleInspector}>
          <SlidersHorizontalIcon size={16} aria-hidden />
          Pengaturan
        </button>
      )}
      {error && (
        <p className="basis-full rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
