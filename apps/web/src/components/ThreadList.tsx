import type { Mode, ThreadListResponse, ThreadSummary } from "@ezclaw/core";
import { ArchiveIcon, ArrowCounterClockwiseIcon, CaretRightIcon, DotsThreeIcon, FolderSimpleIcon, PencilSimpleIcon, PlusIcon, PushPinIcon, PushPinSlashIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useId, useMemo, useState, type FormEvent } from "react";
import { api } from "../api";
import { keys, useThreadList } from "../lib/queries";
import { MODE_INFO } from "../modes";
import { Dialog } from "./Dialog";
import { Menu, type MenuItem } from "./Menu";

const BASE: Record<Mode, string> = { chat: "/chat", agent: "/agent", image: "/image", edit: "/edit" };
const COLLAPSED_KEY = "ezclaw.sidebar.collapsedGroups";

function readCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function ThreadList({ mode }: { mode: Mode }) {
  const info = MODE_INFO[mode];
  const base = BASE[mode];
  const newLabel = mode === "agent" ? "Tugas baru" : mode === "image" ? "Gambar baru" : mode === "edit" ? "Edit baru" : "Thread baru";
  const query = useThreadList(mode);
  const active = (useSearch({ strict: false }) as { t?: string }).t;
  const [showArchived, setShowArchived] = useState(false);
  const archived = useQuery({
    queryKey: [...keys.threads(mode), "archived"],
    queryFn: () => api<ThreadListResponse>(`/threads?mode=${mode}&archived=1`),
  });
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [moving, setMoving] = useState<ThreadSummary | null>(null);
  const [deleting, setDeleting] = useState<ThreadSummary | null>(null);

  const threads = query.data?.threads ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, ThreadSummary[]>();
    for (const t of threads) if (t.group) map.set(t.group, [...(map.get(t.group) ?? []), t]);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [threads]);
  const loose = threads.filter((t) => !t.group);
  const groupNames = groups.map(([g]) => g);

  const toggleGroup = (g: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Remembering folded groups is a convenience only.
      }
      return next;
    });

  const item = (t: ThreadSummary) => (
    <ThreadItem key={t.id} thread={t} current={t.id === active} base={base} mode={mode} onMove={() => setMoving(t)} onDelete={() => setDeleting(t)} />
  );

  return (
    <section aria-labelledby="thread-list-title" className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex items-center justify-between px-2">
        <h2 id="thread-list-title" className="text-meta font-semibold text-fg-3">
          {mode === "agent" ? "Tugas Agent" : `Thread ${info.label}`}
        </h2>
      </div>
      <Link to={base} className="btn btn-secondary justify-start no-underline" aria-label={newLabel}>
        <PlusIcon size={16} aria-hidden />
        {newLabel}
      </Link>

      {query.isPending && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-dense text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat thread
        </p>
      )}
      {query.isError && (
        <div className="grid gap-2 rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          <p>{query.error.message}</p>
          <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void query.refetch()}>
            Coba lagi
          </button>
        </div>
      )}
      {query.isSuccess && threads.length === 0 && !showArchived && (
        <p className="px-2 py-1.5 text-dense text-fg-3">{mode === "agent" ? "Belum ada tugas. Pilih folder dan jelaskan tugas pertama." : mode === "image" ? "Belum ada gambar. Tulis prompt pertama untuk membuatnya." : mode === "edit" ? "Belum ada edit. Pilih gambar dan tulis instruksi pertama." : "Belum ada thread. Kirim pesan pertama untuk membuatnya."}</p>
      )}

      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] content-start gap-1 overflow-x-hidden overflow-y-auto">
        {groups.map(([g, list]) => {
          const folded = collapsed.has(g);
          return (
            <section key={g} aria-label={`Grup ${g}`} className="grid grid-cols-[minmax(0,1fr)] gap-px">
              <button type="button" className="flex min-h-8 min-w-0 items-center gap-1.5 rounded-sm px-2 text-left text-dense text-fg-2 hover:bg-sunken" aria-expanded={!folded} onClick={() => toggleGroup(g)}>
                <CaretRightIcon size={12} aria-hidden className={`shrink-0 transition-transform duration-150 ${folded ? "" : "rotate-90"}`} />
                <FolderSimpleIcon size={14} aria-hidden className="shrink-0" />
                <span className="min-w-0 flex-1 truncate font-semibold">{g}</span>
                <span className="text-meta text-fg-3">{list.length}</span>
              </button>
              {!folded && <ul className="grid grid-cols-[minmax(0,1fr)] gap-px pl-3">{list.map(item)}</ul>}
            </section>
          );
        })}
        {loose.length > 0 && <ul className="grid grid-cols-[minmax(0,1fr)] gap-px">{loose.map(item)}</ul>}

        {(archived.data?.threads.length ?? 0) > 0 && (
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)] gap-px border-t border-line pt-2">
            <button type="button" className="flex min-h-8 items-center gap-1.5 rounded-sm px-2 text-left text-dense text-fg-3 hover:bg-sunken" aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)}>
              <CaretRightIcon size={12} aria-hidden className={`transition-transform duration-150 ${showArchived ? "rotate-90" : ""}`} />
              <ArchiveIcon size={14} aria-hidden />
              <span className="flex-1">Arsip</span>
              <span className="text-meta">{archived.data!.threads.length}</span>
            </button>
            {showArchived && <ul className="grid grid-cols-[minmax(0,1fr)] gap-px pl-3">{archived.data!.threads.map(item)}</ul>}
          </div>
        )}
      </div>

      {moving && <MoveDialog thread={moving} mode={mode} groups={groupNames} onClose={() => setMoving(null)} />}
      {deleting && <DeleteDialog thread={deleting} mode={mode} current={deleting.id === active} base={base} onClose={() => setDeleting(null)} />}
    </section>
  );
}

