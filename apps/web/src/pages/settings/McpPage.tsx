import type { McpImportResponse, McpServerDto, McpStatus, McpToolPolicy } from "@ezclaw/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { keys, useMcp } from "../../lib/queries";

const STATUS: Record<McpStatus, { label: string; node: string }> = {
  off: { label: "Mati", node: "node-skip" },
  connecting: { label: "Menyambung", node: "node-run" },
  connected: { label: "Tersambung", node: "node-done" },
  error: { label: "Gagal", node: "node-fail" },
  needs_auth: { label: "Perlu login", node: "node-wait" },
};

const POLICY_LABEL: Record<McpToolPolicy, string> = {
  auto: "Ikut aturan server",
  allow: "Selalu izinkan",
  ask: "Selalu tanya",
  off: "Matikan",
};

export function McpPage() {
  const mcp = useMcp({ poll: true });
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: keys.mcp });
  const [editing, setEditing] = useState<McpServerDto | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const servers = mcp.data?.servers ?? [];

  return (
    <div className="grid gap-4">
      <div className="grid max-w-prose gap-2 text-body text-fg-2">
        <p>
          MCP server adalah program yang memberi model <strong>tools</strong> tambahan: GitHub, browser, database, Notion, dan lainnya. EZClaw menjalankan atau menghubungi server itu, lalu tools-nya bisa dipanggil model di Agent, dan di Chat bila kamu nyalakan.
        </p>
        <p>
          <strong>Lokal</strong> dijalankan di komputer ini lewat perintah seperti <code>npx</code> atau <code>uvx</code>. <strong>Remote</strong> dihubungi lewat URL; yang meminta login akan menampilkan tombol Login.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" onClick={() => setEditing("new")}>
          Tambah server
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setImporting(true)}>
          Impor dari aplikasi lain
        </button>
      </div>

      {mcp.isPending && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat MCP server
        </p>
      )}
      {mcp.isError && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {mcp.error.message}
        </p>
      )}
      {mcp.isSuccess && servers.length === 0 && (
        <div className="grid gap-2 rounded-md border border-line bg-surface p-6">
          <h2 className="text-title font-semibold">Belum ada MCP server</h2>
          <p className="max-w-prose text-dense text-fg-2">
            Tambahkan server sendiri, atau impor yang sudah kamu pakai di Claude Desktop, Cursor, atau Codex. Server hasil impor mulai dalam keadaan mati supaya kamu bisa memeriksanya dulu.
          </p>
        </div>
      )}

      <ul className="grid gap-4">
        {servers.map((s) => (
          <ServerCard key={s.id} server={s} onChanged={refresh} onEdit={() => setEditing(s)} />
        ))}
      </ul>

      {mcp.data && (
        <p className="text-meta text-fg-3">
          Alamat kembali untuk login OAuth: <code className="break-all">{mcp.data.callbackUrl}</code>
        </p>
      )}

      {editing && <ServerDialog server={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <ImportDialog open={importing} onClose={() => setImporting(false)} onDone={refresh} />
    </div>
  );
}

