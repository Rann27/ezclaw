import { IMAGE_ROLE_LABELS, IMAGE_WIRE_LABELS, KEEP_LABELS, buildVersions, compileEditPrompt, type ImageParams, type ImageReference, type KeepId, type ModelDto, type SendMessageResponse, type ThreadDetailDto } from "@ezclaw/core";
import { ArrowsLeftRightIcon, CodeIcon, DownloadSimpleIcon, ImageIcon, SwapIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { ModelPickerDialog } from "../components/ModelPicker";
import { ProfileDialog } from "../components/ProfileDialog";
import { ThreadHeader } from "../components/ThreadHeader";
import { RequestLogDialog } from "../components/chat/RequestLogDialog";
import { CompareDialog } from "../components/edit/CompareDialog";
import { EditComposer, type EditRef } from "../components/edit/EditComposer";
import { LineageStrip } from "../components/edit/LineageStrip";
import { AssetImage } from "../components/image/AssetImage";
import { ImageInspector } from "../components/image/ImageInspector";
import { useImageRun } from "../components/image/useImageRun";
import { downloadAsset, uploadAsset, ACCEPTED_IMAGE_TYPES } from "../lib/assets";
import { keys, useEndpoints, useModelProfile, useModels, useSettings, useThread } from "../lib/queries";
import { useWide } from "../lib/useWide";

const LAST_MODEL_KEY = "ezclaw.lastEditModel";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

interface EditRequest {
  text: string;
  exact: boolean;
  target: string;
  references: ImageReference[];
  keep: KeepId[];
  params: ImageParams;
}

export function EditPage() {
  const search = useSearch({ strict: false }) as { t?: string; target?: string };
  const threadId = search.t;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wide = useWide();

  const thread = useThread(threadId);
  const models = useModels();
  const endpoints = useEndpoints();
  const settings = useSettings();
  const { live: liveRaw, attach, stop } = useImageRun(threadId, thread.data?.activeRun);
  const live = liveRaw && liveRaw.threadId === threadId ? liveRaw : null;

  const [modelId, setModelId] = useState<string | null>(null);
  const [params, setParams] = useState<ImageParams>({});
  const userEdited = useRef(false);
  const [target, setTarget] = useState<string | null>(search.target ?? null);
  const [text, setText] = useState("");
  const [references, setReferences] = useState<EditRef[]>([]);
  const [keep, setKeep] = useState<KeepId[]>([]);
  const [manual, setManual] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ a: string; b: string } | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [focusSignal, setFocusSignal] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const targetInput = useRef<HTMLInputElement>(null);
  const lastSeenResult = useRef<string | null>(null);

  const messages = thread.data?.messages ?? [];
  const versions = useMemo(() => buildVersions(messages), [messages]);

  /* ----------------------------------------------------- draft initialisation */
  const loadedThread = thread.data?.id;
  useEffect(() => {
    userEdited.current = false;
    lastSeenResult.current = null;
    setSendError(null);
    setManual(null);
    if (thread.data) {
      setModelId(thread.data.modelId);
      setParams(thread.data.imageParams);
    } else if (!threadId) {
      setModelId(null);
      setParams({});
      setTarget(search.target ?? null);
      setReferences([]);
      setKeep([]);
      setText("");
    }
    // Re-run only when the thread being shown changes, not on every refetch of the same thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThread, threadId]);

  // The newest result becomes the image to edit next, on load and whenever an edit finishes.
  const latestResult = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.image?.target) {
        const first = m.parts.find((p) => p.type === "image");
        if (first && first.type === "image") return first.assetId;
      }
    }
    return null;
  }, [messages]);
  useEffect(() => {
    if (latestResult && latestResult !== lastSeenResult.current) {
      lastSeenResult.current = latestResult;
      setTarget(latestResult);
    }
  }, [latestResult]);

  const modelList = models.data?.models;
  const imageModels = useMemo(() => (modelList ?? []).filter((m) => m.kind === "image"), [modelList]);
  const chosen: ModelDto | null = useMemo(() => {
    const byId = (id: string | null | undefined) => imageModels.find((m) => m.id === id) ?? null;
    return byId(modelId) ?? (userEdited.current ? null : (byId(settings.data?.defaultModels.edit) ?? byId(settings.data?.defaultModels.image) ?? byId(stored(LAST_MODEL_KEY))));
  }, [imageModels, modelId, settings.data?.defaultModels.edit, settings.data?.defaultModels.image]);

  const profile = useModelProfile(chosen?.id ?? null);
  const spec = profile.data?.imageSpec ?? null;
  const maxRefs = spec ? Math.max(0, spec.maxInputImages - 1) : 0;

  const touch = useCallback(() => {
    userEdited.current = true;
  }, []);

  /* ------------------------------------------------------------------ images */
  const addImages = useCallback(
    async (files: File[], asTarget: boolean): Promise<string | null> => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return files.length ? "File yang dipilih bukan gambar." : null;
      setUploading((n) => n + images.length);
      let error: string | null = null;
      const uploaded: string[] = [];
      for (const f of images) {
        try {
          uploaded.push((await uploadAsset(f)).id);
        } catch (err) {
          error = err instanceof Error ? err.message : "Gambar tidak bisa diunggah.";
        } finally {
          setUploading((n) => n - 1);
        }
      }
      let rest = uploaded;
      if ((asTarget || !target) && uploaded[0]) {
        setTarget(uploaded[0]);
        rest = uploaded.slice(1);
        setStageError(null);
      }
      if (rest.length > 0) {
        if (!spec || maxRefs === 0) error ??= "Model ini tidak menerima gambar referensi, jadi gambar tambahan tidak dipakai.";
        else setReferences((r) => [...r, ...rest.filter((id) => !r.some((x) => x.assetId === id)).map((assetId) => ({ assetId }))]);
      }
      return error;
    },
    [maxRefs, spec, target],
  );

  /* ------------------------------------------------------------------ sending */
  const running = !!live || !!thread.data?.activeRun;

  const run = useCallback(
    async (req: EditRequest) => {
      setSendError(null);
      const mid = chosen?.id;
      if (!mid) throw new Error("Pilih model gambar dulu.");
      try {
        let id = threadId;
        if (!id) {
          const created = await api<ThreadDetailDto>("/threads", { method: "POST", body: JSON.stringify({ mode: "edit", modelId: mid }) });
          id = created.id;
        }
        const res = await api<SendMessageResponse>(`/threads/${id}/edits`, {
          method: "POST",
          body: JSON.stringify({ text: req.text, modelId: mid, target: req.target, references: req.references, keep: req.keep, params: req.params, ...(req.exact ? { exact: true } : {}) }),
        });
        try {
          localStorage.setItem(LAST_MODEL_KEY, mid);
        } catch {
          // Only a convenience.
        }
        const now = id;
        await qc.fetchQuery({ queryKey: keys.thread(now), queryFn: () => api<ThreadDetailDto>(`/threads/${now}`), staleTime: 0 });
        void qc.invalidateQueries({ queryKey: ["threads"] });
        if (res.assistantMessageId) attach(res.runId, res.assistantMessageId, now);
        if (!threadId) void navigate({ to: "/edit", search: { t: now } });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Gagal mengirim.");
        throw err;
      }
    },
    [attach, chosen?.id, navigate, qc, threadId],
  );

  const refsToSend = useMemo(() => references.slice(0, maxRefs), [references, maxRefs]);
  const compiled = useMemo(
    () =>
      compileEditPrompt(
        text.trim() || "(tulis instruksi)",
        refsToSend.map((r) => ({ role: r.role })),
        keep,
      ),
    [keep, refsToSend, text],
  );

  const sendFromComposer = useCallback(async () => {
    if (!target) return;
    const sendRefs = references.flatMap((r) => (r.role ? [{ assetId: r.assetId, role: r.role }] : []));
    await run({ text: manual ?? text, exact: manual !== null, target, references: sendRefs, keep, params });
    setText("");
    setManual(null);
    setReferences([]);
  }, [keep, manual, params, references, run, target, text]);

  /* ----------------------------------------------------------------- rendering */
  const endpoint = chosen ? endpoints.data?.endpoints.find((e) => e.id === chosen.endpointId) : undefined;
  const keyMissing = !!endpoint && endpoint.needsKey && !endpoint.hasKey;
  const noEndpoints = endpoints.isSuccess && endpoints.data.endpoints.length === 0;
  const noImageModels = models.isSuccess && imageModels.length === 0;
  const inspectorVisible = wide || inspectorOpen;
  const current = versions.find((v) => v.assetId === target) ?? null;
  const currentMessage = current?.messageId ? messages.find((m) => m.id === current.messageId) : undefined;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  const inspector = (
    <ImageInspector
      mode="edit"
      model={chosen}
      onPickModel={() => setPickerOpen(true)}
      onShowProfile={() => chosen && setProfileFor(chosen.id)}
      params={params}
      onParams={(p) => {
        touch();
        setParams(p);
      }}
      running={running}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Edit gambar">
        <ThreadHeader
          thread={thread.data}
          fallbackTitle="Edit baru"
          renaming={renaming}
          setRenaming={setRenaming}
          onDelete={() => setDeleting(true)}
          showInspectorToggle={!wide}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
        />

        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-[calc(var(--read-max)+3rem)] gap-6 px-4 py-6">
            {threadId && thread.isPending && (
              <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
                <span className="node node-run" aria-hidden />
                Memuat edit
              </p>
            )}
            {threadId && thread.isError && (
              <div className="grid gap-3 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
                <p>{thread.error.message}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-secondary" onClick={() => void thread.refetch()}>
                    Coba lagi
                  </button>
                  <Link to="/edit" className="btn btn-ghost no-underline">
                    Mulai edit baru
                  </Link>
                </div>
              </div>
            )}

            {/* ------------------------------------------------ the image being edited */}
            <section aria-labelledby="stage-h" className="grid gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="stage-h" className="text-title font-semibold">
                  {target ? `Gambar yang diedit${current ? `: ${current.label}` : ""}` : "Edit gambar"}
                </h2>
                {target && (
                  <div className="flex flex-wrap gap-1">
                    <input ref={targetInput} type="file" accept={ACCEPTED_IMAGE_TYPES} hidden onChange={(e) => { void addImages([...(e.target.files ?? [])], true).then(setStageError); e.target.value = ""; }} />
                    <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" disabled={running} onClick={() => targetInput.current?.click()}>
                      <SwapIcon size={14} aria-hidden />
                      Ganti gambar
                    </button>
                    <button type="button" className="btn btn-ghost min-h-8 px-2 text-dense" onClick={() => void downloadAsset(target, `ezclaw-${target.slice(0, 8)}.png`)}>
                      <DownloadSimpleIcon size={14} aria-hidden />
                      Unduh
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost min-h-8 px-2 text-dense"
                      disabled={versions.length < 2}
                      title={versions.length < 2 ? "Perlu minimal satu hasil edit untuk dibandingkan." : undefined}
                      onClick={() => setCompare({ a: current?.parent ?? versions[0]?.assetId ?? target, b: target })}
                    >
                      <ArrowsLeftRightIcon size={14} aria-hidden />
                      Bandingkan
                    </button>
                  </div>
                )}
              </div>

              {target ? (
                <AssetImage assetId={target} alt={`Gambar yang diedit${current ? `, ${current.label}` : ""}`} contain ratio="1 / 1" className="h-[36vh] min-h-48 w-auto max-w-full justify-self-start rounded-md border border-line bg-sunken" />
              ) : (
                <TargetDrop
                  noEndpoints={noEndpoints}
                  noImageModels={noImageModels}
                  uploading={uploading > 0}
                  onFiles={(f) => void addImages(f, true).then(setStageError)}
                />
              )}
              {stageError && (
                <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
                  {stageError}
                </p>
              )}
            </section>

            {/* ------------------------------------------------ running or failed */}
            {live && (
              <section aria-label="Sedang dibuat" className="grid gap-2" aria-busy>
                <h2 className="text-dense font-semibold text-fg-2">{live.composed ? "Prompt dirapikan, sedang mengedit" : "Sedang mengedit"}</h2>
                <ul className="flex flex-wrap gap-3">
                  {(live.slots.length ? live.slots : [{ status: "queued" as const }]).map((s, i) => (
                    <li key={i} className="grid h-32 w-32 place-items-center rounded-md bg-sunken p-2 text-center text-dense text-fg-2" role="status">
                      {s.status === "error" ? (
                        <span className="text-danger-text">{s.error}</span>
                      ) : s.status === "done" && s.assetId ? (
                        <AssetImage assetId={s.assetId} alt={`Hasil ${i + 1}`} className="h-32 w-32 rounded-md" />
                      ) : (
                        <span className="grid justify-items-center gap-2">
                          <span className={s.status === "running" ? "node node-run" : "node"} aria-hidden />
                          {s.status === "running" ? "Sedang dibuat" : "Antri"}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {!running && lastAssistant?.status === "error" && lastAssistant.error && (
              <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
                Edit terakhir gagal: {lastAssistant.error}
              </p>
            )}
            {!running && lastAssistant && lastAssistant.notes.length > 0 && (
              <ul className="grid gap-1 rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2" aria-label="Catatan edit terakhir">
                {lastAssistant.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
            {live?.notes.map((n) => (
              <p key={n} className="rounded-sm bg-sunken px-3 py-2 text-dense text-fg-2">
                {n}
              </p>
            ))}

            <LineageStrip versions={versions} target={target} disabled={running} onPick={(id) => setTarget(id)} />

            {/* ------------------------------------------------ how this version was made */}
            {current && currentMessage?.image && (
              <VersionDetails
                key={current.assetId}
                version={current}
                meta={currentMessage.image}
                modelLabel={currentMessage.modelLabel}
                durationMs={currentMessage.durationMs}
                messageId={currentMessage.id}
                running={running}
                onShowRequest={setLogFor}
                onRepeat={async () => {
                  const m = currentMessage.image!;
                  await run({
                    text: m.sentPrompt,
                    exact: true,
                    target: m.target ?? current.parent ?? current.assetId,
                    references: m.references,
                    keep: m.keep ?? [],
                    params: { ...m.params, ...(current.seed !== undefined ? { seed: current.seed } : {}), n: 1 },
                  }).catch(() => {});
                }}
              />
            )}
          </div>
        </div>

        <EditComposer
          model={chosen}
          spec={spec}
          hasTarget={!!target}
          targetLabel={target ? (current ? current.label : "gambar asli") : null}
          onPickModel={() => setPickerOpen(true)}
          running={running}
          keyMissing={keyMissing}
          text={text}
          onText={setText}
          references={references}
          onReferences={setReferences}
          keep={keep}
          onKeep={setKeep}
          params={params}
          onParams={(p) => {
            touch();
            setParams(p);
          }}
          compiled={compiled}
          manual={manual}
          onManual={setManual}
          onAddFiles={(f) => addImages(f, false)}
          uploading={uploading}
          onSend={sendFromComposer}
          onStop={() => void stop()}
          error={sendError}
          focusSignal={focusSignal}
        />
      </section>

      {inspectorVisible && wide && (
        <aside aria-label="Pengaturan edit" className="hidden w-[var(--inspector-w)] shrink-0 overflow-y-auto border-l border-line bg-surface xl:block">
          {inspector}
        </aside>
      )}
      {!wide && (
        <Dialog open={inspectorOpen} onClose={() => setInspectorOpen(false)} title="Pengaturan edit" width="max-w-md">
          {inspector}
        </Dialog>
      )}

      <ModelPickerDialog
        open={pickerOpen}
        kind="image"
        onClose={() => {
          setPickerOpen(false);
          setFocusSignal((n) => n + 1);
        }}
        selectedId={chosen?.id ?? null}
        onSelect={(m) => {
          touch();
          setModelId(m.id);
        }}
      />
      <ProfileDialog modelId={profileFor} onClose={() => setProfileFor(null)} />
      <RequestLogDialog messageId={logFor} onClose={() => setLogFor(null)} />
      <CompareDialog open={compare !== null} onClose={() => setCompare(null)} versions={versions} initial={compare} />

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Hapus edit ini?"
        width="max-w-md"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDeleting(false)}>
              Batal
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                if (!threadId) return;
                try {
                  await api(`/threads/${threadId}`, { method: "DELETE" });
                  qc.removeQueries({ queryKey: keys.thread(threadId) });
                  void qc.invalidateQueries({ queryKey: ["threads"] });
                  setDeleting(false);
                  void navigate({ to: "/edit", search: {} });
                } catch (err) {
                  setSendError(err instanceof Error ? err.message : "Gagal menghapus.");
                  setDeleting(false);
                }
              }}
            >
              Hapus edit
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">Rangkaian versi dan prompt-nya dihapus dari daftar. Gambar yang sudah dibuat tetap tersimpan di folder data EZClaw.</p>
      </Dialog>
    </div>
  );
}

function TargetDrop({ noEndpoints, noImageModels, uploading, onFiles }: { noEndpoints: boolean; noImageModels: boolean; uploading: boolean; onFiles: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
      onPaste={(e) => {
        const files = [...e.clipboardData.files];
        if (files.length) {
          e.preventDefault();
          onFiles(files);
        }
      }}
      className={`grid max-w-xl justify-items-start gap-3 rounded-md border border-dashed p-6 ${over ? "border-brand-strong bg-brand-soft" : "border-line-strong bg-surface"}`}
    >
      <ImageIcon size={28} className="text-fg-3" aria-hidden />
      <p className="text-body text-fg-2">
        Pilih gambar yang mau diedit: unggah, seret ke sini, atau tempel dari clipboard. Gambar hasil mode Image juga bisa dibuka di sini lewat tombol &quot;Edit gambar ini&quot;.
      </p>
      <input ref={input} type="file" accept={ACCEPTED_IMAGE_TYPES} hidden onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
      <button type="button" className="btn btn-primary" onClick={() => input.current?.click()} disabled={uploading}>
        {uploading ? "Mengunggah" : "Pilih gambar"}
      </button>
      {noEndpoints && (
        <p className="text-dense text-fg-3">
          Belum ada endpoint.{" "}
          <Link to="/settings/endpoints" className="text-brand-text underline">
            Tambah endpoint
          </Link>{" "}
          supaya edit bisa dikirim.
        </p>
      )}
      {!noEndpoints && noImageModels && (
        <p className="text-dense text-fg-3">
          Belum ada model gambar.{" "}
          <Link to="/settings/models" className="text-brand-text underline">
            Buka daftar model
          </Link>{" "}
          untuk menandai atau menambahkannya.
        </p>
      )}
    </div>
  );
}

function VersionDetails({
  version,
  meta,
  modelLabel,
  durationMs,
  messageId,
  running,
  onShowRequest,
  onRepeat,
}: {
  version: { label: string; seed?: number };
  meta: NonNullable<ThreadDetailDto["messages"][number]["image"]>;
  modelLabel: string | null;
  durationMs: number | null;
  messageId: string;
  running: boolean;
  onShowRequest: (id: string) => void;
  onRepeat: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <section aria-labelledby="ver-h" className="grid gap-3 rounded-md border border-line bg-surface p-4">
      <h2 id="ver-h" className="text-dense font-semibold text-fg-2">
        Cara {version.label} dibuat
      </h2>
      <p className="whitespace-pre-wrap break-words text-body">{meta.prompt}</p>
      {meta.references.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Referensi yang dipakai">
          {meta.references.map((r, i) => (
            <li key={r.assetId} className="flex items-center gap-2 rounded-sm bg-sunken p-1 pr-2 text-meta text-fg-2">
              <AssetImage assetId={r.assetId} alt={`Referensi ${i + 1}`} className="h-10 w-10 rounded-sm" />
              {r.role ? IMAGE_ROLE_LABELS[r.role] : "Referensi"}
            </li>
          ))}
        </ul>
      )}
      {meta.keep && meta.keep.length > 0 && <p className="text-dense text-fg-2">Dipertahankan: {meta.keep.map((k) => KEEP_LABELS[k]).join(", ")}.</p>}
      <details className="rounded-sm bg-sunken px-3 py-2">
        <summary className="cursor-pointer text-dense font-semibold text-fg-2">{meta.composed ? "Prompt yang dikirim (dirapikan Composer)" : "Prompt yang dikirim"}</summary>
        <p className="mt-2 whitespace-pre-wrap break-words font-code text-dense text-fg-2">{meta.sentPrompt}</p>
      </details>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
        {modelLabel && <span className="font-code">{modelLabel}</span>}
        <span>{IMAGE_WIRE_LABELS[meta.wire as keyof typeof IMAGE_WIRE_LABELS] ?? meta.wire}</span>
        {version.seed !== undefined && <span>seed {version.seed}</span>}
        {durationMs !== null && <span>{(durationMs / 1000).toFixed(1)} dtk</span>}
        <button type="button" className="inline-flex items-center gap-1 text-fg-2 underline" onClick={() => onShowRequest(messageId)}>
          <CodeIcon size={12} aria-hidden />
          Lihat request
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={running}
          onClick={() => {
            setError(null);
            onRepeat().catch((e: unknown) => setError(e instanceof Error ? e.message : "Gagal mengirim."));
          }}
        >
          Ulangi edit ini{version.seed !== undefined ? ` (seed ${version.seed})` : ""}
        </button>
        <span className="text-meta text-fg-3">Mengirim prompt di atas persis, dari gambar yang sama.</span>
      </div>
      {error && (
        <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
