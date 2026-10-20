import { IMAGE_WIRES, IMAGE_WIRE_LABELS, type ImageParams, type ImageSpec, type ImageWire, type ModelDto, type ProfilePatch } from "@ezclaw/core";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { api } from "../../api";
import { modelLabel, useInvalidateRegistry, useModelProfile, useModels, useSettings } from "../../lib/queries";
import { rememberSafeMode } from "../../lib/imageDefaults";
import { ModelChip } from "../ModelPicker";

interface Props {
  /** Edit hides what only matters when generating, and makes tidying the prompt opt-in. */
  mode?: "image" | "edit";
  model: ModelDto | null;
  onPickModel: () => void;
  onShowProfile: () => void;
  params: ImageParams;
  onParams: (p: ImageParams) => void;
  running: boolean;
}

export function ImageInspector({ mode = "image", model, onPickModel, onShowProfile, params, onParams, running }: Props) {
  const profile = useModelProfile(model?.id ?? null);
  const settings = useSettings();
  const models = useModels();
  const spec = profile.data?.imageSpec ?? null;
  const composerId = settings.data?.defaultModels.composer ?? settings.data?.defaultModels.chat ?? null;
  const composerModel = models.data?.models.find((m) => m.id === composerId) ?? null;
  const editing = mode === "edit";
  const composerOn = editing ? params.composer === true : params.composer !== false;
  const set = (patch: Partial<ImageParams>) => onParams({ ...params, ...patch });

  return (
    <div className="grid gap-6 p-4">
      <section aria-labelledby="img-model" className="grid gap-2">
        <h2 id="img-model" className="text-dense font-semibold text-fg-2">
          Model
        </h2>
        <ModelChip model={model} onClick={onPickModel} disabled={running} />
        {model && (
          <button type="button" className="btn btn-secondary justify-self-start" onClick={onShowProfile}>
            Lihat profil model
          </button>
        )}
        {model && profile.isPending && (
          <p className="flex items-center gap-2 text-dense text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Memuat kemampuan model
          </p>
        )}
        {model && profile.isError && (
          <div className="grid gap-2 rounded-sm bg-danger-soft p-3 text-dense text-danger-text" role="alert">
            <p>{profile.error.message}</p>
            <button type="button" className="btn btn-secondary justify-self-start" onClick={() => void profile.refetch()}>
              Coba lagi
            </button>
          </div>
        )}
      </section>

      {model && spec && profile.data && (
        <>
          <WireSection modelId={model.id} spec={spec} override={profile.data.override} disabled={running} />

          <section aria-labelledby="img-composer" className="grid gap-2">
            <h2 id="img-composer" className="text-dense font-semibold text-fg-2">
              Prompt Composer
            </h2>
            {editing ? (
              <>
                <button type="button" role="switch" aria-checked={composerOn} disabled={running} className="switch" onClick={() => set({ composer: composerOn ? undefined : true })}>
                  <span className="switch-track" aria-hidden />
                  {composerOn ? "Rapikan prompt: ON" : "Rapikan prompt: OFF"}
                </button>
                <p className="text-dense text-fg-3">
                  {composerOn
                    ? composerModel
                      ? `Prompt hasil template dirapikan oleh ${modelLabel(composerModel)} sebelum dikirim. Hasilnya tampil di detail versi.`
                      : "Belum ada model teks untuk peran Composer atau Chat, jadi prompt dikirim sesuai template."
                    : "Prompt dikirim sesuai template: urutan gambar, peran referensi, instruksi, dan hal yang dipertahankan."}
                </p>
                {composerOn && !composerModel && (
                  <Link to="/settings" className="text-dense text-brand-text underline">
                    Pilih model Composer di Settings
                  </Link>
                )}
              </>
            ) : spec.conversational ? (
              <p className="text-dense text-fg-3">Model ini melihat percakapan, jadi pesan lanjutan dikirim langsung tanpa Composer.</p>
            ) : (
              <>
                <button type="button" role="switch" aria-checked={composerOn} disabled={running} className="switch" onClick={() => set({ composer: !composerOn })}>
                  <span className="switch-track" aria-hidden />
                  {composerOn ? "Composer ON" : "Composer OFF"}
                </button>
                <p className="text-dense text-fg-3">
                  {composerOn
                    ? composerModel
                      ? `Pesan lanjutan ditulis ulang jadi satu prompt utuh oleh ${modelLabel(composerModel)}. Hasilnya selalu tampil di atas gambar.`
                      : "Belum ada model teks untuk peran Composer atau Chat, jadi prompt dikirim apa adanya."
                    : "Prompt dikirim persis seperti yang kamu ketik."}
                </p>
                {composerOn && !composerModel && (
                  <Link to="/settings" className="text-dense text-brand-text underline">
                    Pilih model Composer di Settings
                  </Link>
                )}
              </>
            )}
          </section>

          <section aria-labelledby="img-params" className="grid gap-3">
            <h2 id="img-params" className="text-dense font-semibold text-fg-2">
              Parameter
            </h2>
            {spec.wire === "venice-image" && (
              <>
                <button
                  type="button"
                  role="switch"
                  aria-checked={params.safeMode === true}
                  disabled={running}
                  className="switch"
                  onClick={() => {
                    const on = params.safeMode !== true;
                    rememberSafeMode(on);
                    set({ safeMode: on ? true : undefined });
                  }}
                >
                  <span className="switch-track" aria-hidden />
                  {params.safeMode === true ? "Safe mode Venice: ON" : "Safe mode Venice: OFF"}
                </button>
                <p className="text-dense text-fg-3">
                  {params.safeMode === true
                    ? "Venice memburamkan gambar yang dinilainya konten dewasa. Gambar yang diburamkan tetap ditagih."
                    : "Dikirim safe_mode: false, jadi hasil tidak diburamkan. Gambar yang melanggar ketentuan Venice tetap bisa ditolak."}
                </p>
              </>
            )}
            {editing && (
              <>
                <button
                  type="button"
                  role="switch"
                  aria-checked={params.matchTarget !== false}
                  disabled={running}
                  className="switch"
                  onClick={() => set({ matchTarget: params.matchTarget === false ? undefined : false })}
                >
                  <span className="switch-track" aria-hidden />
                  {params.matchTarget !== false ? "Ukuran sama dengan target: ON" : "Ukuran sama dengan target: OFF"}
                </button>
                <p className="text-dense text-fg-3">
                  {params.matchTarget !== false
                    ? "Hasil diubah ke ukuran piksel gambar yang diedit. Aspect ratio dan resolusi yang kosong dipilih otomatis dari gambar itu."
                    : "Hasil disimpan dalam ukuran dari provider."}
                </p>
              </>
            )}
            <SelectField label="Ukuran" value={params.size} options={spec.sizes} disabled={running} onChange={(v) => set({ size: v })} />
            <SelectField label="Aspect ratio" value={params.aspectRatio} options={spec.aspectRatios} disabled={running} onChange={(v) => set({ aspectRatio: v })} />
            <SelectField label="Resolusi" value={params.resolution} options={spec.resolutions} disabled={running} onChange={(v) => set({ resolution: v })} />
            <SelectField label="Kualitas" value={params.quality} options={spec.qualities} disabled={running} onChange={(v) => set({ quality: v })} />
            <SelectField label="Format" value={params.format} options={spec.formats} disabled={running} onChange={(v) => set({ format: v })} />
            {spec.negativePrompt && (
              <TextField label="Negative prompt" value={params.negativePrompt ?? ""} disabled={running} onChange={(v) => set({ negativePrompt: v || undefined })} />
            )}
            {spec.seed && <NumberField label="Seed" value={params.seed} step={1} disabled={running} hint="Kosong berarti acak." onChange={(v) => set({ seed: v })} />}
            {spec.steps && <NumberField label="Steps" value={params.steps} min={spec.steps.min} max={spec.steps.max} step={spec.steps.step} disabled={running} onChange={(v) => set({ steps: v })} />}
            {spec.guidance && <NumberField label="Guidance (cfg)" value={params.guidance} min={spec.guidance.min} max={spec.guidance.max} step={spec.guidance.step} disabled={running} onChange={(v) => set({ guidance: v })} />}
            {!spec.sizes.length && !spec.aspectRatios.length && !spec.resolutions.length && !spec.qualities.length && !spec.formats.length && !spec.seed && !spec.steps && !spec.guidance && !spec.negativePrompt && (
              <p className="text-dense text-fg-3">Model ini tidak punya parameter yang bisa diatur selain prompt.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function WireSection({ modelId, spec, override, disabled }: { modelId: string; spec: ImageSpec; override: ProfilePatch | null; disabled: boolean }) {
  const id = useId();
  const invalidate = useInvalidateRegistry();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (wire: ImageWire | "") => {
      const image = { ...(override?.image ?? {}) };
      if (wire) image.wire = wire;
      else delete image.wire;
      const next: ProfilePatch = { ...(override ?? {}) };
      if (Object.keys(image).length) next.image = image;
      else delete next.image;
      return api(`/models/${modelId}`, { method: "PATCH", body: JSON.stringify({ override: Object.keys(next).length ? next : null }) });
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });
  const pinned = override?.image?.wire ?? "";

  return (
    <section aria-labelledby={`${id}-h`} className="grid gap-2">
      <h2 id={`${id}-h`} className="text-dense font-semibold text-fg-2">
        Jalur ke provider
      </h2>
      <label htmlFor={id} className="sr-only">
        Jalur ke provider
      </label>
      <select id={id} className="select" value={pinned} disabled={disabled || save.isPending} onChange={(e) => save.mutate(e.target.value as ImageWire | "")}>
        <option value="">Otomatis: {IMAGE_WIRE_LABELS[spec.wire]}</option>
        {IMAGE_WIRES.map((w) => (
          <option key={w} value={w}>
            {IMAGE_WIRE_LABELS[w]}
          </option>
        ))}
      </select>
      <p className="text-meta text-fg-3">
        Maksimal {spec.maxN} gambar per permintaan, {spec.maxInputImages === 0 ? "tanpa gambar referensi" : `sampai ${spec.maxInputImages} gambar referensi`}. Ganti jalur kalau providermu memakai bentuk API lain untuk model ini.
      </p>
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function SelectField({ label, value, options, disabled, onChange }: { label: string; value: string | undefined; options: string[]; disabled: boolean; onChange: (v: string | undefined) => void }) {
  const id = useId();
  if (options.length === 0) return null;
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-meta text-fg-3">
        {label}
      </label>
      <select id={id} className="select" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Bawaan model</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextField({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const id = useId();
  const [text, setText] = useState(value);
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-meta text-fg-3">
        {label}
      </label>
      <textarea id={id} className="textarea min-h-16 text-dense" value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onChange(text)} />
    </div>
  );
}

function NumberField({ label, value, min, max, step, disabled, hint, onChange }: { label: string; value: number | undefined; min?: number; max?: number; step: number; disabled: boolean; hint?: string; onChange: (v: number | undefined) => void }) {
  const id = useId();
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-meta text-fg-3">
        {label}
      </label>
      <input
        id={id}
        type="number"
        className="input"
        value={value ?? ""}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder="Bawaan"
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      />
      {hint && <p className="text-meta text-fg-3">{hint}</p>}
    </div>
  );
}
