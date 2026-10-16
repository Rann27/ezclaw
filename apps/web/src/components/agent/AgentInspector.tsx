import type { ChatParams, ModelDto, ThreadDetailDto, ThreadHarness } from "@ezclaw/core";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api } from "../../api";
import { keys, useHarness, useModelProfile, useProcesses, useRecentWorkspaces, useThreadRules } from "../../lib/queries";
import { FolderPicker } from "./FolderPicker";
import { ModelChip } from "../ModelPicker";
import { ParamPanel } from "../ParamPanel";

interface Props {
  thread: ThreadDetailDto | undefined;
  /** For a thread that does not exist yet. */
  pendingHarness: ThreadHarness;
  onHarness: (h: ThreadHarness) => void;
  model: ModelDto | null;
  onPickModel: () => void;
  onShowProfile: () => void;
  systemPrompt: string;
  onSystemPrompt: (v: string) => void;
  params: ChatParams;
  onParams: (p: ChatParams) => void;
  running: boolean;
}

export function AgentInspector({ thread, pendingHarness, onHarness, model, onPickModel, onShowProfile, systemPrompt, onSystemPrompt, params, onParams, running }: Props) {
  const harness = thread?.harness ?? pendingHarness;
  const profiles = useHarness();
  const profile = useModelProfile(model?.id ?? null);
  const rules = useThreadRules(thread?.id);
  const qc = useQueryClient();
  const promptId = useId();
  const [text, setText] = useState(systemPrompt);
  useEffect(() => setText(systemPrompt), [systemPrompt]);

  const removeRule = useMutation({
    mutationFn: (ruleId: string) => api(`/threads/${thread!.id}/rules/${ruleId}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.rules(thread!.id) }),
  });

  const recent = useRecentWorkspaces();
  const processes = useProcesses(thread?.id);
  const runningProcs = processes.data?.processes.filter((p) => p.running) ?? [];
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const agentProfiles = profiles.data?.profiles.filter((p) => p.mode === "agent") ?? [];
  const selected = agentProfiles.find((p) => p.id === harness.profileId);

  return (
    <div className="grid gap-6 p-4">
      {thread?.workspace && (
        <section aria-labelledby="ai-ws" className="grid gap-1">
          <h2 id="ai-ws" className="text-dense font-semibold text-fg-2">
            Workspace
          </h2>
          <code className="break-all text-dense">{thread.workspace}</code>
          <button type="button" className="btn btn-secondary justify-self-start" disabled={running} title={running ? "Tidak bisa diganti saat agent bekerja." : undefined} onClick={() => setPickingFolder(true)}>
            Ganti folder
          </button>
          {folderError && (
            <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
              {folderError}
            </p>
          )}
          <FolderPicker
            open={pickingFolder}
            onClose={() => setPickingFolder(false)}
            initial={thread.workspace}
            recent={recent.data?.workspaces ?? []}
            onPick={async (p) => {
              setPickingFolder(false);
              setFolderError(null);
              try {
                await api(`/threads/${thread.id}`, { method: "PATCH", body: JSON.stringify({ workspace: p }) });
                await qc.invalidateQueries({ queryKey: keys.thread(thread.id) });
                void qc.invalidateQueries({ queryKey: keys.workspaces });
              } catch (err) {
                setFolderError(err instanceof Error ? err.message : "Folder tidak bisa diganti.");
              }
            }}
          />
        </section>
      )}

      {runningProcs.length > 0 && (
        <section aria-labelledby="ai-procs" className="grid gap-2">
          <h2 id="ai-procs" className="text-dense font-semibold text-fg-2">
            Proses latar ({runningProcs.length})
          </h2>
          <ul className="grid gap-1">
            {runningProcs.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-dense">
                <span className="node node-run" aria-hidden />
                <code className="min-w-0 flex-1 truncate" title={p.command}>
                  {p.command}
                </code>
                <button
                  type="button"
                  className="btn btn-ghost min-h-7 px-2 text-meta"
                  onClick={async () => {
                    await api(`/threads/${thread!.id}/processes/${p.id}/stop`, { method: "POST" }).catch(() => {});
                    void processes.refetch();
                  }}
                >
                  Hentikan
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="ai-model" className="grid gap-2">
        <h2 id="ai-model" className="text-dense font-semibold text-fg-2">
          Model
        </h2>
        <ModelChip model={model} onClick={onPickModel} disabled={running} />
        {model && (
          <button type="button" className="btn btn-secondary justify-self-start" onClick={onShowProfile}>
            Lihat profil model
          </button>
        )}
      </section>

      <section aria-labelledby="ai-harness" className="grid gap-3">
        <h2 id="ai-harness" className="text-dense font-semibold text-fg-2">
          Harness
        </h2>
        <button type="button" role="switch" aria-checked={harness.on} disabled={running} className="switch" onClick={() => onHarness({ ...harness, on: !harness.on })}>
          <span className="switch-track" aria-hidden />
          {harness.on ? "Harness ON" : "Harness OFF"}
        </button>
        {harness.on ? (
          <div className="grid gap-1">
            <label htmlFor="ai-profile" className="text-meta text-fg-3">
              Profil
            </label>
            <select id="ai-profile" className="select" value={harness.profileId} disabled={running} onChange={(e) => onHarness({ ...harness, profileId: e.target.value })}>
              {agentProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {selected && <p className="text-meta text-fg-3">{selected.description}</p>}
            {selected && (
              <p className="text-meta text-fg-3">
                Tools: <code>{selected.tools.join(", ") || "tidak ada"}</code>
              </p>
            )}
          </div>
        ) : (
          <fieldset className="grid gap-1.5 border-0 p-0">
            <legend className="mb-1 text-meta text-fg-3">Tanpa harness, tidak ada instruksi dari EZClaw. Pilih tools yang boleh dipakai:</legend>
            {(profiles.data?.tools ?? []).map((t) => (
              <label key={t.name} className="flex items-start gap-2 text-dense">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={harness.tools.includes(t.name)}
                  disabled={running}
                  onChange={(e) => onHarness({ ...harness, tools: e.target.checked ? [...harness.tools, t.name] : harness.tools.filter((x) => x !== t.name) })}
                />
                <span>
                  <code>{t.name}</code>
                  {t.readOnly && <span className="text-fg-3"> (hanya baca)</span>}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <Link to="/settings/harness" className="text-dense text-brand-text underline">
          Kelola profil harness
        </Link>
      </section>

      <section aria-labelledby="ai-system" className="grid gap-2">
        <h2 id="ai-system" className="text-dense font-semibold text-fg-2">
          Instruksi tambahan
        </h2>
        <label htmlFor={promptId} className="sr-only">
          Instruksi tambahan untuk thread ini
        </label>
        <textarea
          id={promptId}
          className="textarea min-h-24 text-dense"
          value={text}
          disabled={running}
          placeholder={harness.on ? "Ditambahkan setelah instruksi harness." : "Menjadi satu-satunya system prompt."}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== systemPrompt && onSystemPrompt(text)}
        />
      </section>

      {thread && (
        <section aria-labelledby="ai-rules" className="grid gap-2">
          <h2 id="ai-rules" className="text-dense font-semibold text-fg-2">
            Perintah yang selalu diizinkan
          </h2>
          {rules.data && rules.data.rules.length === 0 && <p className="text-dense text-fg-3">Belum ada. Muncul di sini setelah kamu memilih &quot;Selalu izinkan&quot; di sebuah permintaan.</p>}
          <ul className="grid gap-1.5">
            {rules.data?.rules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-xs bg-sunken py-1 pr-1 pl-2">
                <code className="min-w-0 truncate text-dense">{r.pattern.join(" ")}</code>
                <button type="button" className="btn btn-ghost min-h-7 px-2 text-meta" onClick={() => removeRule.mutate(r.id)} disabled={removeRule.isPending} aria-label={`Hapus aturan ${r.pattern.join(" ")}`}>
                  Hapus
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="ai-params" className="grid gap-3">
        <h2 id="ai-params" className="text-dense font-semibold text-fg-2">
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
