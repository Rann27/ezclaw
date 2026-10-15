import type { ModelPatch, ProfileLayer, ModelProfileResponse } from "@ezclaw/core";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { modelLabel, useInvalidateRegistry, useModelProfile } from "../lib/queries";
import { Dialog } from "./Dialog";

const LAYER_LABEL: Record<ProfileLayer, string> = {
  protocol: "Bawaan protokol",
  discovery: "Dari provider",
  preset: "Preset EZClaw",
  override: "Override kamu",
  learned: "Dipelajari",
};

const LAYER_ORDER: ProfileLayer[] = ["protocol", "discovery", "preset", "override"];

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "tidak diketahui";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "kosong";
  if (typeof value === "boolean") return value ? "ya" : "tidak";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function rows(data: ModelProfileResponse): { label: string; value: string; layer: ProfileLayer }[] {
  const { profile: p, provenance } = data;
  const layer = (k: string): ProfileLayer => provenance[k] ?? "protocol";
  const out: { label: string; value: string; layer: ProfileLayer }[] = [
    { label: "Konteks", value: fmt(p.contextLength), layer: layer("contextLength") },
    { label: "Maks keluaran", value: fmt(p.maxOutputTokens), layer: layer("maxOutputTokens") },
    { label: "Input", value: fmt(p.inputModalities), layer: layer("inputModalities") },
    { label: "Output", value: fmt(p.outputModalities), layer: layer("outputModalities") },
    { label: "Tools", value: fmt(p.tools), layer: layer("tools") },
    { label: "Field maks token", value: p.maxTokensField, layer: layer("maxTokensField") },
    { label: "Role system", value: p.systemRole, layer: layer("systemRole") },
    { label: "stop / seed", value: `${fmt(p.stop)} / ${fmt(p.seed)}`, layer: layer("stop") },
    { label: "Reasoning: gaya", value: p.reasoning.style, layer: layer("reasoning.style") },
    { label: "Reasoning: bisa dimatikan", value: fmt(p.reasoning.canDisable), layer: layer("reasoning.canDisable") },
    { label: "Reasoning: aktif bawaan", value: fmt(p.reasoning.defaultOn), layer: layer("reasoning.defaultOn") },
    { label: "Reasoning: effort", value: fmt(p.reasoning.efforts), layer: layer("reasoning.efforts") },
    { label: "Dikunci saat reasoning", value: fmt(p.reasoning.lockedWhileActive), layer: layer("reasoning.lockedWhileActive") },
    { label: "Riwayat reasoning", value: p.reasoningReplay, layer: layer("reasoningReplay") },
  ];
  for (const [param, spec] of Object.entries(p.sampling)) {
    out.push({ label: param, value: `${spec.min} sampai ${spec.max}${spec.default !== undefined ? `, bawaan ${spec.default}` : ""}`, layer: layer(`sampling.${param}`) });
  }
  if (p.extras.length) out.push({ label: "Opsi provider", value: p.extras.map((e) => e.label).join(", "), layer: layer("extras") });
  if (Object.keys(p.bodyDefaults).length) out.push({ label: "Selalu dikirim", value: JSON.stringify(p.bodyDefaults), layer: layer("bodyDefaults") });
  return out;
}

