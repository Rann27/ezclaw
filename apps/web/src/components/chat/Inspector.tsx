import type { ChatParams, ModelDto, ThreadHarness } from "@ezclaw/core";
import { useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useHarness, useModelProfile } from "../../lib/queries";
import { ModelChip } from "../ModelPicker";
import { ParamPanel } from "../ParamPanel";

interface InspectorProps {
  model: ModelDto | null;
  onPickModel: () => void;
  onShowProfile: () => void;
  systemPrompt: string;
  onSystemPrompt: (v: string) => void;
  params: ChatParams;
  onParams: (p: ChatParams) => void;
  harness: ThreadHarness;
  onHarness: (h: ThreadHarness) => void;
  running: boolean;
}

export function Inspector({ model, onPickModel, onShowProfile, systemPrompt, onSystemPrompt, params, onParams, harness, onHarness, running }: InspectorProps) {
  const profile = useModelProfile(model?.id ?? null);
  const profiles = useHarness();
  const chatProfiles = profiles.data?.profiles.filter((p) => p.mode === "chat") ?? [];
  const selected = chatProfiles.find((p) => p.id === harness.profileId);
  const profileSelectId = useId();
  const promptId = useId();
  const [text, setText] = useState(systemPrompt);
  useEffect(() => setText(systemPrompt), [systemPrompt]);

  return (
    <div className="grid gap-6 p-4">
      <section aria-labelledby="insp-model" className="grid gap-2">
        <h2 id="insp-model" className="text-dense font-semibold text-fg-2">
          Model
        </h2>
        <ModelChip model={model} onClick={onPickModel} disabled={running} />
        {model && (
          <button type="button" className="btn btn-secondary justify-self-start" onClick={onShowProfile}>
            Lihat profil model
          </button>
        )}
      </section>

      <section aria-labelledby="insp-harness" className="grid gap-2">
        <h2 id="insp-harness" className="text-dense font-semibold text-fg-2">
          Harness
        </h2>
        <button type="button" role="switch" aria-checked={harness.on} disabled={running} className="switch" onClick={() => onHarness({ ...harness, on: !harness.on })}>
          <span className="switch-track" aria-hidden />
          {harness.on ? "Harness ON" : "Harness OFF"}
        </button>
        {harness.on ? (
          <div className="grid gap-1">
            <label htmlFor={profileSelectId} className="text-meta text-fg-3">
              Profil
            </label>
            <select id={profileSelectId} className="select" value={harness.profileId} disabled={running} onChange={(e) => onHarness({ ...harness, profileId: e.target.value })}>
              {chatProfiles.length === 0 && <option value={harness.profileId}>{harness.profileId}</option>}
              {chatProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {selected && <p className="text-meta text-fg-3">{selected.description}</p>}
          </div>
        ) : (
          <p className="text-meta text-fg-3">Model menerima pesanmu apa adanya, hanya dengan system prompt di bawah.</p>
        )}
        <Link to="/settings/harness" className="text-dense text-brand-text underline">
          Kelola profil harness
        </Link>
      </section>

      <section aria-labelledby="insp-system" className="grid gap-2">
        <h2 id="insp-system" className="text-dense font-semibold text-fg-2">
          System prompt
        </h2>
        <label htmlFor={promptId} className="sr-only">
          System prompt untuk thread ini
        </label>
        <textarea
          id={promptId}
          className="textarea min-h-24 text-dense"
          value={text}
          disabled={running}
          placeholder="Instruksi untuk model di thread ini. {{date}} dan {{os}} diisi otomatis."
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== systemPrompt && onSystemPrompt(text)}
        />
      </section>

      <section aria-labelledby="insp-params" className="grid gap-3">
        <h2 id="insp-params" className="text-dense font-semibold text-fg-2">
          Parameter
        </h2>
        {!model && <p className="text-dense text-fg-3">Pilih model untuk melihat parameter yang didukungnya.</p>}
        {model && profile.isPending && (
          <p className="flex items-center gap-2 text-dense text-fg-2" role="status">
            <span className="node node-run" aria-hidden />
            Memuat parameter model
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
        {model && profile.data && <ParamPanel profile={profile.data.profile} params={params} onChange={onParams} disabled={running} />}
      </section>
    </div>
  );
}