function ServerCard({ server: s, onChanged, onEdit }: { server: McpServerDto; onChanged: () => void; onEdit: () => void }) {
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<McpServerDto>(`/mcp/${s.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });
  const action = useMutation({
    mutationFn: (what: "connect" | "logout") => api<McpServerDto>(`/mcp/${s.id}/${what}`, { method: "POST", body: "{}" }),
    onSuccess: onChanged,
    onError: (e: Error) => setError(e.message),
  });
  const remove = useMutation({ mutationFn: () => api(`/mcp/${s.id}`, { method: "DELETE" }), onSuccess: onChanged, onError: (e: Error) => setError(e.message) });
  const st = STATUS[s.status];
  const busy = patch.isPending || action.isPending;

  return (
    <li className="grid gap-3 rounded-md border border-line bg-surface p-4" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h2 id={titleId} className="flex flex-wrap items-center gap-2 text-title font-semibold">
            {s.name}
            <span className="ep-tag">{s.transport === "stdio" ? "Lokal" : "Remote"}</span>
            <span className="flex items-center gap-1.5 text-dense font-normal text-fg-2">
              <span className={`node ${st.node}`} aria-hidden />
              {st.label}
            </span>
          </h2>
          <p className="break-all font-code text-dense text-fg-2">{s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url}</p>
          {s.serverName && (
            <p className="text-meta text-fg-3">
              {s.serverName}
              {s.serverVersion ? ` ${s.serverVersion}` : ""} · {s.tools.length} tools{s.prompts.length ? ` · ${s.prompts.length} prompts` : ""}
              {s.resourceCount ? ` · ${s.resourceCount} resources` : ""}
            </p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          disabled={busy}
          className="switch"
          onClick={() => patch.mutate({ enabled: !s.enabled })}
          title="Aktif: disambungkan saat EZClaw jalan dan tools-nya ditawarkan ke model"
        >
          <span className="switch-track" aria-hidden />
          {s.enabled ? "Aktif" : "Mati"}
        </button>
      </div>

      {s.error && (
        <p className={`rounded-sm px-3 py-2 text-dense ${s.status === "needs_auth" ? "bg-ember-soft text-ember-text" : "bg-danger-soft text-danger-text"}`} role="alert">
          {s.error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-dense text-fg-2">Dipakai di</span>
        <button type="button" className="chip-toggle" aria-pressed={s.agent} disabled={busy} onClick={() => patch.mutate({ agent: !s.agent })}>
          Agent
        </button>
        <button type="button" className="chip-toggle" aria-pressed={s.chat} disabled={busy} onClick={() => patch.mutate({ chat: !s.chat })}>
          Chat
        </button>
        <label className="ml-auto flex items-center gap-2 text-dense text-fg-2">
          Izin
          <select className="select w-auto min-h-8 py-0 text-dense" value={s.trust} disabled={busy} onChange={(e) => patch.mutate({ trust: e.target.value })}>
            <option value="ask">Ikut mode thread (tool hanya-baca tidak ditanya)</option>
            <option value="allow">Percayai server: semua tool tanpa tanya</option>
          </select>
        </label>
      </div>

      {(s.tools.length > 0 || s.prompts.length > 0) && (
        <details className="rounded-sm border border-line">
          <summary className="cursor-pointer px-3 py-2 text-dense font-semibold">Tools dan izin per tool</summary>
          <ul className="grid divide-y divide-line border-t border-line">
            {s.tools.map((t) => (
              <li key={t.name} className="grid gap-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <code className="font-semibold">{t.name}</code>
                    {t.readOnlyHint && <span className="rounded-xs bg-sunken px-1.5 text-meta text-fg-2">hanya baca</span>}
                    {t.destructiveHint && <span className="rounded-xs bg-danger-soft px-1.5 text-meta text-danger-text">bisa menghapus</span>}
                  </p>
                  {t.description && <p className="mt-0.5 line-clamp-3 text-meta text-fg-3">{t.description}</p>}
                </div>
                <label className="sr-only" htmlFor={`${s.id}-${t.name}`}>
                  Izin untuk {t.name}
                </label>
                <select
                  id={`${s.id}-${t.name}`}
                  className="select w-auto min-h-8 py-0 text-dense"
                  value={t.policy}
                  disabled={busy}
                  onChange={(e) => patch.mutate({ toolPolicies: { ...s.toolPolicies, [t.name]: e.target.value } })}
                >
                  {(Object.keys(POLICY_LABEL) as McpToolPolicy[]).map((p) => (
                    <option key={p} value={p}>
                      {POLICY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </li>
            ))}
            {s.prompts.map((p) => (
              <li key={`p-${p.name}`} className="px-3 py-2 text-dense">
                <span className="rounded-xs bg-sunken px-1.5 text-meta text-fg-2">prompt</span> <code>/{s.name}:{p.name}</code>
                {p.description && <span className="text-fg-3">: {p.description}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {s.log.length > 0 && (
        <details className="rounded-sm border border-line">
          <summary className="cursor-pointer px-3 py-2 text-dense font-semibold">Log server ({s.log.length} baris terakhir)</summary>
          <pre className="m-0 max-h-60 overflow-auto border-t border-line bg-sunken p-3 font-code text-meta whitespace-pre-wrap break-words">{s.log.join("\n")}</pre>
        </details>
      )}

      <div className="flex flex-wrap gap-2">
        {s.status === "needs_auth" && s.authUrl && (
          <a className="btn btn-primary no-underline" href={s.authUrl} target="_blank" rel="noreferrer">
            Login
          </a>
        )}
        <button type="button" className="btn btn-secondary" disabled={busy || !s.enabled} onClick={() => action.mutate("connect")} title={s.enabled ? undefined : "Nyalakan server dulu"}>
          Sambung ulang
        </button>
        {s.loggedIn && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => action.mutate("logout")}>
            Keluar
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={onEdit}>
          Ubah
        </button>
        <button type="button" className="btn btn-ghost ml-auto" onClick={() => setConfirmDelete(true)}>
          Hapus
        </button>
      </div>
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Hapus ${s.name}?`}
        width="max-w-md"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>
              Batal
            </button>
            <button type="button" className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Hapus server
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">Pengaturan, env, header, dan login server ini ikut dihapus dari EZClaw. Program servernya sendiri tidak disentuh.</p>
      </Dialog>
    </li>
  );
}

const linesToMap = (text: string, sep: "=" | ":") =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(sep);
        return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ""];
      }),
  );

