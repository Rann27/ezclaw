import type { CodexStatusResponse, HarnessPreviewResponse, HarnessProfile, HarnessProfilePatch, HarnessSegment, SegmentPlacement, SegmentWrap } from "@ezclaw/core";

const PLACEMENT_LABEL: Record<SegmentPlacement, string> = {
  system: "System prompt",
  developer: "Pesan developer",
  context: "Konteks sebelum pesanmu",
};
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { keys, useHarness, useSettings, useUpdateSettings } from "../../lib/queries";

export function HarnessPage() {
  const harness = useHarness();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<HarnessProfile | null>(null);
  const [removing, setRemoving] = useState<HarnessProfile | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = () => void qc.invalidateQueries({ queryKey: keys.harness });
  const duplicate = useMutation({
    mutationFn: (id: string) => api<HarnessProfile>(`/harness/${id}/duplicate`, { method: "POST", body: "{}" }),
    onSuccess: (p) => {
      refresh();
      setEditing(p);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/harness/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      setRemoving(null);
    },
  });

  const profiles = harness.data?.profiles ?? [];

  return (
    <div className="grid gap-8">
      <div className="grid max-w-prose gap-2 text-body text-fg-2">
        <p>
          Harness adalah <strong>wrapper prompt</strong> yang membungkus setiap permintaan: siapa modelnya, cara bekerja, cara menjawab, dan batas keamanannya. Untuk Agent, harness juga menentukan tools dan aturan loop.
        </p>
        <p>
          Setiap wrapper terbagi menjadi <strong>segmen</strong> yang bisa dinyalakan, dimatikan, diubah, ditambah, atau diurutkan. Segmen yang berubah setiap kali (tanggal, folder) dikirim paling akhir, supaya bagian awal yang sama dari request ke request bisa di-cache provider dan input-nya dibayar lebih murah.
        </p>
      </div>

      <CodexSection />

      {(["agent", "chat"] as const).map((mode) => (
        <section key={mode} aria-labelledby={`hp-${mode}`} className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`hp-${mode}`} className="text-title font-semibold">
              {mode === "agent" ? "Wrapper Agent" : "Wrapper Chat"}
            </h2>
            {mode === "agent" && (
              <button type="button" className="btn btn-secondary ml-auto" onClick={() => setImporting(true)}>
                Impor dari teks
              </button>
            )}
          </div>
          {harness.isPending && (
            <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
              <span className="node node-run" aria-hidden />
              Memuat profil
            </p>
          )}
          {harness.isError && (
            <div className="grid gap-2 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
              <p>{harness.error.message}</p>
              <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void harness.refetch()}>
                Coba lagi
              </button>
            </div>
          )}
          <ul className="grid gap-3">
            {profiles
              .filter((p) => p.mode === mode)
              .map((p) => (
                <li key={p.id} className="grid gap-2 rounded-md border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-ui font-semibold">{p.name}</h3>
                    {p.builtin && <span className="ep-tag">bawaan</span>}
                    <span className="ep-tag">{p.wrap === "tags" ? "format tag" : "format teks"}</span>
                    <span className="text-meta text-fg-3">{p.fromCodex && p.segments.length === 0 ? "belum terbaca" : `${p.segments.filter((s) => s.enabled).length} dari ${p.segments.length} segmen aktif`}</span>
                  </div>
                  <p className="text-dense text-fg-2">{p.description}</p>
                  {p.origin && <p className="text-meta text-fg-3">Asal: {p.origin}</p>}
                  {mode === "agent" && (
                    <p className="text-meta text-fg-3">
                      Tools: <code>{p.tools.join(", ") || "tidak ada"}</code>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing(p)}>
                      {p.builtin ? "Lihat segmen" : "Ubah"}
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => duplicate.mutate(p.id)} disabled={duplicate.isPending}>
                      Duplikasi
                    </button>
                    {!p.builtin && (
                      <button type="button" className="btn btn-ghost" onClick={() => setRemoving(p)}>
                        Hapus
                      </button>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        </section>
      ))}
      {duplicate.isError && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {duplicate.error.message}
        </p>
      )}

      <ProfileEditor
        profile={editing}
        tools={harness.data?.tools ?? []}
        onClose={() => setEditing(null)}
        onSaved={refresh}
        onDuplicate={(id) => duplicate.mutate(id)}
      />
      <ImportDialog
        open={importing}
        onClose={() => setImporting(false)}
        onImported={(p) => {
          refresh();
          setImporting(false);
          setEditing(p);
        }}
      />

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={`Hapus ${removing?.name ?? "profil"}?`}
        width="max-w-md"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRemoving(null)}>
              Batal
            </button>
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>
              Hapus profil
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">Thread yang memakai profil ini perlu memilih profil lain sebelum dikirimi pesan.</p>
        {remove.isError && (
          <p className="mt-3 rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {remove.error.message}
          </p>
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ Codex folder */

function CodexSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const qc = useQueryClient();
  const id = useId();
  const [dir, setDir] = useState("");
  const [status, setStatus] = useState<CodexStatusResponse | null>(null);

  useEffect(() => {
    if (settings.data) setDir(settings.data.codexDir ?? "");
  }, [settings.data]);

  const check = useMutation({
    mutationFn: () => api<CodexStatusResponse>("/codex/status", { method: "POST", body: JSON.stringify({ dir: dir.trim() }) }),
    onSuccess: (s) => {
      setStatus(s);
      if (s.ok) update.mutate({ codexDir: dir.trim() }, { onSuccess: () => void qc.invalidateQueries({ queryKey: keys.harness }) });
    },
  });

  return (
    <section aria-labelledby="codex-title" className="grid gap-3 rounded-md border border-line bg-surface p-4">
      <h2 id="codex-title" className="text-title font-semibold">
        Folder Codex
      </h2>
      <p className="max-w-prose text-dense text-fg-2">
        Profil <strong>Codex</strong> memakai wrapper asli dari <code>models.json</code> di instalasi Codex-mu, dipecah per judul menjadi segmen. Duplikasi profil itu untuk mengubahnya. EZClaw hanya membuka file <code>models.json</code>; isi folder lainnya (termasuk kredensial) tidak dibaca.
      </p>
      <form
        className="grid gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          check.mutate();
        }}
      >
        <label htmlFor={id} className="text-dense font-semibold">
          Folder
        </label>
        <div className="flex flex-wrap gap-2">
          <input id={id} className="input min-w-60 flex-1 font-code" value={dir} placeholder="C:\Users\kamu\.codex" spellCheck={false} onChange={(e) => setDir(e.target.value)} />
          <button type="submit" className="btn btn-secondary" disabled={!dir.trim() || check.isPending}>
            {check.isPending ? "Memeriksa" : "Periksa dan simpan"}
          </button>
        </div>
      </form>
      {status && (
        <p className={status.ok ? "text-dense text-fg-2" : "rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text"} role={status.ok ? "status" : "alert"}>
          {status.message}
          {status.ok && status.models.length > 0 && ` Model: ${status.models.join(", ")}.`}
        </p>
      )}
      {check.isError && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {check.error.message}
        </p>
      )}
      {settings.data?.codexDir && !status && (
        <p className="text-dense text-fg-3">
          Tersimpan: <code>{settings.data.codexDir}</code>
        </p>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ import */

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (p: HarnessProfile) => void }) {
  const formId = useId();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"agent" | "chat">("agent");
  const [text, setText] = useState("");
  const run = useMutation({
    mutationFn: () => api<HarnessProfile>("/harness/import", { method: "POST", body: JSON.stringify({ name: name.trim() || "Wrapper impor", mode, text }) }),
    onSuccess: (p) => {
      setText("");
      setName("");
      onImported(p);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Impor wrapper dari teks"
      width="max-w-3xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={!text.trim() || run.isPending}>
            Impor dan pecah jadi segmen
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <p className="text-dense text-fg-2">
          Tempel wrapper apa pun. Teks yang tersusun dari tag seperti <code>&lt;identity&gt;…&lt;/identity&gt;</code> (gaya Antigravity) dipecah per tag; teks Markdown dipecah per judul. Hasilnya profil baru yang bisa kamu ubah.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <label htmlFor={`${formId}-name`} className="text-dense font-semibold">
              Nama
            </label>
            <input id={`${formId}-name`} data-autofocus className="input" value={name} maxLength={60} placeholder="Wrapper impor" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${formId}-mode`} className="text-dense font-semibold">
              Untuk
            </label>
            <select id={`${formId}-mode`} className="select" value={mode} onChange={(e) => setMode(e.target.value as "agent" | "chat")}>
              <option value="agent">Agent</option>
              <option value="chat">Chat</option>
            </select>
          </div>
        </div>
        <label htmlFor={`${formId}-text`} className="text-dense font-semibold">
          Teks wrapper
        </label>
        <textarea id={`${formId}-text`} className="textarea min-h-64 font-code text-dense" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        {run.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {run.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ editor */

function newSegment(existing: HarnessSegment[]): HarnessSegment {
  let n = existing.length + 1;
  while (existing.some((s) => s.id === `segmen_${n}`)) n++;
  return { id: `segmen_${n}`, title: `Segmen ${n}`, purpose: "", enabled: true, content: "", dynamic: false, placement: "system" };
}

function ProfileEditor({
  profile,
  tools,
  onClose,
  onSaved,
  onDuplicate,
}: {
  profile: HarnessProfile | null;
  tools: { name: string; description: string; readOnly: boolean }[];
  onClose: () => void;
  onSaved: () => void;
  onDuplicate: (id: string) => void;
}) {
  const formId = useId();
  const [form, setForm] = useState<HarnessProfile | null>(null);
  const [files, setFiles] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const readOnly = profile?.builtin ?? false;

  useEffect(() => {
    setForm(profile ? structuredClone(profile) : null);
    setFiles(profile?.projectInstructions.join(", ") ?? "");
    setError(null);
    setPreviewing(false);
  }, [profile]);

  const save = useMutation({
    mutationFn: (patch: HarnessProfilePatch) => api<HarnessProfile>(`/harness/${profile!.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form || readOnly) return;
    setError(null);
    save.mutate({
      name: form.name,
      description: form.description,
      segments: form.segments,
      wrap: form.wrap,
      tools: form.tools,
      loop: form.loop,
      memory: form.memory,
      userTag: form.userTag?.trim() ? form.userTag.trim() : null,
      instructionsStyle: form.instructionsStyle,
      toolStyle: form.toolStyle,
      projectInstructions: files
        .split(/[,\n]/)
        .map((f) => f.trim())
        .filter(Boolean),
    });
  }

  const set = <K extends keyof HarnessProfile>(key: K, value: HarnessProfile[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const setSeg = (i: number, patch: Partial<HarnessSegment>) => setForm((f) => (f ? { ...f, segments: f.segments.map((s, j) => (j === i ? { ...s, ...patch } : s)) } : f));
  const moveSeg = (i: number, by: number) =>
    setForm((f) => {
      if (!f) return f;
      const segs = [...f.segments];
      const j = i + by;
      if (j < 0 || j >= segs.length) return f;
      [segs[i], segs[j]] = [segs[j]!, segs[i]!];
      return { ...f, segments: segs };
    });
  const setLoop = (key: keyof HarnessProfile["loop"], value: number) => setForm((f) => (f ? { ...f, loop: { ...f.loop, [key]: value } } : f));

  return (
    <Dialog
      open={profile !== null}
      onClose={onClose}
      title={readOnly ? profile?.name ?? "Profil" : `Ubah ${profile?.name ?? "profil"}`}
      width="max-w-4xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost mr-auto" onClick={() => setPreviewing(true)}>
            Anatomi request
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {readOnly ? "Tutup" : "Batal"}
          </button>
          {readOnly ? (
            <button type="button" className="btn btn-primary" onClick={() => profile && onDuplicate(profile.id)}>
              Duplikasi untuk mengubah
            </button>
          ) : (
            <button type="submit" form={formId} className="btn btn-primary" disabled={save.isPending}>
              Simpan
            </button>
          )}
        </>
      }
    >
      {form && (
        <form id={formId} onSubmit={submit} className="grid gap-5">
          {readOnly && (
            <p className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2">
              Ini profil bawaan{form.fromCodex ? " yang dibaca langsung dari Codex" : ""}, jadi hanya bisa dilihat. Duplikasi untuk mendapatkan salinan yang bisa diubah sesuka hati.
            </p>
          )}
          {form.fromCodex && form.segments.length === 0 && (
            <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
              Wrapper Codex belum terbaca. Atur folder Codex di atas.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <label htmlFor={`${formId}-name`} className="text-dense font-semibold">
                Nama
              </label>
              <input id={`${formId}-name`} className="input" value={form.name} maxLength={60} disabled={readOnly} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="grid gap-1">
              <label htmlFor={`${formId}-wrap`} className="text-dense font-semibold">
                Format segmen
              </label>
              <select id={`${formId}-wrap`} className="select" value={form.wrap} disabled={readOnly} onChange={(e) => set("wrap", e.target.value as SegmentWrap)}>
                <option value="plain">Teks biasa (judul Markdown di dalam segmen)</option>
                <option value="tags">Tag, seperti &lt;identity&gt;…&lt;/identity&gt;</option>
              </select>
            </div>
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${formId}-desc`} className="text-dense font-semibold">
              Deskripsi
            </label>
            <input id={`${formId}-desc`} className="input" value={form.description} maxLength={400} disabled={readOnly} onChange={(e) => set("description", e.target.value)} />
          </div>

          <fieldset className="grid gap-3 border-0 p-0">
            <legend className="mb-1 flex w-full items-center gap-2 text-dense font-semibold">
              Segmen
              <span className="font-normal text-fg-3">Variabel: {"{{date}} {{os}} {{shell}} {{workspace}} {{approval}} {{model}} {{timezone}} {{codex_permissions}}"}</span>
            </legend>
            <ol className="grid gap-3">
              {form.segments.map((s, i) => (
                <li key={`${s.id}-${i}`} className={`grid gap-2 rounded-md border p-3 ${s.enabled ? "border-line bg-surface" : "border-dashed border-line bg-sunken"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" role="switch" aria-checked={s.enabled} aria-label={`Segmen ${s.title}`} disabled={readOnly} className="switch" onClick={() => setSeg(i, { enabled: !s.enabled })}>
                      <span className="switch-track" aria-hidden />
                    </button>
                    <label className="sr-only" htmlFor={`${formId}-t-${i}`}>
                      Judul segmen {i + 1}
                    </label>
                    <input id={`${formId}-t-${i}`} className="input min-w-40 flex-1 font-semibold" value={s.title} maxLength={80} disabled={readOnly} onChange={(e) => setSeg(i, { title: e.target.value })} />
                    <label className="sr-only" htmlFor={`${formId}-pl-${i}`}>
                      Tempat segmen {i + 1}
                    </label>
                    <select
                      id={`${formId}-pl-${i}`}
                      className="select w-auto min-h-8 py-0 text-meta"
                      value={s.placement ?? "system"}
                      disabled={readOnly}
                      title="Ke mana teks segmen ini dikirim"
                      onChange={(e) => setSeg(i, { placement: e.target.value as SegmentPlacement })}
                    >
                      {(Object.keys(PLACEMENT_LABEL) as SegmentPlacement[]).map((p) => (
                        <option key={p} value={p}>
                          {PLACEMENT_LABEL[p]}
                        </option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1.5 text-meta text-fg-2" title="Bagian yang berubah tiap request (tanggal, folder). Dikirim paling akhir supaya awal prompt bisa di-cache.">
                      <input type="checkbox" checked={s.dynamic} disabled={readOnly} onChange={(e) => setSeg(i, { dynamic: e.target.checked })} />
                      berubah-ubah
                    </label>
                    {!readOnly && (
                      <span className="flex gap-0.5">
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Naikkan" disabled={i === 0} onClick={() => moveSeg(i, -1)}>
                          <ArrowUpIcon size={14} aria-hidden />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label="Turunkan" disabled={i === form.segments.length - 1} onClick={() => moveSeg(i, 1)}>
                          <ArrowDownIcon size={14} aria-hidden />
                        </button>
                        <button type="button" className="btn btn-ghost btn-icon" aria-label={`Hapus segmen ${s.title}`} onClick={() => set("segments", form.segments.filter((_, j) => j !== i))}>
                          <TrashIcon size={14} aria-hidden />
                        </button>
                      </span>
                    )}
                  </div>
                  <label className="sr-only" htmlFor={`${formId}-p-${i}`}>
                    Kegunaan segmen {i + 1}
                  </label>
                  <input
                    id={`${formId}-p-${i}`}
                    className="input text-dense"
                    value={s.purpose}
                    maxLength={300}
                    disabled={readOnly}
                    placeholder="Kegunaan segmen ini (catatan untukmu, tidak dikirim ke model)"
                    onChange={(e) => setSeg(i, { purpose: e.target.value })}
                  />
                  <details open={!readOnly && s.content.length < 600}>
                    <summary className="cursor-pointer text-meta text-fg-3">
                      Isi ({s.content.length} karakter, sekitar {Math.ceil(s.content.length / 4)} token)
                    </summary>
                    <label className="sr-only" htmlFor={`${formId}-c-${i}`}>
                      Isi segmen {i + 1}
                    </label>
                    <textarea
                      id={`${formId}-c-${i}`}
                      className="textarea mt-1 min-h-32 font-code text-dense"
                      value={s.content}
                      readOnly={readOnly}
                      spellCheck={false}
                      onChange={(e) => setSeg(i, { content: e.target.value })}
                    />
                  </details>
                </li>
              ))}
            </ol>
            {!readOnly && (
              <button type="button" className="btn btn-secondary justify-self-start" onClick={() => set("segments", [...form.segments, newSegment(form.segments)])}>
                <PlusIcon size={14} aria-hidden />
                Tambah segmen
              </button>
            )}
          </fieldset>

          <label className="flex items-center gap-2 text-dense">
            <input type="checkbox" checked={form.memory} disabled={readOnly} onChange={(e) => set("memory", e.target.checked)} />
            Sertakan memori yang sudah disetujui (Settings, bagian Memori)
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1">
              <label htmlFor={`${formId}-tag`} className="text-dense font-semibold">
                Bungkus pesanmu dengan tag
              </label>
              <input
                id={`${formId}-tag`}
                className="input font-code"
                value={form.userTag ?? ""}
                placeholder="kosong = tidak dibungkus"
                maxLength={40}
                disabled={readOnly}
                onChange={(e) => set("userTag", e.target.value.replace(/[^A-Za-z0-9_-]/g, "") || null)}
              />
              <p className="text-meta text-fg-3">Contoh: USER_REQUEST menjadi &lt;USER_REQUEST&gt;…&lt;/USER_REQUEST&gt;.</p>
            </div>
            {form.mode === "agent" && (
              <>
                <div className="grid gap-1">
                  <label htmlFor={`${formId}-istyle`} className="text-dense font-semibold">
                    Cara kirim AGENTS.md
                  </label>
                  <select id={`${formId}-istyle`} className="select" value={form.instructionsStyle} disabled={readOnly} onChange={(e) => set("instructionsStyle", e.target.value as "ezclaw" | "codex")}>
                    <option value="ezclaw">Di system prompt</option>
                    <option value="codex">Gaya Codex: pesan sebelum pesanmu</option>
                  </select>
                </div>
                <div className="grid gap-1">
                  <label htmlFor={`${formId}-tstyle`} className="text-dense font-semibold">
                    Deskripsi tools
                  </label>
                  <select id={`${formId}-tstyle`} className="select" value={form.toolStyle} disabled={readOnly} onChange={(e) => set("toolStyle", e.target.value as "ezclaw" | "codex")}>
                    <option value="ezclaw">EZClaw</option>
                    <option value="codex">Gaya Codex (untuk tool yang Codex juga punya)</option>
                  </select>
                </div>
              </>
            )}
          </div>

          {form.mode === "agent" && (
            <>
              <fieldset className="grid gap-1.5 border-0 p-0">
                <legend className="mb-1 text-dense font-semibold">Tools</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {tools.map((t) => (
                    <label key={t.name} className="flex items-start gap-2 text-dense" title={t.description}>
                      <input type="checkbox" className="mt-1" disabled={readOnly} checked={form.tools.includes(t.name)} onChange={(e) => set("tools", e.target.checked ? [...form.tools, t.name] : form.tools.filter((x) => x !== t.name))} />
                      <span>
                        <code>{t.name}</code>
                        {t.readOnly && <span className="text-fg-3"> (hanya baca)</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput id={`${formId}-steps`} label="Maks langkah per run" value={form.loop.maxSteps} min={1} max={500} disabled={readOnly} onChange={(v) => setLoop("maxSteps", v)} />
                <NumberInput id={`${formId}-clip`} label="Batas output tool (karakter)" value={form.loop.toolOutputLimit} min={1000} max={400000} disabled={readOnly} onChange={(v) => setLoop("toolOutputLimit", v)} />
                <NumberInput id={`${formId}-compact`} label="Padatkan konteks pada (0.3 sampai 0.95)" value={form.loop.compactAt} min={0.3} max={0.95} step={0.05} disabled={readOnly} onChange={(v) => setLoop("compactAt", v)} />
                <NumberInput id={`${formId}-timeout`} label="Batas waktu perintah (ms)" value={form.loop.shellTimeoutMs} min={1000} max={600000} step={1000} disabled={readOnly} onChange={(v) => setLoop("shellTimeoutMs", v)} />
              </div>
              <div className="grid gap-1">
                <label htmlFor={`${formId}-files`} className="text-dense font-semibold">
                  File instruksi project
                </label>
                <input id={`${formId}-files`} className="input font-code" value={files} disabled={readOnly} placeholder="AGENTS.md, EZCLAW.md, CLAUDE.md" onChange={(e) => setFiles(e.target.value)} />
                <p className="text-meta text-fg-3">Dibaca dari folder workspace dan folder induknya, lalu ditambahkan setelah segmen tetap.</p>
              </div>
            </>
          )}

          {error && (
            <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {profile && <PreviewDialog open={previewing} onClose={() => setPreviewing(false)} profileId={profile.id} edited={!readOnly} />}
    </Dialog>
  );
}

function Block({ n, title, note, children }: { n: number; title: string; note: string; children: ReactNode }) {
  return (
    <li className="grid gap-1.5">
      <h3 className="flex flex-wrap items-baseline gap-2 text-dense font-semibold">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-brand-soft text-meta text-brand-soft-text">{n}</span>
        {title}
        <span className="font-normal text-fg-3">{note}</span>
      </h3>
      {children}
    </li>
  );
}

const PRE = "m-0 max-h-[40vh] overflow-auto rounded-sm border border-line bg-sunken p-3 font-code text-dense whitespace-pre-wrap break-words";

/** Everything the harness puts into one request, in the order the model reads it. */
function PreviewDialog({ open, onClose, profileId, edited }: { open: boolean; onClose: () => void; profileId: string; edited: boolean }) {
  const preview = useQuery({
    queryKey: ["harness-preview", profileId],
    queryFn: () => api<HarnessPreviewResponse>(`/harness/${profileId}/preview`),
    enabled: open,
    staleTime: 0,
  });
  const d = preview.data;
  let n = 0;
  return (
    <Dialog open={open} onClose={onClose} title="Anatomi request" width="max-w-4xl">
      <div className="grid gap-4">
        <p className="text-dense text-fg-2">
          Ini urutan yang dibaca model pada satu request, dari atas ke bawah. Segmen profil ini mengisi system prompt, pesan developer, dan konteks sesuai tempat yang kamu pilih per segmen; tools dikirim di field terpisah.
          {edited && " Pratinjau memakai versi yang sudah disimpan."}
        </p>
        {preview.isPending && (
          <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Menyusun request
          </p>
        )}
        {preview.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {preview.error.message}
          </p>
        )}
        {d && (
          <>
            <p className="text-dense text-fg-2">
              Sekitar {d.approxTokens} token tambahan dari harness. {Math.round((d.stableChars / Math.max(1, d.text.length)) * 100)}% system prompt sama di setiap request, jadi bisa di-cache provider.
            </p>
            <ol className="grid gap-4">
              <Block n={++n} title="System prompt" note="role system, atau instructions di Responses API">
                <pre className={PRE}>
                  <span>{d.text.slice(0, d.stableChars)}</span>
                  <span className="text-brand-text">{d.text.slice(d.stableChars)}</span>
                </pre>
                <p className="text-meta text-fg-3">Bagian berwarna di akhir adalah segmen yang berubah setiap request.</p>
              </Block>
              {d.developer.length > 0 && (
                <Block n={++n} title={`Pesan developer (${d.developer.length})`} note="role developer; untuk Anthropic digabung ke system prompt">
                  {d.developer.map((t, i) => (
                    <pre key={i} className={PRE}>
                      {t}
                    </pre>
                  ))}
                </Block>
              )}
              <Block n={++n} title="Riwayat percakapan" note="pesan-pesan sebelumnya, hasil tool, dan ringkasan bila dipadatkan">
                <p className="rounded-sm border border-dashed border-line px-3 py-2 text-dense text-fg-3">(isi thread)</p>
              </Block>
              {d.context && (
                <Block n={++n} title="Konteks" note="role user, tepat sebelum pesanmu yang terbaru">
                  <pre className={PRE}>{d.context}</pre>
                </Block>
              )}
              <Block n={++n} title="Pesanmu" note="role user">
                <pre className={PRE}>{d.userMessage}</pre>
              </Block>
              {d.tools.length > 0 && (
                <Block n={++n} title={`Tools (${d.tools.length})`} note="dikirim di field tools, bukan sebagai teks prompt">
                  <ul className="grid gap-1.5">
                    {d.tools.map((t) => (
                      <li key={t.name} className="rounded-sm border border-line bg-surface p-2">
                        <code className="font-semibold">{t.name}</code>
                        <p className="mt-0.5 whitespace-pre-wrap text-meta text-fg-2">{t.description}</p>
                      </li>
                    ))}
                  </ul>
                </Block>
              )}
            </ol>
          </>
        )}
      </div>
    </Dialog>
  );
}

function NumberInput({ id, label, value, min, max, step = 1, disabled, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-dense font-semibold">
        {label}
      </label>
      <input id={id} type="number" className="input" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