function useRefresh(mode: Mode, id: string) {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: keys.threads(mode) }), qc.invalidateQueries({ queryKey: keys.thread(id) })]);
}

/** One thread: opens on click, renames on double click, and has a menu for everything else. */
function ThreadItem({ thread: t, current, base, mode, onMove, onDelete }: { thread: ThreadSummary; current: boolean; base: string; mode: Mode; onMove: () => void; onDelete: () => void }) {
  const refresh = useRefresh(mode, t.id);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(t.title);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: object) {
    setError(null);
    try {
      await api(`/threads/${t.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan.");
    }
  }

  async function saveName() {
    const next = value.trim();
    setEditing(false);
    if (next && next !== t.title) await patch({ title: next.slice(0, 120) });
  }

  if (editing) {
    return (
      <li className="grid gap-1 px-1 py-0.5">
        <label className="sr-only" htmlFor={`rename-${t.id}`}>
          Nama baru
        </label>
        <input
          id={`rename-${t.id}`}
          autoFocus
          className="input min-h-8 py-0 text-dense"
          value={value}
          maxLength={120}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void saveName();
            } else if (e.key === "Escape") {
              setValue(t.title);
              setEditing(false);
            }
          }}
        />
      </li>
    );
  }

  const items: MenuItem[] = t.archived
    ? [
        { label: "Pulihkan", icon: <ArrowCounterClockwiseIcon size={16} aria-hidden />, onSelect: () => void patch({ archived: false }) },
        { label: "Hapus", icon: <TrashIcon size={16} aria-hidden />, danger: true, onSelect: onDelete },
      ]
    : [
        {
          label: "Ganti nama",
          icon: <PencilSimpleIcon size={16} aria-hidden />,
          onSelect: () => {
            setValue(t.title);
            setEditing(true);
          },
        },
        { label: t.pinned ? "Lepas sematan" : "Sematkan", icon: t.pinned ? <PushPinSlashIcon size={16} aria-hidden /> : <PushPinIcon size={16} aria-hidden />, onSelect: () => void patch({ pinned: !t.pinned }) },
        { label: t.group ? "Pindahkan ke grup lain" : "Masukkan ke grup", icon: <FolderSimpleIcon size={16} aria-hidden />, onSelect: onMove },
        ...(t.group ? [{ label: "Keluarkan dari grup", icon: <FolderSimpleIcon size={16} aria-hidden />, onSelect: () => void patch({ group: null }) }] : []),
        { label: "Arsipkan", icon: <ArchiveIcon size={16} aria-hidden />, onSelect: () => void patch({ archived: true, pinned: false }) },
        { label: "Hapus", icon: <TrashIcon size={16} aria-hidden />, danger: true, onSelect: onDelete },
      ];

  return (
    <li className="group relative grid">
      <Link
        to={base}
        search={{ t: t.id }}
        aria-current={current ? "page" : undefined}
        title={t.title}
        onDoubleClick={(e) => {
          if (t.archived) return;
          e.preventDefault();
          setValue(t.title);
          setEditing(true);
        }}
        className={[
          "flex min-h-8 min-w-0 items-center gap-2 rounded-sm py-0 pr-8 pl-2 text-dense no-underline transition-colors duration-150",
          current ? "bg-sunken text-fg" : t.archived ? "text-fg-3 hover:bg-sunken" : "text-fg-2 hover:bg-sunken hover:text-fg",
        ].join(" ")}
      >
        {t.pinned && <PushPinIcon size={12} weight="fill" aria-label="Disematkan" className="shrink-0 text-brand-text" />}
        <span className="min-w-0 truncate">{t.title}</span>
      </Link>
      <Menu
        label={`Tindakan untuk ${t.title}`}
        items={items}
        trigger={<DotsThreeIcon size={16} weight="bold" aria-hidden />}
        className="btn btn-ghost absolute top-0 right-0 min-h-8 px-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
      />
      {error && (
        <span className="px-2 text-meta text-danger-text" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

/** Puts a thread in a group. Typing a new name is how a group comes into being. */
function MoveDialog({ thread, mode, groups, onClose }: { thread: ThreadSummary; mode: Mode; groups: string[]; onClose: () => void }) {
  const id = useId();
  const refresh = useRefresh(mode, thread.id);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const others = groups.filter((g) => g !== thread.group);

  async function move(group: string) {
    setError(null);
    try {
      await api(`/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ group }) });
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memindahkan.");
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const g = name.trim();
    if (g) void move(g.slice(0, 60));
  }

  return (
    <Dialog open onClose={onClose} title="Masukkan ke grup" width="max-w-sm">
      <div className="grid gap-4">
        <p className="truncate text-dense text-fg-2" title={thread.title}>
          {thread.title}
        </p>
        {others.length > 0 && (
          <ul className="grid gap-1" aria-label="Grup yang ada">
            {others.map((g) => (
              <li key={g}>
                <button type="button" className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-sm border border-line px-3 text-left text-dense hover:bg-sunken" onClick={() => void move(g)}>
                  <FolderSimpleIcon size={16} aria-hidden className="shrink-0" />
                  <span className="min-w-0 truncate">{g}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="grid gap-1" onSubmit={submit}>
          <label htmlFor={`${id}-name`} className="text-dense font-semibold">
            {others.length ? "Atau buat grup baru" : "Nama grup baru"}
          </label>
          <div className="flex gap-2">
            <input id={`${id}-name`} autoFocus={others.length === 0} className="input min-w-0 flex-1" value={name} maxLength={60} placeholder="misalnya: Light novel" onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
              Buat
            </button>
          </div>
        </form>
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function DeleteDialog({ thread, mode, current, base, onClose }: { thread: ThreadSummary; mode: Mode; current: boolean; base: string; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/threads/${thread.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: keys.threads(mode) });
      qc.removeQueries({ queryKey: keys.thread(thread.id) });
      if (current) void navigate({ to: base });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menghapus.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Hapus thread ini?"
      width="max-w-md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void remove()}>
            Hapus permanen
          </button>
        </>
      }
    >
      <div className="grid gap-2 text-body text-fg-2">
        <p className="break-words font-semibold text-fg">{thread.title}</p>
        <p>Semua pesan di thread ini dihapus dan tidak bisa dikembalikan. Kalau hanya ingin menyingkirkannya dari daftar, pilih Arsipkan.</p>
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
