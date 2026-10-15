import { MODEL_ROLES, MODEL_ROLE_LABELS, type HealthResponse, type ModelDto, type ModelRole } from "@ezclaw/core";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api } from "../../api";
import { ThemeSwitch } from "../../components/ThemeSwitch";
import { modelLabel, useModels, useSettings, useUpdateSettings } from "../../lib/queries";
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
  agent: "Dipakai mulai M2.",
  image: "Dipakai mulai M3.",
  edit: "Dipakai mulai M4.",
  composer: "Menyusun prompt gambar, mulai M3.",
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