function ServerDialog({ server, onClose, onSaved }: { server: McpServerDto | null; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const [transport, setTransport] = useState<"stdio" | "http">(server?.transport ?? "stdio");
  const [name, setName] = useState(server?.name ?? "");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState((server?.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(server?.cwd ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  // Saved values never come back to the page; typing here replaces them all.
  const [secrets, setSecrets] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedKeys = server ? (transport === "stdio" ? server.envKeys : server.headerKeys) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const map = linesToMap(secrets, transport === "stdio" ? "=" : ":");
    const argList = args.split(/\r?\n/).map((a) => a.trim()).filter(Boolean);
    try {
      if (server) {
        const body: Record<string, unknown> = { name: name.trim() };
        if (transport === "stdio") Object.assign(body, { command: command.trim(), args: argList, cwd: cwd.trim() || null, ...(secrets.trim() ? { env: map } : {}) });
        else Object.assign(body, { url: url.trim(), ...(secrets.trim() ? { headers: map } : {}) });
        await api(`/mcp/${server.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        const body =
          transport === "stdio"
            ? { name: name.trim(), transport, command: command.trim(), args: argList, cwd: cwd.trim() || null, env: map }
            : { name: name.trim(), transport, url: url.trim(), headers: map };
        await api("/mcp", { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={server ? `Ubah ${server.name}` : "Tambah MCP server"}
      width="max-w-xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn-primary" disabled={busy}>
            Simpan
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="grid gap-4" onSubmit={(e) => void submit(e)}>
        {!server && (
          <fieldset className="flex flex-wrap gap-2 border-0 p-0">
            <legend className="mb-1 text-dense font-semibold">Jenis</legend>
            <button type="button" className="chip-toggle" aria-pressed={transport === "stdio"} onClick={() => setTransport("stdio")}>
              Lokal (perintah)
            </button>
            <button type="button" className="chip-toggle" aria-pressed={transport === "http"} onClick={() => setTransport("http")}>
              Remote (URL)
            </button>
          </fieldset>
        )}
        <Field id={`${id}-name`} label="Nama" hint="Huruf, angka, garis bawah, tanda hubung. Muncul di nama tool: mcp__nama__tool.">
          <input id={`${id}-name`} className="input font-code" value={name} required maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="github" />
        </Field>
        {transport === "stdio" ? (
          <>
            <Field id={`${id}-cmd`} label="Perintah">
              <input id={`${id}-cmd`} className="input font-code" value={command} required onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </Field>
            <Field id={`${id}-args`} label="Argumen" hint="Satu argumen per baris.">
              <textarea id={`${id}-args`} className="input min-h-24 font-code" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-github"} />
            </Field>
            <Field id={`${id}-cwd`} label="Folder kerja (opsional)">
              <input id={`${id}-cwd`} className="input font-code" value={cwd} onChange={(e) => setCwd(e.target.value)} />
            </Field>
          </>
        ) : (
          <Field id={`${id}-url`} label="URL server">
            <input id={`${id}-url`} className="input font-code" value={url} required type="url" onChange={(e) => setUrl(e.target.value)} placeholder="https://contoh.com/mcp" />
          </Field>
        )}
        <Field
          id={`${id}-sec`}
          label={transport === "stdio" ? "Variabel lingkungan (opsional)" : "Header (opsional)"}
          hint={`${transport === "stdio" ? "Satu per baris, NAMA=nilai." : "Satu per baris, Nama: nilai. Untuk server yang memakai login OAuth, kosongkan saja."} Disimpan di penyimpanan kredensial, tidak di database.${savedKeys.length ? ` Tersimpan: ${savedKeys.join(", ")}. Isi kolom ini untuk mengganti semuanya.` : ""}`}
        >
          <textarea id={`${id}-sec`} className="input min-h-20 font-code" value={secrets} onChange={(e) => setSecrets(e.target.value)} placeholder={transport === "stdio" ? "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..." : "Authorization: Bearer ..."} autoComplete="off" spellCheck={false} />
        </Field>
        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-dense font-semibold">
        {label}
      </label>
      {children}
      {hint && <p className="text-meta text-fg-3">{hint}</p>}
    </div>
  );
}

function ImportDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [result, setResult] = useState<McpImportResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (body: object) => api<McpImportResponse>("/mcp/import", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (r) => {
      setResult(r);
      setError(null);
      onDone();
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
      title="Impor MCP server"
      width="max-w-xl"
    >
      <div className="grid gap-4">
        <p className="text-dense text-fg-2">Ambil daftar server dari aplikasi lain di komputer ini. Server yang diimpor mulai dalam keadaan mati; nyalakan satu per satu setelah kamu periksa.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" disabled={run.isPending} onClick={() => run.mutate({ source: "claude" })}>
            Claude Desktop
          </button>
          <button type="button" className="btn btn-secondary" disabled={run.isPending} onClick={() => run.mutate({ source: "cursor" })}>
            Cursor
          </button>
          <button type="button" className="btn btn-secondary" disabled={run.isPending} onClick={() => run.mutate({ source: "codex" })}>
            Codex
          </button>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${id}-text`} className="text-dense font-semibold">
            Atau tempel config (JSON atau TOML)
          </label>
          <textarea id={`${id}-text`} className="input min-h-40 font-code text-dense" value={text} onChange={(e) => setText(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} spellCheck={false} />
          <button type="button" className="btn btn-primary justify-self-start" disabled={run.isPending || text.trim().length < 2} onClick={() => run.mutate({ text })}>
            Impor teks ini
          </button>
        </div>
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