export function ProfileDialog({ modelId, onClose }: { modelId: string | null; onClose: () => void }) {
  const { data, isPending, isError, error, refetch } = useModelProfile(modelId);
  const invalidate = useInvalidateRegistry();
  const overrideId = useId();
  const [overrideText, setOverrideText] = useState("");
  const [overrideError, setOverrideError] = useState<string | null>(null);

  useEffect(() => {
    setOverrideText(data?.override ? JSON.stringify(data.override, null, 2) : "");
    setOverrideError(null);
  }, [data?.override, modelId]);

  const patch = useMutation({
    mutationFn: (body: ModelPatch) => api(`/models/${modelId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      invalidate();
      setOverrideError(null);
    },
    onError: (err: Error) => setOverrideError(err.message),
  });

  function saveOverride() {
    if (overrideText.trim() === "") return patch.mutate({ override: null });
    try {
      const parsed: unknown = JSON.parse(overrideText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Override harus berupa objek JSON.");
      patch.mutate({ override: parsed as NonNullable<ModelPatch["override"]> });
    } catch (err) {
      setOverrideError(err instanceof SyntaxError ? `JSON tidak valid: ${err.message}` : err instanceof Error ? err.message : "JSON tidak valid.");
    }
  }

  return (
    <Dialog open={modelId !== null} onClose={onClose} title={data ? `Profil: ${modelLabel(data.model)}` : "Profil model"} width="max-w-3xl">
      {isPending && modelId && (
        <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
          <span className="node node-run" aria-hidden />
          Memuat profil
        </p>
      )}
      {isError && (
        <div className="grid gap-2 rounded-sm bg-danger-soft p-3 text-ui text-danger-text" role="alert">
          <p>{error.message}</p>
          <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void refetch()}>
            Coba lagi
          </button>
        </div>
      )}
      {data && (
        <div className="grid gap-6">
          <p className="text-dense text-fg-2">
            Profil dihitung dari lapisan berurutan: {LAYER_ORDER.map((l) => LAYER_LABEL[l]).join(", lalu ")}. Lapisan belakangan menang. Kolom kanan menunjukkan lapisan yang menentukan tiap nilai.
          </p>

          <table className="w-full border-collapse text-dense">
            <caption className="sr-only">Profil kemampuan efektif</caption>
            <thead>
              <tr className="text-left text-meta text-fg-3">
                <th scope="col" className="border-b border-line py-1 pr-3 font-semibold">
                  Field
                </th>
                <th scope="col" className="border-b border-line py-1 pr-3 font-semibold">
                  Nilai
                </th>
                <th scope="col" className="border-b border-line py-1 font-semibold">
                  Sumber
                </th>
              </tr>
            </thead>
            <tbody>
              {rows(data).map((r) => (
                <tr key={r.label}>
                  <th scope="row" className="border-b border-line py-1.5 pr-3 text-left font-normal text-fg-2">
                    {r.label}
                  </th>
                  <td className="border-b border-line py-1.5 pr-3 font-code break-words">{r.value}</td>
                  <td className="border-b border-line py-1.5 whitespace-nowrap">{LAYER_LABEL[r.layer]}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.profile.notes.length > 0 && (
            <section aria-labelledby="pf-notes" className="grid gap-2">
              <h3 id="pf-notes" className="text-ui font-semibold">
                Catatan
              </h3>
              <ul className="grid list-disc gap-1.5 pl-5 text-dense text-fg-2">
                {data.profile.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}

          {data.presetSources.length > 0 && (
            <section aria-labelledby="pf-src" className="grid gap-1">
              <h3 id="pf-src" className="text-ui font-semibold">
                Sumber preset
              </h3>
              <ul className="grid gap-1 text-dense text-fg-2">
                {data.presetSources.map((s) => (
                  <li key={s.source} className="break-all">
                    {s.source} <span className="text-fg-3">(dicek {s.checked})</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="pf-learned" className="grid gap-2">
            <h3 id="pf-learned" className="text-ui font-semibold">
              Field yang pernah ditolak model ini
            </h3>
            {data.omit.length === 0 ? (
              <p className="text-dense text-fg-3">Belum ada. Jika provider menolak sebuah parameter, EZClaw mencatatnya di sini dan berhenti mengirimnya.</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {data.omit.map((key) => (
                  <li key={key} className="flex items-center gap-1 rounded-xs bg-sunken py-0.5 pr-1 pl-2">
                    <code className="text-dense">{key}</code>
                    <button
                      type="button"
                      className="btn btn-ghost min-h-6 px-1.5 text-meta"
                      onClick={() => patch.mutate({ omit: data.omit.filter((k) => k !== key) })}
                      disabled={patch.isPending}
                      aria-label={`Kirim ${key} lagi`}
                    >
                      Kirim lagi
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="pf-override" className="grid gap-2">
            <h3 id="pf-override" className="text-ui font-semibold">
              Override profil (JSON)
            </h3>
            <label htmlFor={overrideId} className="text-dense text-fg-2">
              Ubah nilai profil untuk model ini saja. Contoh: <code>{'{ "contextLength": 64000, "sampling": { "top_k": null } }'}</code>. <code>null</code> menghapus sebuah kontrol sampling.
            </label>
            <textarea id={overrideId} spellCheck={false} className="textarea min-h-28 font-code text-dense" value={overrideText} onChange={(e) => setOverrideText(e.target.value)} aria-invalid={overrideError ? true : undefined} />
            {overrideError && (
              <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
                {overrideError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary" onClick={saveOverride} disabled={patch.isPending}>
                Simpan override
              </button>
              {data.override && (
                <button type="button" className="btn btn-secondary" onClick={() => patch.mutate({ override: null })} disabled={patch.isPending}>
                  Hapus override
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}
