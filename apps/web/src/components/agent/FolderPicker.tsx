import type { DirListResponse } from "@ezclaw/core";
import { ArrowUpIcon, FolderPlusIcon, FolderSimpleIcon, HardDrivesIcon, HouseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../Dialog";

/**
 * Browses folders on this computer through the local server, since a browser page cannot get the full
 * path of a folder it picks. Only folder names are listed; file contents are never read here.
 */
export function FolderPicker({ open, onClose, initial, recent, onPick, title = "Pilih folder workspace" }: { open: boolean; onClose: () => void; initial: string | null; recent: string[]; onPick: (path: string) => void; title?: string }) {
  const id = useId();
  const [path, setPath] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPath(initial || null);
      setCreating(false);
      setCreateError(null);
    }
  }, [open, initial]);

  const list = useQuery({
    queryKey: ["fs-dirs", path ?? ""],
    queryFn: () => api<DirListResponse>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
    enabled: open,
    retry: false,
  });
  useEffect(() => {
    if (list.data) setTyped(list.data.path ?? "");
  }, [list.data]);

  const go = (p: string | null) => {
    setCreating(false);
    setPath(p);
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!list.data?.path) return;
    setCreateError(null);
    try {
      const res = await api<{ path: string }>("/fs/mkdir", { method: "POST", body: JSON.stringify({ parent: list.data.path, name: newName }) });
      setNewName("");
      setCreating(false);
      go(res.path);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Folder tidak bisa dibuat.");
    }
  }

  const entries = (list.data?.entries ?? []).filter((e) => showHidden || !e.hidden);
  const hiddenCount = (list.data?.entries ?? []).filter((e) => e.hidden).length;
  const current = list.data?.path ?? null;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto min-w-0 truncate text-dense text-fg-2" title={current ?? undefined}>
            {current ? <code>{current}</code> : "Pilih drive atau folder"}
          </span>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="button" className="btn btn-primary" disabled={!current} onClick={() => current && onPick(current)}>
            Pakai folder ini
          </button>
        </>
      }
    >
      <div className="grid gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) go(typed.trim());
          }}
        >
          <label htmlFor={`${id}-path`} className="sr-only">
            Path folder
          </label>
          <input id={`${id}-path`} className="input flex-1 font-code" value={typed} placeholder="Ketik path lalu Enter, mis. F:\proyek" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
          <button type="submit" className="btn btn-secondary">
            Buka
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-1">
          <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" disabled={!list.data?.parent && !current} onClick={() => go(list.data?.parent ?? null)}>
            <ArrowUpIcon size={14} aria-hidden />
            Naik
          </button>
          {list.data?.home && (
            <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" onClick={() => go(list.data!.home)}>
              <HouseIcon size={14} aria-hidden />
              Home
            </button>
          )}
          {(list.data?.roots ?? []).map((r) => (
            <button key={r} type="button" className="btn btn-ghost min-h-8 px-2 text-dense" aria-pressed={current?.toUpperCase().startsWith(r.toUpperCase()) ?? false} onClick={() => go(r)}>
              <HardDrivesIcon size={14} aria-hidden />
              {r.replace(/\\$/, "")}
            </button>
          ))}
          <span className="flex-1" />
          {current && (
            <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" onClick={() => setCreating((v) => !v)}>
              <FolderPlusIcon size={14} aria-hidden />
              Folder baru
            </button>
          )}
        </div>

        {creating && current && (
          <form onSubmit={create} className="grid gap-2 rounded-sm bg-sunken p-3">
            <label htmlFor={`${id}-new`} className="text-dense font-semibold">
              Nama folder baru di <code>{current}</code>
            </label>
            <div className="flex gap-2">
              <input id={`${id}-new`} className="input flex-1" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
              <button type="submit" className="btn btn-secondary" disabled={!newName.trim()}>
                Buat dan buka
              </button>
            </div>
            {createError && (
              <p className="text-dense text-danger-text" role="alert">
                {createError}
              </p>
            )}
          </form>
        )}

        {list.isPending && (
          <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Membaca folder
          </p>
        )}
        {list.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {list.error.message}
          </p>
        )}

        {list.data && (
          <ul className="grid max-h-80 gap-px overflow-y-auto rounded-sm border border-line bg-surface p-1" aria-label={current ? `Folder di ${current}` : "Drive"}>
            {entries.length === 0 && <li className="px-2 py-3 text-dense text-fg-3">{current ? "Tidak ada subfolder di sini. Kamu tetap bisa memakai folder ini." : "Tidak ada drive yang terbaca."}</li>}
            {entries.map((e) => (
              <li key={e.path}>
                <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-dense hover:bg-sunken" onClick={() => go(e.path)} onDoubleClick={() => onPick(e.path)}>
                  {current ? <FolderSimpleIcon size={16} aria-hidden className={e.hidden ? "text-fg-3" : "text-fg-2"} /> : <HardDrivesIcon size={16} aria-hidden />}
                  <span className={`truncate ${e.hidden ? "text-fg-3" : ""}`}>{e.name}</span>
                </button>
              </li>
            ))}
            {list.data.truncated && <li className="px-2 py-2 text-meta text-fg-3">Hanya 500 folder pertama yang ditampilkan. Ketik path untuk langsung ke folder lain.</li>}
          </ul>
        )}

        {hiddenCount > 0 && (
          <label className="flex items-center gap-2 text-dense text-fg-2">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Tampilkan {hiddenCount} folder tersembunyi
          </label>
        )}

        {recent.length > 0 && (
          <div className="grid gap-1">
            <span className="text-dense font-semibold text-fg-2">Baru dipakai</span>
            <ul className="grid gap-px">
              {recent.map((w) => (
                <li key={w}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-dense hover:bg-sunken" onClick={() => go(w)}>
                    <FolderSimpleIcon size={14} aria-hidden />
                    <code className="truncate">{w}</code>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-meta text-fg-3">Klik untuk masuk ke folder, klik dua kali untuk langsung memakainya.</p>
      </div>
    </Dialog>
  );
}
