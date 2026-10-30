import type { DirListResponse } from "@ezclaw/core";
import { ArrowUpIcon, FolderPlusIcon, FolderSimpleIcon, HardDrivesIcon, HouseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../Dialog";

/** One Windows dialog at a time: a second request while one is open waits for the same answer. */
let inflight: Promise<{ path: string | null }> | null = null;
function askWindows(initial: string | null, title: string) {
  inflight ??= api<{ path: string | null }>("/fs/pick-folder", { method: "POST", body: JSON.stringify({ initial, title }) }).finally(() => {
    inflight = null;
  });
  return inflight;
}

type PickerProps = { open: boolean; onClose: () => void; initial: string | null; recent: string[]; onPick: (path: string) => void; title?: string };

/**
 * Chooses a folder with the Windows dialog. A web page is never told a folder's real path, so the
 * local server opens the dialog and returns the path. If the dialog cannot open (another system,
 * or PowerShell is blocked), EZClaw's own folder browser takes over.
 */
export function FolderPicker(props: PickerProps) {
  const { open, onClose, initial, onPick, title = "Pilih folder workspace" } = props;
  const [phase, setPhase] = useState<"native" | "browser">("native");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("native");
    setNote(null);
    let alive = true;
    askWindows(initial, title)
      .then((r) => {
        if (!alive) return;
        if (r.path) onPick(r.path);
        else onClose();
      })
      .catch((err: Error) => {
        if (!alive) return;
        setNote(err.message);
        setPhase("browser");
      });
    return () => {
      alive = false;
    };
    // Open once per opening; the callbacks change identity on every render of the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  if (phase === "native") {
    return (
      <Dialog open onClose={onClose} title={title} width="max-w-md">
        <div className="grid gap-3">
          <p className="flex items-center gap-2 text-body text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Dialog folder Windows sudah terbuka. Pilih folder di jendela itu.
          </p>
          <p className="text-dense text-fg-3">Kalau jendelanya tidak terlihat, cek di belakang jendela browser atau di taskbar.</p>
          <button type="button" className="btn btn-ghost justify-self-start" onClick={() => setPhase("browser")}>
            Pakai penjelajah EZClaw saja
          </button>
        </div>
      </Dialog>
    );
  }
  return <FolderBrowser {...props} note={note} />;
}

/**
 * EZClaw's own folder browser, listing folders through the local server. Used when the Windows
 * dialog is not available. Only folder names are listed; file contents are never read here.
 */
function FolderBrowser({ open, onClose, initial, recent, onPick, title = "Pilih folder workspace", note = null }: PickerProps & { note?: string | null }) {
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 overflow-x-hidden">
        {note && (
          <p className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2" role="status">
            Dialog folder Windows tidak bisa dibuka ({note}), jadi pakai penjelajah EZClaw.
          </p>
        )}
        <form
          className="flex min-w-0 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) go(typed.trim());
          }}
        >
          <label htmlFor={`${id}-path`} className="sr-only">
            Path folder
          </label>
          <input id={`${id}-path`} className="input min-w-0 flex-1 font-code" value={typed} placeholder="Ketik path lalu Enter, mis. F:\proyek" spellCheck={false} onChange={(e) => setTyped(e.target.value)} />
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
                <button type="button" className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-dense hover:bg-sunken" onClick={() => go(e.path)} onDoubleClick={() => onPick(e.path)}>
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
                  <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-dense hover:bg-sunken" title={w} onClick={() => go(w)}>
                    <FolderSimpleIcon size={14} aria-hidden className="shrink-0" />
                    <code className="min-w-0 truncate">{w}</code>
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
