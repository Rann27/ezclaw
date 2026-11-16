import { VIDEO_WIRE_LABELS, type ModelDto, type VideoParams } from "@ezclaw/core";
import { useId } from "react";
import { useModelProfile } from "../../lib/queries";
import { ModelChip } from "../ModelPicker";
import { durationOptions } from "./VideoComposer";

interface Props {
  model: ModelDto | null;
  onPickModel: () => void;
  onShowProfile: () => void;
  params: VideoParams;
  onParams: (p: VideoParams) => void;
  running: boolean;
}

/** Settings beside the video thread: the model and what it accepts, plus the less common parameters. */
export function VideoInspector({ model, onPickModel, onShowProfile, params, onParams, running }: Props) {
  const profile = useModelProfile(model?.id ?? null);
  const spec = profile.data?.videoSpec ?? null;
  const id = useId();
  const durations = durationOptions(spec);
  const set = (patch: Partial<VideoParams>) => onParams({ ...params, ...patch });

  const can = (on: boolean) => (on ? "ya" : "tidak");

  return (
    <div className="grid gap-6 p-4">
      <section aria-labelledby={`${id}-model`} className="grid gap-2">
        <h2 id={`${id}-model`} className="text-dense font-semibold text-fg-2">
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

      {spec && (
        <section aria-labelledby={`${id}-spec`} className="grid gap-2">
          <h2 id={`${id}-spec`} className="text-dense font-semibold text-fg-2">
            Kemampuan model
          </h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-dense">
            <dt className="text-fg-3">Jalur</dt>
            <dd>{VIDEO_WIRE_LABELS[spec.wire]}</dd>
            <dt className="text-fg-3">Dari teks</dt>
            <dd>{can(spec.textToVideo)}</dd>
            <dt className="text-fg-3">Frame awal</dt>
            <dd>{spec.startFrame ? "ya" : spec.pairedModelId ? `lewat ${spec.pairedModelId}` : "tidak"}</dd>
            <dt className="text-fg-3">Frame akhir</dt>
            <dd>{can(spec.endFrame)}</dd>
            <dt className="text-fg-3">Durasi</dt>
            <dd>{durations.length ? (spec.durations.length ? `${durations.join(", ")} detik` : `${spec.durationRange!.min} sampai ${spec.durationRange!.max} detik`) : "bawaan provider"}</dd>
            <dt className="text-fg-3">Suara</dt>
            <dd>{spec.audio === "optional" ? "bisa dipilih" : spec.audio === "always" ? "selalu" : "tidak"}</dd>
          </dl>
        </section>
      )}

      {spec && (spec.negativePrompt || spec.seed) && (
        <section aria-labelledby={`${id}-more`} className="grid gap-3">
          <h2 id={`${id}-more`} className="text-dense font-semibold text-fg-2">
            Parameter lain
          </h2>
          {spec.negativePrompt && (
            <div className="grid gap-1">
              <label htmlFor={`${id}-neg`} className="text-dense">
                Negative prompt
              </label>
              <textarea
                id={`${id}-neg`}
                className="textarea min-h-20 text-dense"
                value={params.negativePrompt ?? ""}
                disabled={running}
                placeholder="Hal yang tidak boleh muncul"
                onChange={(e) => set({ negativePrompt: e.target.value || undefined })}
              />
            </div>
          )}
          {spec.seed && (
            <div className="grid gap-1">
              <label htmlFor={`${id}-seed`} className="text-dense">
                Seed
              </label>
              <input
                id={`${id}-seed`}
                type="number"
                className="input"
                value={params.seed ?? ""}
                disabled={running}
                placeholder="Acak"
                onChange={(e) => set({ seed: e.target.value === "" ? undefined : Math.trunc(Number(e.target.value)) })}
              />
            </div>
          )}
        </section>
      )}

      <section aria-labelledby={`${id}-cost`} className="grid gap-1">
        <h2 id={`${id}-cost`} className="text-dense font-semibold text-fg-2">
          Biaya
        </h2>
        <p className="text-dense text-fg-3">Video dibayar per detik dan jauh lebih mahal dari gambar. Venice menampilkan perkiraan biaya sebelum job dikirim; OpenRouter dan xAI melaporkan biaya setelah selesai. Menekan Stop tidak membatalkan job yang sudah diterima provider.</p>
      </section>
    </div>
  );
}
