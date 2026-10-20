import { PROTOCOL_LABELS, type EndpointDto, type EndpointTestResponse } from "@ezclaw/core";
import { KeyIcon, PlusIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { useEndpoints, useInvalidateRegistry } from "../../lib/queries";
import { EndpointDialog } from "./EndpointDialog";

const KIND_LABEL: Record<EndpointDto["kind"], string> = {
  provider: "Provider",
  gateway: "Gateway",
  local: "Lokal",
  custom: "Custom",
};

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function EndpointsPage() {
  const endpoints = useEndpoints();
  const [dialog, setDialog] = useState<{ editing: EndpointDto | null } | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const invalidate = useInvalidateRegistry();

  const test = useMutation({
    mutationFn: async (id: string) => ({
      ...(await api<EndpointTestResponse>(`/endpoints/${id}/test`, { method: "POST", body: JSON.stringify({}) })),
      at: new Date().toISOString(),
    }),
    onSettled: invalidate,
  });

  async function created(endpoint: EndpointDto) {
    setJustAdded(endpoint.id);
    if (endpoint.hasKey || !endpoint.needsKey) test.mutate(endpoint.id);
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-body text-fg-2">
          Endpoint adalah koneksi ke provider, gateway, server lokal, atau layanan kompatibel. Setiap model dari endpoint yang tersambung bisa dipakai di semua mode.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => setDialog({ editing: null })}>
          <PlusIcon size={18} aria-hidden />
          Tambah endpoint
        </button>
      </div>

      {endpoints.isPending && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat endpoint
        </p>
      )}
      {endpoints.isError && (
        <div className="grid gap-2 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
          <p>{endpoints.error.message}</p>
          <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void endpoints.refetch()}>
            Coba lagi
          </button>
        </div>
      )}
      {endpoints.isSuccess && endpoints.data.endpoints.length === 0 && (
        <div className="grid gap-3 rounded-md border border-line bg-surface p-6">
          <h2 className="text-hero font-semibold">Belum ada endpoint</h2>
          <p className="max-w-prose text-body text-fg-2">Mulai dari OpenRouter atau Venice kalau kamu ingin mencoba banyak model dengan satu key, atau tambahkan DeepSeek, OpenAI, dan provider lain secara langsung.</p>
          <button type="button" className="btn btn-primary justify-self-start" onClick={() => setDialog({ editing: null })}>
            Tambah endpoint pertama
          </button>
        </div>
      )}

      <ul className="grid gap-4">
        {endpoints.data?.endpoints.map((ep) => (
          <EndpointCard
            key={ep.id}
            endpoint={ep}
            testing={test.isPending && test.variables === ep.id}
            testResult={
              test.variables !== ep.id || test.isPending
                ? null
                : test.data
                  ? test.data
                  : test.error
                    ? { ok: false, message: test.error.message, at: new Date().toISOString() }
                    : null
            }
            highlight={justAdded === ep.id}
            onTest={() => test.mutate(ep.id)}
            onEdit={() => setDialog({ editing: ep })}
          />
        ))}
      </ul>

      <EndpointDialog open={dialog !== null} onClose={() => setDialog(null)} editing={dialog?.editing ?? null} onCreated={(e) => void created(e)} />
    </div>
  );
}

