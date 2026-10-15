import type { CodexStatusResponse, HarnessProfile, HarnessProfilePatch } from "@ezclaw/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { keys, useHarness, useSettings, useUpdateSettings } from "../../lib/queries";

export function HarnessPage() {
  const harness = useHarness();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<HarnessProfile | null>(null);
  const [removing, setRemoving] = useState<HarnessProfile | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: keys.harness });
  const duplicate = useMutation({ mutationFn: (id: string) => api<HarnessProfile>(`/harness/${id}/duplicate`, { method: "POST" }), onSuccess: (p) => { refresh(); setEditing(p); } });
  const remove = useMutation({ mutationFn: (id: string) => api(`/harness/${id}`, { method: "DELETE" }), onSuccess: () => { refresh(); setRemoving(null); } });

  return (
    <div className="grid gap-8">
      <p className="max-w-prose text-body text-fg-2">
        Harness adalah instruksi, tools, dan aturan loop yang mengubah model biasa menjadi agent. Bisa dimatikan per thread untuk membandingkan model mentah dengan model yang dibungkus harness.
      </p>

      <CodexSection />

      <section aria-labelledby="hp-title" className="grid gap-4">
        <h2 id="hp-title" className="text-title font-semibold">
          Profil
        </h2>
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
          {harness.data?.profiles.map((p) => (
            <li key={p.id} className="grid gap-2 rounded-md border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-ui font-semibold">{p.name}</h3>
                <span className="ep-tag">{p.mode === "agent" ? "Agent" : "Chat"}</span>
                {p.builtin && <span className="ep-tag">bawaan</span>}
                {p.fromCodex && <span className="ep-tag">dari Codex</span>}
              </div>
              <p className="text-dense text-fg-2">{p.description}</p>
              <p className="text-meta text-fg-3">
                Tools: <code>{p.tools.join(", ") || "tidak ada"}</code> · maks {p.loop.maxSteps} langkah · file instruksi: <code>{p.projectInstructions.join(", ") || "tidak ada"}</code>
              </p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn btn-secondary" onClick={() => duplicate.mutate(p.id)} disabled={duplicate.isPending}>
                  Duplikasi
                </button>
                {!p.builtin && (
                  <>
                    <button type="button" className="btn btn-secondary" onClick={() => setEditing(p)}>
                      Ubah
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setRemoving(p)}>
                      Hapus
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {duplicate.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {duplicate.error.message}
          </p>
        )}
      </section>

      <ProfileEditor profile={editing} tools={harness.data?.tools ?? []} onClose={() => setEditing(null)} onSaved={refresh} />

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

function CodexSection() {
  const settings = useSettings();
  const update = useUpdateSettings();
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
      if (s.ok) update.mutate({ codexDir: dir.trim() });
    },
  });

  return (
    <section aria-labelledby="codex-title" className="grid gap-3 rounded-md border border-line bg-surface p-4">
      <h2 id="codex-title" className="text-title font-semibold">
        Folder Codex
      </h2>
      <p className="max-w-prose text-dense text-fg-2">
        Profil <strong>Codex-ref</strong> memakai instruksi sistem dari <code>models.json</code> di instalasi Codex-mu, supaya kamu bisa membandingkannya dengan EZClaw Agent pada task yang sama. EZClaw hanya membuka file <code>models.json</code> itu; isi folder lainnya (termasuk kredensial) tidak dibaca.
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
      {settings.data?.codexDir && !status && <p className="text-dense text-fg-3">Tersimpan: <code>{settings.data.codexDir}</code></p>}
    </section>
  );
}

function ProfileEditor({ profile, tools, onClose, onSaved }: { profile: HarnessProfile | null; tools: { name: string; description: string; readOnly: boolean }[]; onClose: () => void; onSaved: () => void }) {
  const formId = useId();
  const [form, setForm] = useState<HarnessProfile | null>(null);
  const [files, setFiles] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm(profile ? structuredClone(profile) : null);
    setFiles(profile?.projectInstructions.join(", ") ?? "");
    setError(null);
  }, [profile]);

  const save = useMutation({
    mutationFn: (patch: HarnessProfilePatch) => api(`/harness/${profile!.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setError(null);
    save.mutate({
      name: form.name,
      description: form.description,
      systemPrompt: form.systemPrompt,
      fromCodex: form.fromCodex,
      tools: form.tools,
      loop: form.loop,
      projectInstructions: files.split(/[,\n]/).map((f) => f.trim()).filter(Boolean),
    });
  }

  const set = <K extends keyof HarnessProfile>(key: K, value: HarnessProfile[K]) => setForm((f) => (f ? { ...f, [key]: value } : f));
  const setLoop = (key: keyof HarnessProfile["loop"], value: number) => setForm((f) => (f ? { ...f, loop: { ...f.loop, [key]: value } } : f));

  return (
    <Dialog
      open={profile !== null}
      onClose={onClose}
      title={`Ubah ${profile?.name ?? "profil"}`}
      width="max-w-2xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={save.isPending}>
            Simpan
          </button>
        </>
      }
    >
      {form && (
        <form id={formId} onSubmit={submit} className="grid gap-4">
          <div className="grid gap-1">
            <label htmlFor={`${formId}-name`} className="text-dense font-semibold">
              Nama
            </label>
            <input id={`${formId}-name`} data-autofocus className="input" value={form.name} maxLength={60} onChange={(e) => set("name", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${formId}-desc`} className="text-dense font-semibold">
              Deskripsi
            </label>
            <input id={`${formId}-desc`} className="input" value={form.description} maxLength={400} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${formId}-prompt`} className="text-dense font-semibold">
              Instruksi sistem
            </label>
            <textarea id={`${formId}-prompt`} className="textarea min-h-56 font-code text-dense" value={form.systemPrompt} disabled={form.fromCodex} onChange={(e) => set("systemPrompt", e.target.value)} spellCheck={false} />
            <p className="text-meta text-fg-3">
              {form.fromCodex ? "Profil ini memakai instruksi dari Codex, jadi teks di sini tidak dipakai." : "Variabel: {{date}}, {{os}}, {{shell}}, {{workspace}}, {{approval}}."}
            </p>
          </div>
          <fieldset className="grid gap-1.5 border-0 p-0">
            <legend className="mb-1 text-dense font-semibold">Tools</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {tools.map((t) => (
                <label key={t.name} className="flex items-start gap-2 text-dense">
                  <input type="checkbox" className="mt-1" checked={form.tools.includes(t.name)} onChange={(e) => set("tools", e.target.checked ? [...form.tools, t.name] : form.tools.filter((x) => x !== t.name))} />
                  <span>
                    <code>{t.name}</code>
                    {t.readOnly && <span className="text-fg-3"> (hanya baca)</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberInput id={`${formId}-steps`} label="Maks langkah per run" value={form.loop.maxSteps} min={1} max={500} onChange={(v) => setLoop("maxSteps", v)} />
            <NumberInput id={`${formId}-clip`} label="Batas output tool (karakter)" value={form.loop.toolOutputLimit} min={1000} max={400000} onChange={(v) => setLoop("toolOutputLimit", v)} />
            <NumberInput id={`${formId}-compact`} label="Padatkan konteks pada (0.3 sampai 0.95)" value={form.loop.compactAt} min={0.3} max={0.95} step={0.05} onChange={(v) => setLoop("compactAt", v)} />
            <NumberInput id={`${formId}-timeout`} label="Batas waktu perintah (ms)" value={form.loop.shellTimeoutMs} min={1000} max={600000} step={1000} onChange={(v) => setLoop("shellTimeoutMs", v)} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${formId}-files`} className="text-dense font-semibold">
              File instruksi project
            </label>
            <input id={`${formId}-files`} className="input font-code" value={files} placeholder="AGENTS.md, EZCLAW.md" onChange={(e) => setFiles(e.target.value)} />
            <p className="text-meta text-fg-3">Dibaca dari workspace dan folder induknya, lalu ditambahkan ke instruksi sistem.</p>
          </div>
          {error && (
            <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}

function NumberInput({ id, label, value, min, max, step = 1, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-dense font-semibold">
        {label}
      </label>
      <input id={id} type="number" className="input" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}
