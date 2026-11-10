import type { SkillDto, SkillImportResponse } from "@ezclaw/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { keys, useMcp, useSkills } from "../../lib/queries";

export function SkillsPage() {
  const skills = useSkills();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["skills"] });
  const [editing, setEditing] = useState<SkillDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const list = skills.data?.skills ?? [];

  return (
    <div className="grid gap-4">
      <div className="grid max-w-prose gap-2 text-body text-fg-2">
        <p>
          Skill adalah folder berisi <code>SKILL.md</code>: instruksi untuk tugas tertentu (misalnya menulis catatan rilis atau membuat laporan). Model melihat nama dan deskripsinya, lalu membaca isinya saat tugasnya cocok.
        </p>
        <p>
          Ketik <code>/nama-skill</code> di awal pesan untuk memaksa model memakai skill itu. Skill bisa menyebut MCP server yang dibutuhkannya (<code>mcp: [nama]</code> di front matter); server itu dinyalakan saat skill dipakai.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          Buat skill
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setImporting(true)}>
          Impor skill
        </button>
      </div>

      {skills.isPending && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat skill
        </p>
      )}
      {skills.isError && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {skills.error.message}
        </p>
      )}
      {skills.isSuccess && list.length === 0 && (
        <div className="grid gap-2 rounded-md border border-line bg-surface p-6">
          <h2 className="text-title font-semibold">Belum ada skill</h2>
          <p className="max-w-prose text-dense text-fg-2">
            Buat skill baru, atau impor dari folder, file zip, atau repo GitHub. Skill di folder workspace (<code>.ezclaw/skills</code>, <code>.agents/skills</code>, <code>.claude/skills</code>) juga dipakai Agent di folder itu.
          </p>
        </div>
      )}

      <ul className="grid divide-y divide-line rounded-md border border-line bg-surface">
        {list.map((s) => (
          <SkillRow key={s.id} skill={s} onChanged={refresh} onEdit={() => setEditing(s)} />
        ))}
      </ul>

      {skills.data && (
        <p className="text-meta text-fg-3">
          Folder skills EZClaw: <code className="break-all">{skills.data.dir}</code>. Folder tambahan diatur di{" "}
          <Link to="/settings" className="text-brand-text underline">
            Umum
          </Link>
          .
        </p>
      )}

      {editing && <EditDialog skill={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      {creating && <CreateDialog onClose={() => setCreating(false)} onCreated={refresh} />}
      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={refresh} />
    </div>
  );
}

