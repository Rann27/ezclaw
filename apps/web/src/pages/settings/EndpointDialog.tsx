import { PROTOCOLS, PROTOCOL_LABELS, type CatalogPresetDto, type EndpointDto, type EndpointInput } from "@ezclaw/core";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Dialog } from "../../components/Dialog";
import { useCatalog, useInvalidateRegistry } from "../../lib/queries";

const CUSTOM = "custom";

function parseHeaders(text: string): { headers: Record<string, string>; error: string | null } {
  const headers: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at <= 0) return { headers, error: `Baris ${i + 1}: gunakan format "Nama: nilai".` };
    const name = line.slice(0, at).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name)) return { headers, error: `Baris ${i + 1}: nama header "${name}" tidak valid.` };
    headers[name] = line.slice(at + 1).trim();
  }
  return { headers, error: null };
}

function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this endpoint instead of creating one. */
  editing: EndpointDto | null;
  /** Called with the new endpoint so the caller can test the connection right away. */
  onCreated: (endpoint: EndpointDto) => void;
}

export function EndpointDialog({ open, onClose, editing, onCreated }: Props) {
  const catalog = useCatalog();
  const invalidate = useInvalidateRegistry();
  const formId = useId();

  const [presetId, setPresetId] = useState<string>(CUSTOM);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<EndpointInput["protocol"]>("openai-chat");
  const [baseUrl, setBaseUrl] = useState("");
  const [authType, setAuthType] = useState<"bearer" | "header" | "none">("bearer");
  const [headerName, setHeaderName] = useState("");
  const [family, setFamily] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  const presets = catalog.data?.presets ?? [];
  const preset: CatalogPresetDto | undefined = presets.find((p) => p.id === presetId);
  const isCustom = presetId === CUSTOM;

  function applyPreset(p: CatalogPresetDto | undefined, id: string) {
    setPresetId(id);
    if (p) {
      setName(p.name);
      setProtocol(p.protocol);
      setBaseUrl(p.baseUrl);
      setAuthType(p.auth.type);
      setHeaderName(p.auth.headerName ?? "");
    } else {
      setName("");
      setProtocol("openai-chat");
      setBaseUrl("");
      setAuthType("bearer");
      setHeaderName("");
    }
    setFamily("");
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setApiKey("");
    if (editing) {
      setPresetId(editing.presetId);
      setName(editing.name);
      setProtocol(editing.protocol);
      setBaseUrl(editing.baseUrl);
      setAuthType(editing.auth.type);
      setHeaderName(editing.auth.headerName ?? "");
      setFamily(editing.family ?? "");
      setHeadersText(headersToText(editing.extraHeaders));
    } else {
      applyPreset(undefined, CUSTOM);
      setHeadersText("");
    }
    // Reset only when the dialog opens for a (different) endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id]);

  const save = useMutation({
    mutationFn: async () => {
      const { headers, error: headerError } = parseHeaders(headersText);
      if (headerError) throw new Error(headerError);
      const auth = authType === "header" ? { type: authType, headerName: headerName.trim() } : { type: authType };
      if (editing) {
        return api<EndpointDto>(`/endpoints/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, baseUrl, auth, extraHeaders: headers, ...(editing.presetId === CUSTOM ? { family: family || null } : {}) }),
        });
      }
      const body: EndpointInput = { name, presetId, protocol, baseUrl, auth, extraHeaders: headers, ...(isCustom && family ? { family } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      return api<EndpointDto>("/endpoints", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (endpoint) => {
      invalidate();
      onClose();
      if (!editing) onCreated(endpoint);
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate();
  }

  const families = catalog.data?.families ?? [];
  const regionValue = useMemo(() => preset?.regions.find((r) => r.baseUrl === baseUrl)?.id ?? "", [preset, baseUrl]);
  const allowedProtocols = isCustom ? PROTOCOLS : (preset?.protocols ?? [protocol]);
  const lockProtocol = !!editing || allowedProtocols.length <= 1;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Ubah ${editing.name}` : "Tambah endpoint"}
      width="max-w-xl"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Batal
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={save.isPending || (!editing && catalog.isPending)}>
            {save.isPending ? "Menyimpan" : editing ? "Simpan perubahan" : "Tambah endpoint"}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-4" noValidate>
        {!editing && (
          <div className="grid gap-1">
            <label htmlFor={`${formId}-preset`} className="text-dense font-semibold">
              Penyedia
            </label>
            <select id={`${formId}-preset`} className="select" value={presetId} onChange={(e) => applyPreset(presets.find((p) => p.id === e.target.value), e.target.value)}>
              <optgroup label="Provider langsung">
                {presets.filter((p) => p.kind === "provider").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Gateway">
                {presets.filter((p) => p.kind === "gateway").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Lokal">
                {presets.filter((p) => p.kind === "local").map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Lainnya">
                <option value={CUSTOM}>Custom (endpoint kompatibel)</option>
              </optgroup>
            </select>
            {catalog.isError && (
              <p className="text-dense text-danger-text" role="alert">
                {catalog.error.message}
              </p>
            )}
          </div>
        )}

        {preset && preset.notes.length > 0 && (
          <ul className="grid gap-1 rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2">
            {preset.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}

        <div className="grid gap-1">
          <label htmlFor={`${formId}-name`} className="text-dense font-semibold">
            Nama
          </label>
          <input id={`${formId}-name`} className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>

        {preset && preset.regions.length > 1 && (
          <div className="grid gap-1">
            <label htmlFor={`${formId}-region`} className="text-dense font-semibold">
              Region
            </label>
            <select
              id={`${formId}-region`}
              className="select"
              value={regionValue}
              onChange={(e) => {
                const r = preset.regions.find((x) => x.id === e.target.value);
                if (r) setBaseUrl(r.baseUrl);
              }}
            >
              <option value="" disabled>
                Base URL kustom
              </option>
              {preset.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="grid gap-1">
          <label htmlFor={`${formId}-url`} className="text-dense font-semibold">
            Base URL
          </label>
          <input id={`${formId}-url`} className="input font-code" value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <label htmlFor={`${formId}-proto`} className="text-dense font-semibold">
              Protokol
            </label>
            <select id={`${formId}-proto`} className="select" value={protocol} disabled={lockProtocol} onChange={(e) => setProtocol(e.target.value as EndpointInput["protocol"])}>
              {allowedProtocols.map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${formId}-auth`} className="text-dense font-semibold">
              Autentikasi
            </label>
            <select id={`${formId}-auth`} className="select" value={authType} onChange={(e) => setAuthType(e.target.value as typeof authType)}>
              <option value="bearer">Authorization: Bearer</option>
              <option value="header">Header kustom</option>
              <option value="none">Tanpa auth</option>
            </select>
          </div>
        </div>

        {authType === "header" && (
          <div className="grid gap-1">
            <label htmlFor={`${formId}-hn`} className="text-dense font-semibold">
              Nama header key
            </label>
            <input id={`${formId}-hn`} className="input font-code" value={headerName} placeholder="x-api-key" onChange={(e) => setHeaderName(e.target.value)} />
          </div>
        )}

        {isCustom && (
          <div className="grid gap-1">
            <label htmlFor={`${formId}-family`} className="text-dense font-semibold">
              Perlakukan parameter seperti
            </label>
            <select id={`${formId}-family`} className="select" value={family} onChange={(e) => setFamily(e.target.value)}>
              <option value="">Standar (tanpa aturan khusus)</option>
              {families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <p className="text-meta text-fg-3">Pilih jika endpoint ini meneruskan ke provider tertentu, supaya reasoning dan parameter dipetakan dengan benar.</p>
          </div>
        )}

        {!editing && authType !== "none" && (
          <div className="grid gap-1">
            <label htmlFor={`${formId}-key`} className="text-dense font-semibold">
              API key
            </label>
            <input id={`${formId}-key`} className="input font-code" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <p className="text-meta text-fg-3">Disimpan di penyimpanan kredensial komputer ini, bukan di database. Boleh dikosongkan dan diisi nanti.</p>
          </div>
        )}

        <details open={headersText.length > 0}>
          <summary className="cursor-pointer text-dense font-semibold">Header tambahan</summary>
          <label htmlFor={`${formId}-headers`} className="sr-only">
            Header tambahan
          </label>
          <textarea id={`${formId}-headers`} className="textarea mt-2 min-h-16 font-code text-dense" value={headersText} placeholder="Satu per baris, contoh: HTTP-Referer: https://contoh.id" onChange={(e) => setHeadersText(e.target.value)} spellCheck={false} />
        </details>

        {error && (
          <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
