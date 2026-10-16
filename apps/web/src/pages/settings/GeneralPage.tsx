import { MODEL_ROLES, MODEL_ROLE_LABELS, WEB_SEARCH_LABELS, WEB_SEARCH_PROVIDERS, type HealthResponse, type ModelDto, type ModelRole, type WebSearchProvider, type WebSearchStatus } from "@ezclaw/core";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { FolderPicker } from "../../components/agent/FolderPicker";
import { api } from "../../api";
import { ThemeSwitch } from "../../components/ThemeSwitch";
import { keys, modelLabel, useModels, useSettings, useUpdateSettings, useWebSearch } from "../../lib/queries";
import { useTheme } from "../../theme";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-4 border-t border-line py-8 first-of-type:border-t-0 first-of-type:pt-0">
      <h2 id={id} className="text-title font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function formatStarted(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

const ROLE_NOTE: Record<ModelRole, string> = {
  chat: "Dipakai untuk thread Chat baru.",
  agent: "Dipakai untuk tugas Agent baru.",
  image: "Dipakai untuk thread Image baru.",
  edit: "Dipakai untuk Edit baru; kosong berarti ikut model Image.",
  composer: "Menyusun prompt gambar dan merapikan prompt edit.",
  title: "Judul dan ringkasan thread, mulai M2.",
};

const IMAGE_ROLES: ModelRole[] = ["image", "edit"];

function ServerStatus() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<HealthResponse>("/health") });

  if (health.isPending) {
    return (
      <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
        <span className="node node-run" aria-hidden />
        Memeriksa server lokal
      </p>
    );
  }
  if (health.isError) {
    return (
      <div className="grid gap-3 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
        <p>{health.error.message}</p>
        <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void health.refetch()}>
          <ArrowClockwiseIcon size={18} aria-hidden />
          Periksa lagi
        </button>
      </div>
    );
  }

  const { secretStore } = health.data;
  const rows: [string, ReactNode][] = [
    ["Status", <span className="flex items-center gap-2"><span className="node node-done" aria-hidden />Berjalan</span>],
    ["Versi", <code>{health.data.version}</code>],
    ["Alamat", <code>{health.data.listen}</code>],
    ["Folder data", <code className="break-all">{health.data.dataDir}</code>],
    ["Database", <code className="break-all">{health.data.dbPath}</code>],
    [
      "Penyimpanan key",
      <span className="grid gap-1">
        <span className="flex items-center gap-2">
          <span className={`node ${secretStore.secure ? "node-done" : "node-wait"}`} aria-hidden />
          {secretStore.backend === "keyring" ? "Credential Manager OS" : secretStore.backend === "file" ? "File terenkripsi lokal" : "Memori"}
        </span>
        <span className="text-dense text-fg-3">{secretStore.detail}</span>
      </span>,
    ],
    ["Berjalan sejak", formatStarted(health.data.startedAt)],
  ];

  return (
    <div className="grid gap-4">
      <dl className="grid gap-x-6 gap-y-3 text-ui sm:grid-cols-[10rem_minmax(0,1fr)]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-dense font-semibold text-fg-2">{label}</dt>
            <dd className="m-0 min-w-0">{value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void health.refetch()} disabled={health.isFetching}>
        <ArrowClockwiseIcon size={18} aria-hidden />
        {health.isFetching ? "Memeriksa" : "Periksa lagi"}
      </button>
    </div>
  );
}

