import type { MemoryDto } from "@ezclaw/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { api } from "../../api";
import { FolderPicker } from "../../components/agent/FolderPicker";
import { keys, useMemories, useRecentWorkspaces } from "../../lib/queries";

export function MemoryPage() {
  const memories = useMemories();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.memories });
  const all = memories.data?.memories ?? [];
  const proposed = all.filter((m) => m.status === "proposed");
  const active = all.filter((m) => m.status === "active");

  return (
    <div className="grid gap-8">
      <div className="grid max-w-prose gap-2 text-body text-fg-2">
        <p>Memori adalah catatan singkat yang ikut dikirim di wrapper setiap thread, supaya model ingat preferensimu dan fakta proyek tanpa kamu ulangi.</p>
        <p>
          <strong>Umum</strong> berlaku untuk semua Chat dan Agent. <strong>Folder</strong> hanya untuk Agent yang bekerja di folder itu. Model hanya bisa <em>mengusulkan</em>; usulan baru dipakai setelah kamu menyimpannya.
        </p>
      </div>

      {memories.isPending && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat memori
        </p>
      )}
      {memories.isError && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {memories.error.message}
        </p>
      )}

      {proposed.length > 0 && (
        <section aria-labelledby="mem-proposed" className="grid gap-3">
          <h2 id="mem-proposed" className="text-title font-semibold">
            Menunggu keputusanmu ({proposed.length})
          </h2>
          <ul className="grid gap-2">
            {proposed.map((m) => (
              <MemoryRow key={m.id} memory={m} onChanged={refresh} />
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="mem-active" className="grid gap-3">
        <h2 id="mem-active" className="text-title font-semibold">
          Tersimpan
        </h2>
        {memories.isSuccess && active.length === 0 && <p className="text-dense text-fg-3">Belum ada memori. Tambahkan di bawah, atau setujui usulan dari Agent.</p>}
        <ul className="grid gap-2">
          {active.map((m) => (
            <MemoryRow key={m.id} memory={m} onChanged={refresh} />
          ))}
        </ul>
      </section>

      <AddMemory onAdded={refresh} />
    </div>
  );
}

function MemoryRow({ memory, onChanged }: { memory: MemoryDto; onChanged: () => void }) {
  const id = useId();
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api(`/memories/${memory.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({ mutationFn: () => api(`/memories/${memory.id}`, { method: "DELETE" }), onSuccess: onChanged, onError: (e: Error) => setError(e.message) });
  const changed = text.trim() !== memory.text;

  return (
    <li className={`grid gap-2 rounded-md border p-3 ${memory.status === "proposed" ? "border-ember bg-ember-soft" : "border-line bg-surface"}`}>
      <label htmlFor={id} className="sr-only">
        Isi memori
      </label>
      <textarea id={id} className="textarea min-h-12 text-ui" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2 text-meta text-fg-3">
        <span className="ep-tag">{memory.scope === "global" ? "Umum" : "Folder"}</span>
        {memory.workspace && <code className="break-all">{memory.workspace}</code>}
        <span>{memory.source === "agent" ? "diusulkan agent" : "ditulis kamu"}</span>
        <span className="flex-1" />
        {memory.status === "proposed" && (
          <button type="button" className="btn btn-primary min-h-8" disabled={save.isPending} onClick={() => save.mutate({ status: "active", ...(changed ? { text: text.trim() } : {}) })}>
            Simpan
          </button>
        )}
        {memory.status === "active" && changed && (
          <button type="button" className="btn btn-secondary min-h-8" disabled={save.isPending} onClick={() => save.mutate({ text: text.trim() })}>
            Simpan perubahan
          </button>
        )}
        {memory.scope === "workspace" && (
          <button type="button" className="btn btn-ghost min-h-8" disabled={save.isPending} onClick={() => save.mutate({ scope: "global" })}>
            Jadikan umum
          </button>
        )}
        <button type="button" className="btn btn-ghost min-h-8" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {memory.status === "proposed" ? "Tolak" : "Hapus"}
        </button>
      </div>
      {error && (
        <p className="text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function AddMemory({ onAdded }: { onAdded: () => void }) {
  const id = useId();
  const recent = useRecentWorkspaces();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"global" | "workspace">("global");
  const [workspace, setWorkspace] = useState("");
  const [picking, setPicking] = useState(false);
  const add = useMutation({
    mutationFn: () => api("/memories", { method: "POST", body: JSON.stringify({ text: text.trim(), scope, ...(scope === "workspace" ? { workspace } : {}) }) }),
    onSuccess: () => {
      setText("");
      onAdded();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    add.mutate();
  };
  return (
    <section aria-labelledby={`${id}-h`} className="grid gap-3 rounded-md border border-line bg-surface p-4">
      <h2 id={`${id}-h`} className="text-title font-semibold">
        Tambah memori
      </h2>
      <form onSubmit={submit} className="grid gap-3">
        <label htmlFor={`${id}-text`} className="sr-only">
          Memori baru
        </label>
        <textarea id={`${id}-text`} className="textarea min-h-16" value={text} maxLength={1000} placeholder="Contoh: Jawab dalam Bahasa Indonesia. Untuk kode, pakai TypeScript." onChange={(e) => setText(e.target.value)} />
        <fieldset className="flex flex-wrap items-center gap-3 border-0 p-0">
          <legend className="sr-only">Berlaku untuk</legend>
          <label className="flex items-center gap-1.5 text-dense">
            <input type="radio" name={`${id}-scope`} checked={scope === "global"} onChange={() => setScope("global")} />
            Umum
          </label>
          <label className="flex items-center gap-1.5 text-dense">
            <input type="radio" name={`${id}-scope`} checked={scope === "workspace"} onChange={() => setScope("workspace")} />
            Satu folder
          </label>
          {scope === "workspace" && (
            <>
              <code className="min-w-0 flex-1 truncate text-dense">{workspace || "belum dipilih"}</code>
              <button type="button" className="btn btn-secondary min-h-8" onClick={() => setPicking(true)}>
                Pilih folder
              </button>
            </>
          )}
        </fieldset>
        <button type="submit" className="btn btn-primary justify-self-start" disabled={!text.trim() || (scope === "workspace" && !workspace) || add.isPending}>
          Simpan memori
        </button>
        {add.isError && (
          <p className="text-dense text-danger-text" role="alert">
            {add.error.message}
          </p>
        )}
      </form>
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        initial={workspace || null}
        recent={recent.data?.workspaces ?? []}
        title="Folder untuk memori ini"
        onPick={(p) => {
          setWorkspace(p);
          setPicking(false);
        }}
      />
    </section>
  );
}