function SkillRow({ skill: s, onChanged, onEdit }: { skill: SkillDto; onChanged: () => void; onEdit: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (body: object) => api(`/skills/${s.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({ mutationFn: () => api(`/skills/${s.id}`, { method: "DELETE" }), onSuccess: onChanged, onError: (e: Error) => setError(e.message) });

  return (
    <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="grid min-w-0 gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <code className="text-ui font-semibold">/{s.name}</code>
          <span className="ep-tag">{s.source === "EZClaw" || s.source === "workspace" ? s.source : "folder tambahan"}</span>
          {s.mcp.map((m) => (
            <span key={m} className={`rounded-xs px-1.5 text-meta ${s.missingMcp.includes(m) ? "bg-danger-soft text-danger-text" : "bg-sunken text-fg-2"}`} title={s.missingMcp.includes(m) ? "MCP server ini belum ditambahkan" : "MCP server yang dinyalakan saat skill dipakai"}>
              MCP {m}
              {s.missingMcp.includes(m) ? " (belum ada)" : ""}
            </span>
          ))}
        </p>
        <p className="text-dense text-fg-2">{s.description || "(tanpa deskripsi)"}</p>
        <p className="break-all font-code text-meta text-fg-3">{s.dir}</p>
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <button type="button" role="switch" aria-checked={s.enabled} className="switch" disabled={patch.isPending} onClick={() => patch.mutate({ enabled: !s.enabled })}>
          <span className="switch-track" aria-hidden />
          {s.enabled ? "Aktif" : "Mati"}
        </button>
        <button type="button" className="chip-toggle" aria-pressed={s.chat} disabled={patch.isPending || !s.enabled} onClick={() => patch.mutate({ chat: !s.chat })} title="Juga dipakai di Chat">
          Chat
        </button>
        <button type="button" className="btn btn-ghost" onClick={onEdit}>
          {s.editable ? "Ubah" : "Lihat"}
        </button>
        {s.editable && (
          <button type="button" className="btn btn-ghost" disabled={remove.isPending} onClick={() => window.confirm(`Hapus skill ${s.name} beserta foldernya?`) && remove.mutate()}>
            Hapus
          </button>
        )}
      </div>
    </li>
  );
}

function EditDialog({ skill, onClose, onSaved }: { skill: SkillDto; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ content: string }>(`/skills/${skill.id}/content`)
      .then((r) => setContent(r.content))
      .catch((e: Error) => setError(e.message));
  }, [skill.id]);

  async function save() {
    if (content === null) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/skills/${skill.id}/content`, { method: "PUT", body: JSON.stringify({ content }) });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`${skill.editable ? "Ubah" : "Lihat"} /${skill.name}`}
      width="max-w-3xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {skill.editable ? "Batal" : "Tutup"}
          </button>
          {skill.editable && (
            <button type="button" className="btn btn-primary" disabled={busy || content === null} onClick={() => void save()}>
              Simpan
            </button>
          )}
        </>
      }
    >
      <div className="grid gap-2">
        {!skill.editable && <p className="text-dense text-fg-3">Skill ini ada di luar folder skills EZClaw. Ubah langsung di foldernya.</p>}
        <label htmlFor={`${id}-md`} className="text-dense font-semibold">
          SKILL.md
        </label>
        <textarea id={`${id}-md`} className="input min-h-[50vh] font-code text-dense" value={content ?? ""} readOnly={!skill.editable} disabled={content === null} spellCheck={false} onChange={(e) => setContent(e.target.value)} />
        <p className="text-meta text-fg-3">Front matter di atas wajib ada: name, description, dan opsional mcp: [nama-server].</p>
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const id = useId();
  const mcp = useMcp();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [servers, setServers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/skills", { method: "POST", body: JSON.stringify({ name, description, body, mcp: servers }) });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat skill.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Buat skill"
      width="max-w-2xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn-primary" disabled={busy}>
            Buat
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="grid gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-1">
          <label htmlFor={`${id}-name`} className="text-dense font-semibold">
            Nama
          </label>
          <input id={`${id}-name`} className="input font-code" value={name} required maxLength={64} placeholder="catatan-rilis" onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
          <p className="text-meta text-fg-3">Huruf kecil, angka, tanda hubung. Dipanggil dengan /{name || "nama"}.</p>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-desc`} className="text-dense font-semibold">
            Deskripsi
          </label>
          <input id={`${id}-desc`} className="input" value={description} required maxLength={400} placeholder="Kapan skill ini dipakai, dalam satu kalimat" onChange={(e) => setDescription(e.target.value)} />
          <p className="text-meta text-fg-3">Model memutuskan memakai skill dari deskripsi ini, jadi sebut tugas yang cocok dengan jelas.</p>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-body`} className="text-dense font-semibold">
            Instruksi
          </label>
          <textarea id={`${id}-body`} className="input min-h-48 font-code text-dense" value={body} placeholder={"# Catatan rilis\n\n1. Baca git log sejak tag terakhir.\n2. ..."} onChange={(e) => setBody(e.target.value)} />
        </div>
        {(mcp.data?.servers.length ?? 0) > 0 && (
          <fieldset className="grid gap-1 border-0 p-0">
            <legend className="mb-1 text-dense font-semibold">MCP server yang dibutuhkan (opsional)</legend>
            <div className="flex flex-wrap gap-2">
              {mcp.data!.servers.map((s) => (
                <button key={s.id} type="button" className="chip-toggle" aria-pressed={servers.includes(s.name)} onClick={() => setServers((v) => (v.includes(s.name) ? v.filter((x) => x !== s.name) : [...v, s.name]))}>
                  {s.name}
                </button>
              ))}
            </div>
          </fieldset>
        )}
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [folder, setFolder] = useState("");
  const [github, setGithub] = useState("");
  const [result, setResult] = useState<SkillImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (req: { body: BodyInit; path: string; json: boolean }) =>
      api<SkillImportResponse>(req.path, { method: "POST", body: req.body, ...(req.json ? {} : { headers: { "content-type": "application/zip" } }) }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      onDone();
      void qc.invalidateQueries({ queryKey: keys.mcp });
    },
    onError: (e: Error) => {
      setError(e.message);
      setResult(null);
    },
  });

  return (
    <Dialog
      open={open}
      onClose={() => {
        setResult(null);
        setError(null);
        onClose();
      }}
      title="Impor skill"
      width="max-w-xl"
    >
      <div className="grid gap-5">
        <p className="text-dense text-fg-2">Setiap folder berisi SKILL.md disalin ke folder skills EZClaw. Isinya instruksi untuk model, jadi impor hanya dari sumber yang kamu percaya.</p>
        <div className="grid gap-1">
          <label htmlFor={`${id}-gh`} className="text-dense font-semibold">
            Repo GitHub
          </label>
          <div className="flex flex-wrap gap-2">
            <input id={`${id}-gh`} className="input min-w-48 flex-1 font-code" value={github} placeholder="https://github.com/pemilik/repo/tree/main/skills" onChange={(e) => setGithub(e.target.value)} />
            <button type="button" className="btn btn-secondary" disabled={run.isPending || !github.trim()} onClick={() => run.mutate({ path: "/skills/import", body: JSON.stringify({ github: github.trim() }), json: true })}>
              Impor
            </button>
          </div>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-folder`} className="text-dense font-semibold">
            Folder di komputer ini
          </label>
          <div className="flex flex-wrap gap-2">
            <input id={`${id}-folder`} className="input min-w-48 flex-1 font-code" value={folder} placeholder="C:\\Users\\kamu\\skills" onChange={(e) => setFolder(e.target.value)} />
            <button type="button" className="btn btn-secondary" disabled={run.isPending || !folder.trim()} onClick={() => run.mutate({ path: "/skills/import", body: JSON.stringify({ folder: folder.trim() }), json: true })}>
              Impor
            </button>
          </div>
        </div>
        <div className="grid gap-1">
          <span className="text-dense font-semibold">File zip</span>
          <input
            ref={zipInput}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) run.mutate({ path: "/skills/import-zip", body: f, json: false });
              e.target.value = "";
            }}
          />
          <button type="button" className="btn btn-secondary justify-self-start" disabled={run.isPending} onClick={() => zipInput.current?.click()}>
            Pilih file zip
          </button>
        </div>
        {run.isPending && (
          <p className="flex items-center gap-2 text-dense text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Mengimpor
          </p>
        )}
        {result && (
          <div className="grid gap-1 rounded-sm bg-sunken px-3 py-2 text-dense" role="status">
            <p>{result.added.length ? `Ditambahkan: ${result.added.join(", ")}.` : "Tidak ada yang ditambahkan."}</p>
            {result.skipped.map((s) => (
              <p key={s.name} className="text-fg-3">
                Dilewati {s.name}: {s.reason}
              </p>
            ))}
          </div>
        )}
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