function DefaultModels() {
  const models = useModels();
  const settings = useSettings();
  const update = useUpdateSettings();

  if (models.isPending || settings.isPending) {
    return (
      <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
        <span className="node node-run" aria-hidden />
        Memuat model
      </p>
    );
  }
  if (models.isError || settings.isError) {
    const err = models.error ?? settings.error;
    return (
      <div className="grid gap-2 rounded-sm bg-danger-soft p-3 text-ui text-danger-text" role="alert">
        <p>{err?.message}</p>
        <button type="button" className="btn btn-secondary justify-self-start" onClick={() => { void models.refetch(); void settings.refetch(); }}>
          Coba lagi
        </button>
      </div>
    );
  }

  const all = models.data.models;
  if (all.length === 0) {
    return <p className="text-body text-fg-2">Belum ada model. Tambahkan endpoint di tab Endpoint, lalu pilih model bawaan di sini.</p>;
  }

  const current = settings.data.defaultModels;
  function choose(role: ModelRole, id: string) {
    const next = { ...current };
    if (id) next[role] = id;
    else delete next[role];
    update.mutate({ defaultModels: next });
  }

  return (
    <div className="grid gap-4">
      {MODEL_ROLES.map((role) => {
        const kind = IMAGE_ROLES.includes(role) ? "image" : "text";
        const options: ModelDto[] = all.filter((m) => m.kind === kind || (kind === "image" && m.summary.outputModalities.includes("image")));
        return (
          <div key={role} className="grid gap-1 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4">
            <label htmlFor={`role-${role}`} className="text-ui font-semibold">
              {MODEL_ROLE_LABELS[role]}
              <span className="block text-meta font-normal text-fg-3">{ROLE_NOTE[role]}</span>
            </label>
            <select id={`role-${role}`} className="select" value={current[role] ?? ""} onChange={(e) => choose(role, e.target.value)} disabled={update.isPending}>
              <option value="">{options.length ? "Tanpa model bawaan" : "Belum ada model yang cocok"}</option>
              {options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.endpointName} / {modelLabel(m)}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {update.isError && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {update.error.message}
        </p>
      )}
    </div>
  );
}

export function GeneralPage() {
  const { saving, saveError } = useTheme();
  const settings = useSettings();
  const update = useUpdateSettings();
  const autoRetry = settings.data?.autoRetryRejectedParams ?? true;

  return (
    <div>
      <Section id="settings-appearance" title="Tampilan">
        <ThemeSwitch />
        <p className="text-dense text-fg-3">Ikut OS memakai tema Windows. Pilihan disimpan di database lokal{saving ? ", sedang menyimpan" : ""}.</p>
        {saveError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            Tema diterapkan di browser ini, tapi gagal disimpan ke server: {saveError}
          </p>
        )}
      </Section>

      <Section id="settings-models" title="Model bawaan">
        <DefaultModels />
      </Section>

      <Section id="settings-behaviour" title="Perilaku request">
        <div className="grid gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={autoRetry}
            className="switch"
            disabled={!settings.data || update.isPending}
            onClick={() => update.mutate({ autoRetryRejectedParams: !autoRetry })}
          >
            <span className="switch-track" aria-hidden />
            Kirim ulang tanpa parameter yang ditolak
          </button>
          <p className="max-w-prose text-dense text-fg-3">
            Jika provider menjawab 400 dan menyebut satu parameter yang tidak didukung, EZClaw mengulang sekali tanpa parameter itu, mencatatnya untuk model tersebut, dan memberi tahu kamu di jawaban. Error 401, 402, 403, dan 429 tidak pernah diulang.
          </p>
        </div>
        {update.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {update.error.message}
          </p>
        )}
      </Section>

      <Section id="settings-web" title="Pencarian web untuk Agent">
        <WebSearchSettings />
      </Section>

      <Section id="settings-skills" title="Folder skill">
        <SkillFolders />
      </Section>

      <Section id="settings-server" title="Server lokal">
        <ServerStatus />
      </Section>

      <Section id="settings-security" title="Keamanan">
        <ul className="grid list-disc gap-2 pl-5 text-body text-fg-2">
          <li>Server hanya mendengarkan di 127.0.0.1, jadi tidak bisa diakses dari komputer lain.</li>
          <li>Setiap kali EZClaw dijalankan, token sesi baru dibuat. Request API tanpa token itu ditolak.</li>
          <li>Request dari situs lain, atau dengan alamat host selain 127.0.0.1 dan localhost, ditolak.</li>
          <li>API key tidak disimpan di database dan tidak pernah dikirim kembali ke browser. Catatan request menyembunyikan header kunci.</li>
        </ul>
      </Section>
    </div>
  );
}

const SEARCH_LINKS: Record<WebSearchProvider, string> = {
  brave: "https://api-dashboard.search.brave.com",
  tavily: "https://app.tavily.com",
  exa: "https://dashboard.exa.ai",
};

function WebSearchSettings() {
  const status = useWebSearch();
  const qc = useQueryClient();
  const id = useId();
  const [provider, setProvider] = useState<WebSearchProvider>("brave");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const call = async (fn: () => Promise<WebSearchStatus>) => {
    setBusy(true);
    setError(null);
    try {
      qc.setQueryData(keys.webSearch, await fn());
      setKey("");
      void qc.invalidateQueries({ queryKey: keys.settings });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <p className="max-w-prose text-dense text-fg-3">
        Tool <code>web_search</code> butuh layanan pencarian dengan API key-mu sendiri. Key disimpan di penyimpanan kredensial komputer ini. Tanpa ini, Agent tetap bisa membaca halaman yang alamatnya sudah diketahui lewat <code>web_fetch</code>.
      </p>
      {status.data?.provider && status.data.hasKey ? (
        <div className="flex flex-wrap items-center gap-2 text-dense">
          <span>
            Aktif: <strong>{WEB_SEARCH_LABELS[status.data.provider]}</strong>
          </span>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void call(() => api<WebSearchStatus>("/websearch/key", { method: "DELETE" }))}>
            Hapus key dan matikan
          </button>
        </div>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void call(() => api<WebSearchStatus>("/websearch/key", { method: "PUT", body: JSON.stringify({ provider, key }) }));
          }}
        >
          <div className="grid gap-1">
            <label htmlFor={`${id}-p`} className="text-dense font-semibold">
              Layanan
            </label>
            <select id={`${id}-p`} className="select w-auto" value={provider} onChange={(e) => setProvider(e.target.value as WebSearchProvider)}>
              {WEB_SEARCH_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {WEB_SEARCH_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid min-w-60 flex-1 gap-1">
            <label htmlFor={`${id}-k`} className="text-dense font-semibold">
              API key
            </label>
            <input id={`${id}-k`} className="input font-code" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || key.trim().length < 8}>
            Simpan
          </button>
          <a className="text-dense text-brand-text underline" href={SEARCH_LINKS[provider]} target="_blank" rel="noreferrer noopener">
            Ambil key {WEB_SEARCH_LABELS[provider]}
          </a>
        </form>
      )}
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function SkillFolders() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const [picking, setPicking] = useState(false);
  const dirs = settings.data?.skillDirs ?? [];
  return (
    <div className="grid gap-3">
      <p className="max-w-prose text-dense text-fg-3">
        Skill adalah folder berisi <code>SKILL.md</code> (instruksi untuk tugas tertentu). Agent melihat daftar skill dan membacanya saat relevan. EZClaw selalu memeriksa folder <code>.ezclaw/skills</code>, <code>.agents/skills</code>, dan <code>.claude/skills</code> di workspace, serta folder <code>skills</code> di data EZClaw. Tambahkan folder lain di sini, misalnya kumpulan skill yang sudah kamu punya.
      </p>
      {dirs.length > 0 && (
        <ul className="grid gap-1">
          {dirs.map((d) => (
            <li key={d} className="flex items-center gap-2 text-dense">
              <code className="min-w-0 flex-1 break-all">{d}</code>
              <button type="button" className="btn btn-ghost min-h-8" onClick={() => update.mutate({ skillDirs: dirs.filter((x) => x !== d) })}>
                Hapus
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-secondary justify-self-start" disabled={dirs.length >= 10} onClick={() => setPicking(true)}>
        Tambah folder skill
      </button>
      <FolderPicker
        open={picking}
        onClose={() => setPicking(false)}
        initial={null}
        recent={[]}
        title="Folder yang berisi skill"
        onPick={(p) => {
          setPicking(false);
          if (!dirs.includes(p)) update.mutate({ skillDirs: [...dirs, p] });
        }}
      />
    </div>
  );
}