function EndpointCard({
  endpoint: ep,
  testing,
  testResult,
  highlight,
  onTest,
  onEdit,
}: {
  endpoint: EndpointDto;
  testing: boolean;
  testResult: { ok: boolean; message: string; at: string } | null;
  highlight: boolean;
  onTest: () => void;
  onEdit: () => void;
}) {
  const invalidate = useInvalidateRegistry();
  const [keyOpen, setKeyOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const titleId = useId();

  const remove = useMutation({
    mutationFn: () => api(`/endpoints/${ep.id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate();
      setDeleteOpen(false);
    },
  });
  const clearKey = useMutation({ mutationFn: () => api(`/endpoints/${ep.id}/key`, { method: "DELETE" }), onSuccess: invalidate });

  const status = testResult
    ? { ok: testResult.ok, message: testResult.message, at: testResult.at, fresh: true }
    : ep.lastTest
      ? { ok: ep.lastTest.ok, message: ep.lastTest.message, at: ep.lastTest.at, fresh: false }
      : null;

  return (
    <li className={["grid gap-3 rounded-md border bg-surface p-4", highlight ? "border-brand-strong" : "border-line"].join(" ")} aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <h2 id={titleId} className="flex flex-wrap items-center gap-2 text-title font-semibold">
            {ep.name}
            <span className="ep-tag">{KIND_LABEL[ep.kind]}</span>
          </h2>
          <p className="break-all font-code text-dense text-fg-2">{ep.baseUrl}</p>
          <p className="text-dense text-fg-3">
            {PROTOCOL_LABELS[ep.protocol]}
            {ep.family && ep.presetId === "custom" ? `, parameter seperti ${ep.family}` : ""} · {ep.modelCount} model
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-dense">
          {ep.auth.type === "none" ? (
            <span className="text-fg-3">Tanpa key</span>
          ) : ep.hasKey ? (
            <span className="flex items-center gap-1.5">
              <KeyIcon size={16} aria-hidden />
              Key <code>••••{ep.keyLast4}</code>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-ember-text">
              <span className="node node-wait" aria-hidden />
              Key belum diisi
            </span>
          )}
        </div>
      </div>

      {status && !testing && (
        <p className={["flex items-start gap-2 rounded-sm px-3 py-2 text-dense", status.ok ? "bg-sunken text-fg-2" : "bg-danger-soft text-danger-text"].join(" ")} role={status.ok ? "status" : "alert"}>
          <span className={`node mt-1.5 ${status.ok ? "node-done" : "node-fail"}`} aria-hidden />
          <span>
            {status.message}
            {status.at && (
              <span className="block text-meta text-fg-3">
                {status.fresh ? "Baru saja dicek" : "Dicek"} {formatTime(status.at)}
              </span>
            )}
          </span>
        </p>
      )}
      {testing && (
        <p className="flex items-center gap-2 text-dense text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Menghubungi {ep.name}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary" onClick={onTest} disabled={testing}>
          Tes koneksi
        </button>
        {ep.auth.type !== "none" && (
          <button type="button" className="btn btn-secondary" onClick={() => setKeyOpen(true)} aria-haspopup="dialog">
            {ep.hasKey ? "Ganti key" : "Isi key"}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => setModelOpen(true)} aria-haspopup="dialog">
          Tambah model manual
        </button>
        <button type="button" className="btn btn-ghost" onClick={onEdit} aria-haspopup="dialog">
          Ubah
        </button>
        {ep.hasKey && (
          <button type="button" className="btn btn-ghost" onClick={() => clearKey.mutate()} disabled={clearKey.isPending}>
            Hapus key
          </button>
        )}
        <button type="button" className="btn btn-ghost ml-auto" onClick={() => setDeleteOpen(true)} aria-haspopup="dialog">
          Hapus endpoint
        </button>
      </div>

      <KeyDialog endpoint={ep} open={keyOpen} onClose={() => setKeyOpen(false)} />
      <ManualModelDialog endpoint={ep} open={modelOpen} onClose={() => setModelOpen(false)} />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Hapus ${ep.name}?`}
        width="max-w-md"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDeleteOpen(false)}>
              Batal
            </button>
            <button type="button" className="btn btn-danger" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? "Menghapus" : "Hapus endpoint"}
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">
          Endpoint, key-nya, dan {ep.modelCount} model di dalamnya dihapus. Thread yang memakai model ini tetap ada, tapi modelnya perlu dipilih ulang.
        </p>
        {remove.isError && (
          <p className="mt-3 rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {remove.error.message}
          </p>
        )}
      </Dialog>
    </li>
  );
}

function KeyDialog({ endpoint, open, onClose }: { endpoint: EndpointDto; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateRegistry();
  const formId = useId();
  const [key, setKey] = useState("");

  const save = useMutation({
    mutationFn: () => api(`/endpoints/${endpoint.id}/key`, { method: "PUT", body: JSON.stringify({ key }) }),
    onSuccess: () => {
      invalidate();
      setKey("");
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        setKey("");
        save.reset();
        onClose();
      }}
      title={`Key untuk ${endpoint.name}`}
      width="max-w-md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={save.isPending || key.trim() === ""}>
            Simpan key
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-3">
        <label htmlFor={`${formId}-key`} className="text-dense font-semibold">
          API key
        </label>
        <input id={`${formId}-key`} data-autofocus className="input font-code" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
        <p className="text-meta text-fg-3">Disimpan di penyimpanan kredensial komputer ini. Hanya 4 karakter terakhir yang ditampilkan setelah disimpan.</p>
        {save.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {save.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function ManualModelDialog({ endpoint, open, onClose }: { endpoint: EndpointDto; open: boolean; onClose: () => void }) {
  const invalidate = useInvalidateRegistry();
  const formId = useId();
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "image">("text");

  const add = useMutation({
    mutationFn: () => api(`/endpoints/${endpoint.id}/models`, { method: "POST", body: JSON.stringify({ modelId, kind, ...(name.trim() ? { name } : {}) }) }),
    onSuccess: () => {
      invalidate();
      setModelId("");
      setName("");
      setKind("text");
      onClose();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        add.reset();
        onClose();
      }}
      title={`Tambah model ke ${endpoint.name}`}
      width="max-w-md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={add.isPending || modelId.trim() === ""}>
            Tambah model
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-3">
        <div className="grid gap-1">
          <label htmlFor={`${formId}-id`} className="text-dense font-semibold">
            ID model
          </label>
          <input id={`${formId}-id`} data-autofocus className="input font-code" value={modelId} placeholder="contoh: deepseek-flash" onChange={(e) => setModelId(e.target.value)} />
          <p className="text-meta text-fg-3">Persis seperti yang diminta provider di field &quot;model&quot;.</p>
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${formId}-name`} className="text-dense font-semibold">
            Nama tampilan (opsional)
          </label>
          <input id={`${formId}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1">
          <label htmlFor={`${formId}-kind`} className="text-dense font-semibold">
            Jenis
          </label>
          <select id={`${formId}-kind`} className="select" value={kind} onChange={(e) => setKind(e.target.value as "text" | "image")}>
            <option value="text">Teks (chat dan agent)</option>
            <option value="image">Gambar (mode Image)</option>
          </select>
          <p className="text-meta text-fg-3">Model yang ditemukan otomatis sudah dikenali jenisnya. Untuk model manual, pilih sendiri.</p>
        </div>
        {add.isError && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {add.error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
}
