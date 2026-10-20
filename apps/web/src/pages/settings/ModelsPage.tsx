import type { ModelDto, ModelPatch } from "@ezclaw/core";
import { StarIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { ProfileDialog } from "../../components/ProfileDialog";
import { canAgent, canChat, canEdit, canGenerate, modelLabel, useInvalidateRegistry, useModels } from "../../lib/queries";

type UseFilter = "" | "chat" | "agent" | "image" | "edit";
const USE_FILTERS: { id: Exclude<UseFilter, "">; label: string; test: (m: ModelDto) => boolean }[] = [
  { id: "chat", label: "Chat", test: canChat },
  { id: "agent", label: "Agent (punya tools)", test: canAgent },
  { id: "image", label: "Image", test: (m) => m.kind === "image" && canGenerate(m) },
  { id: "edit", label: "Edit", test: (m) => m.kind === "image" && canEdit(m) },
];

const PAGE = 80;
const SOURCE_LABEL: Record<ModelDto["source"], string> = {
  discovered: "dari provider",
  manual: "manual",
  suggested: "disarankan",
};

export function ModelsPage() {
  const models = useModels();
  const [query, setQuery] = useState("");
  const [endpointId, setEndpointId] = useState("");
  const [onlyFavorite, setOnlyFavorite] = useState(false);
  const [use, setUse] = useState<UseFilter>("");
  const [limit, setLimit] = useState(PAGE);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [aliasFor, setAliasFor] = useState<ModelDto | null>(null);
  const invalidate = useInvalidateRegistry();

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ModelPatch }) => api(`/models/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => api(`/models/${id}`, { method: "DELETE" }), onSuccess: invalidate });

  const all = models.data?.models ?? [];
  const endpointNames = useMemo(() => [...new Map(all.map((m) => [m.endpointId, m.endpointName])).entries()], [all]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((m) => !endpointId || m.endpointId === endpointId)
      .filter((m) => !onlyFavorite || m.favorite)
      .filter((m) => !use || USE_FILTERS.find((f) => f.id === use)!.test(m))
      .filter((m) => !q || `${m.name} ${m.alias ?? ""} ${m.modelId}`.toLowerCase().includes(q))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.endpointName.localeCompare(b.endpointName) || a.modelId.localeCompare(b.modelId));
  }, [all, endpointId, onlyFavorite, query, use]);

  return (
    <div className="grid gap-6">
      <p className="max-w-prose text-body text-fg-2">
        Semua model dari endpoint yang tersambung. Tandai favorit agar muncul paling atas di pemilih model, beri alias, atau lihat dan ubah profil kemampuannya.
      </p>

      {models.isPending && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat model
        </p>
      )}
      {models.isError && (
        <div className="grid gap-2 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
          <p>{models.error.message}</p>
          <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void models.refetch()}>
            Coba lagi
          </button>
        </div>
      )}

      {models.isSuccess && all.length === 0 && (
        <div className="grid gap-3 rounded-md border border-line bg-surface p-6">
          <h2 className="text-hero font-semibold">Belum ada model</h2>
          <p className="max-w-prose text-body text-fg-2">Model muncul setelah kamu menambahkan endpoint dan menekan Tes koneksi.</p>
          <Link to="/settings/endpoints" className="btn btn-primary justify-self-start no-underline">
            Buka Endpoint
          </Link>
        </div>
      )}

      {all.length > 0 && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-48 flex-1 gap-1">
              <label htmlFor="m-search" className="text-dense font-semibold">
                Cari
              </label>
              <input id="m-search" className="input" placeholder="Nama atau ID model" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }} />
            </div>
            <div className="grid gap-1">
              <label htmlFor="m-endpoint" className="text-dense font-semibold">
                Endpoint
              </label>
              <select id="m-endpoint" className="select" value={endpointId} onChange={(e) => { setEndpointId(e.target.value); setLimit(PAGE); }}>
                <option value="">Semua</option>
                {endpointNames.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor="m-use" className="text-dense font-semibold">
                Dipakai untuk
              </label>
              <select id="m-use" className="select" value={use} onChange={(e) => { setUse(e.target.value as UseFilter); setLimit(PAGE); }}>
                <option value="">Semua mode</option>
                {USE_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label} ({all.filter(f.test).length})
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="chip-toggle" aria-pressed={onlyFavorite} onClick={() => setOnlyFavorite((v) => !v)}>
              Hanya favorit
            </button>
          </div>

          <p className="text-dense text-fg-3" role="status">
            {filtered.length} dari {all.length} model
          </p>

          {filtered.length === 0 && <p className="text-ui text-fg-2">Tidak ada model yang cocok dengan pencarian ini.</p>}

          <ul className="grid divide-y divide-line rounded-md border border-line bg-surface">
            {filtered.slice(0, limit).map((m) => (
              <li key={m.id} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="grid min-w-0 gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-ui font-semibold">{modelLabel(m)}</span>
                    <span className="ep-tag">{m.endpointName}</span>
                    <span className="text-meta text-fg-3">{SOURCE_LABEL[m.source]}</span>
                    {m.kind === "image" && <span className="ep-tag">{m.summary.editOnly ? "gambar, khusus edit" : "gambar"}</span>}
                    {m.hasOverride && <span className="ep-tag">override</span>}
                    {m.omitCount > 0 && <span className="ep-tag">{m.omitCount} field ditolak</span>}
                  </div>
                  <code className="break-all text-dense text-fg-2">{m.modelId}</code>
                  <p className="text-meta text-fg-3">
                    {[m.summary.tools && "tools", m.summary.reasoning && "reasoning", m.summary.inputModalities.includes("image") && "terima gambar", m.summary.contextLength && `${Math.round(m.summary.contextLength / 1000)}k konteks`]
                      .filter(Boolean)
                      .join(" · ") || "Kemampuan belum diketahui"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-pressed={m.favorite}
                    aria-label={m.favorite ? `Hapus ${modelLabel(m)} dari favorit` : `Tandai ${modelLabel(m)} sebagai favorit`}
                    onClick={() => patch.mutate({ id: m.id, body: { favorite: !m.favorite } })}
                  >
                    <StarIcon size={18} weight={m.favorite ? "fill" : "regular"} aria-hidden className={m.favorite ? "text-brand-strong" : undefined} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    aria-label={m.kind === "image" ? `Jadikan ${modelLabel(m)} model teks` : `Jadikan ${modelLabel(m)} model gambar`}
                    onClick={() => patch.mutate({ id: m.id, body: { kind: m.kind === "image" ? "text" : "image" } })}
                  >
                    {m.kind === "image" ? "Jadikan teks" : "Jadikan gambar"}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setAliasFor(m)} aria-haspopup="dialog">
                    Alias
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setProfileFor(m.id)} aria-haspopup="dialog">
                    Profil
                  </button>
                  {m.source !== "discovered" && (
                    <button type="button" className="btn btn-ghost" onClick={() => remove.mutate(m.id)} disabled={remove.isPending}>
                      Hapus
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {filtered.length > limit && (
            <button type="button" className="btn btn-secondary justify-self-start" onClick={() => setLimit((l) => l + PAGE)}>
              Tampilkan {Math.min(PAGE, filtered.length - limit)} lagi
            </button>
          )}
        </>
      )}

      {(patch.isError || remove.isError) && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {(patch.error ?? remove.error)?.message}
        </p>
      )}

      <AliasDialog model={aliasFor} onClose={() => setAliasFor(null)} onSave={(alias) => aliasFor && patch.mutate({ id: aliasFor.id, body: { alias } }, { onSuccess: () => setAliasFor(null) })} saving={patch.isPending} />
      <ProfileDialog modelId={profileFor} onClose={() => setProfileFor(null)} />
    </div>
  );
}

function AliasDialog({ model, onClose, onSave, saving }: { model: ModelDto | null; onClose: () => void; onSave: (alias: string | null) => void; saving: boolean }) {
  const formId = useId();
  const [text, setText] = useState("");
  const [lastId, setLastId] = useState<string | null>(null);
  if (model && model.id !== lastId) {
    setLastId(model.id);
    setText(model.alias ?? "");
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(text.trim() === "" ? null : text.trim());
  }

  return (
    <Dialog
      open={model !== null}
      onClose={onClose}
      title="Alias model"
      width="max-w-md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={saving}>
            Simpan
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-2">
        <label htmlFor={`${formId}-alias`} className="text-dense font-semibold">
          Nama pendek untuk <code>{model?.modelId}</code>
        </label>
        <input id={`${formId}-alias`} data-autofocus className="input" value={text} maxLength={60} placeholder="contoh: Flash" onChange={(e) => setText(e.target.value)} />
        <p className="text-meta text-fg-3">Dipakai di pemilih model dan di composer. Kosongkan untuk memakai nama asli.</p>
      </form>
    </Dialog>
  );
}
