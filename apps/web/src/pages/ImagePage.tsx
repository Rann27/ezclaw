import type { ImageParams, ImageReference, ModelDto, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { ModelPickerDialog } from "../components/ModelPicker";
import { ProfileDialog } from "../components/ProfileDialog";
import { ThreadHeader } from "../components/ThreadHeader";
import { RequestLogDialog } from "../components/chat/RequestLogDialog";
import { ImageComposer } from "../components/image/ImageComposer";
import { ImageInspector } from "../components/image/ImageInspector";
import { AssistantTurn, UserTurn, type RunRequest } from "../components/image/ImageTurn";
import { useImageRun } from "../components/image/useImageRun";
import { keys, useEndpoints, useModelProfile, useModels, useSettings, useThread } from "../lib/queries";
import { useWide } from "../lib/useWide";

const LAST_MODEL_KEY = "ezclaw.lastImageModel";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

interface Draft {
  modelId: string | null;
  params: ImageParams;
}

export function ImagePage() {
  const search = useSearch({ strict: false }) as { t?: string };
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

  const [draft, setDraft] = useState<Draft>({ modelId: null, params: {} });
  const userEdited = useRef(false);
  const [text, setText] = useState("");
  const [references, setReferences] = useState<ImageReference[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [away, setAway] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  /* ----------------------------------------------------- draft initialisation */
  const loadedThread = thread.data?.id;
  useEffect(() => {
    userEdited.current = false;
    setSendError(null);
    if (thread.data) setDraft({ modelId: thread.data.modelId, params: thread.data.imageParams });
    else if (!threadId) setDraft({ modelId: null, params: {} });
    // Re-run only when the thread being shown changes, not on every refetch of the same thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThread, threadId]);

  const modelList = models.data?.models;
  const imageModels = useMemo(() => (modelList ?? []).filter((m) => m.kind === "image"), [modelList]);
  const chosen: ModelDto | null = useMemo(() => {
    const byId = (id: string | null | undefined) => imageModels.find((m) => m.id === id) ?? null;
    return byId(draft.modelId) ?? (userEdited.current ? null : (byId(settings.data?.defaultModels.image) ?? byId(stored(LAST_MODEL_KEY))));
  }, [imageModels, draft.modelId, settings.data?.defaultModels.image]);

  const profile = useModelProfile(chosen?.id ?? null);
  const spec = profile.data?.imageSpec ?? null;

  const update = useCallback((patch: Partial<Draft>) => {
    userEdited.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  /* ------------------------------------------------------------------ sending */
  const running = !!live || !!thread.data?.activeRun;

  const run = useCallback(
    async (req: RunRequest) => {
      setSendError(null);
      const modelId = chosen?.id;
      if (!modelId) throw new Error("Pilih model gambar dulu.");
      try {
        let id = threadId;
        if (!id) {
          const created = await api<ThreadDetailDto>("/threads", { method: "POST", body: JSON.stringify({ mode: "image", modelId }) });
          id = created.id;
        }
        const res = await api<SendMessageResponse>(`/threads/${id}/images`, {
          method: "POST",
          body: JSON.stringify({ text: req.text, modelId, references: req.references, params: req.params, ...(req.exact ? { exact: true } : {}) }),
        });
        try {
          localStorage.setItem(LAST_MODEL_KEY, modelId);
        } catch {
          // Only a convenience.
        }
        const threadIdNow = id;
        await qc.fetchQuery({ queryKey: keys.thread(threadIdNow), queryFn: () => api<ThreadDetailDto>(`/threads/${threadIdNow}`), staleTime: 0 });
        void qc.invalidateQueries({ queryKey: ["threads"] });
        if (res.assistantMessageId) attach(res.runId, res.assistantMessageId, threadIdNow);
        if (!threadId) void navigate({ to: "/image", search: { t: threadIdNow } });
        stick.current = true;
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Gagal mengirim.");
        throw err;
      }
    },
    [attach, chosen?.id, navigate, qc, threadId],
  );

  const sendFromComposer = useCallback(async () => {
    await run({ text, exact: false, references, params: draft.params });
    setText("");
    setReferences([]);
  }, [draft.params, references, run, text]);

  const useAsReference = useCallback((assetId: string) => {
    setReferences((r) => (r.some((x) => x.assetId === assetId) ? r : [...r, { assetId }]));
    setFocusSignal((n) => n + 1);
  }, []);

  /* ---------------------------------------------------------------- scrolling */
  const scrollToEnd = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < 80;
    setAway(gap > 240);
  };
  useEffect(() => {
    if (stick.current) scrollToEnd();
  }, [live?.slots, live?.composed, thread.data?.messages.length, scrollToEnd]);

  /* ---------------------------------------------------------------- rendering */
  const endpoint = chosen ? endpoints.data?.endpoints.find((e) => e.id === chosen.endpointId) : undefined;
  const keyMissing = !!endpoint && endpoint.needsKey && !endpoint.hasKey;
  const messages = thread.data?.messages ?? [];
  const noEndpoints = endpoints.isSuccess && endpoints.data.endpoints.length === 0;
  const noImageModels = models.isSuccess && imageModels.length === 0;
  const inspectorVisible = wide || inspectorOpen;

  const inspector = (
    <ImageInspector
      model={chosen}
      onPickModel={() => setPickerOpen(true)}
      onShowProfile={() => chosen && setProfileFor(chosen.id)}
      params={draft.params}
      onParams={(p) => update({ params: p })}
      running={running}
    />
  );

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Gambar">
        <ThreadHeader
          thread={thread.data}
          fallbackTitle="Gambar baru"
          renaming={renaming}
          setRenaming={setRenaming}
          onDelete={() => setDeleting(true)}
          showInspectorToggle={!wide}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
        />

        <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-[calc(var(--read-max)+3rem)] gap-8 px-4 py-6">
            {threadId && thread.isPending && (
              <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
                <span className="node node-run" aria-hidden />
                Memuat percakapan
              </p>
            )}
            {threadId && thread.isError && (
              <div className="grid gap-3 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
                <p>{thread.error.message}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-secondary" onClick={() => void thread.refetch()}>
                    Coba lagi
                  </button>
                  <Link to="/image" className="btn btn-ghost no-underline">
                    Mulai gambar baru
                  </Link>
                </div>
              </div>
            )}

            {!threadId && messages.length === 0 && <EmptyState noEndpoints={noEndpoints} noImageModels={noImageModels} hasModel={!!chosen} />}

            {messages.map((m) =>
              m.role === "user" ? (
                <UserTurn key={m.id} message={m} />
              ) : (
                <AssistantTurn
                  key={m.id}
                  message={m}
                  live={live && live.messageId === m.id ? live : null}
                  running={running}
                  maxReferences={spec?.maxInputImages ?? 0}
                  onShowRequest={setLogFor}
                  onRun={run}
                  onUseAsReference={useAsReference}
                />
              ),
            )}
          </div>

          {away && (
            <button
              type="button"
              className="btn btn-secondary sticky bottom-3 left-1/2 -translate-x-1/2 shadow-popover"
              onClick={() => {
                stick.current = true;
                scrollToEnd();
              }}
            >
              <ArrowDownIcon size={16} aria-hidden />
              Ke hasil terbaru
            </button>
          )}
        </div>

        <ImageComposer
          model={chosen}
          spec={spec}
          onPickModel={() => setPickerOpen(true)}
          running={running}
          keyMissing={keyMissing}
          text={text}
          onText={setText}
          references={references}
          onReferences={setReferences}
          params={draft.params}
          onParams={(p) => update({ params: p })}
          onSend={sendFromComposer}
          onStop={() => void stop()}
          error={sendError}
          focusSignal={focusSignal}
        />
      </section>

      {inspectorVisible && wide && (
        <aside aria-label="Pengaturan gambar" className="hidden w-[var(--inspector-w)] shrink-0 overflow-y-auto border-l border-line bg-surface xl:block">
          {inspector}
        </aside>
      )}
      {!wide && (
        <Dialog open={inspectorOpen} onClose={() => setInspectorOpen(false)} title="Pengaturan gambar" width="max-w-md">
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
        onSelect={(m) => update({ modelId: m.id })}
      />
      <ProfileDialog modelId={profileFor} onClose={() => setProfileFor(null)} />
      <RequestLogDialog messageId={logFor} onClose={() => setLogFor(null)} />

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Hapus thread ini?"
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
                  void navigate({ to: "/image", search: {} });
                } catch (err) {
                  setSendError(err instanceof Error ? err.message : "Gagal menghapus.");
                  setDeleting(false);
                }
              }}
            >
              Hapus thread
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">Percakapan dan permintaannya dihapus. Gambar hasilnya tetap tersimpan di folder data EZClaw.</p>
      </Dialog>
    </div>
  );
}

function EmptyState({ noEndpoints, noImageModels, hasModel }: { noEndpoints: boolean; noImageModels: boolean; hasModel: boolean }) {
  return (
    <div className="grid gap-3 pt-10">
      <h1 className="text-hero font-semibold">Buat gambar</h1>
      {noEndpoints ? (
        <>
          <p className="max-w-prose text-body text-fg-2">Gambar dibuat lewat model di endpoint yang kamu tambahkan. Tambahkan endpoint dulu.</p>
          <Link to="/settings/endpoints" className="btn btn-primary justify-self-start no-underline">
            Tambah endpoint
          </Link>
        </>
      ) : noImageModels ? (
        <>
          <p className="max-w-prose text-body text-fg-2">Belum ada model gambar. Model dari endpoint dikenali sebagai gambar kalau provider menyebut outputnya gambar. Untuk model lain, tambahkan manual dengan jenis Gambar, atau ubah jenisnya di Settings, bagian Model.</p>
          <Link to="/settings/models" className="btn btn-primary justify-self-start no-underline">
            Buka daftar model
          </Link>
        </>
      ) : (
        <p className="max-w-prose text-body text-fg-2">
          {hasModel ? "Tulis prompt di bawah." : "Pilih model gambar di bawah, lalu tulis prompt."} Tambahkan gambar referensi kalau modelnya menerima. Pesan lanjutan seperti "ubah jadi malam hari" mengubah hasil sebelumnya, dan prompt yang dikirim ke model selalu tampil di atas hasil.
        </p>
      )}
    </div>
  );
}
