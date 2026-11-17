import type { ModelDto, SendMessageResponse, ThreadDetailDto, VideoParams, VideoQuoteResponse } from "@ezclaw/core";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { ModelPickerDialog } from "../components/ModelPicker";
import { ProfileDialog } from "../components/ProfileDialog";
import { ThreadHeader } from "../components/ThreadHeader";
import { WorkspaceInspector } from "../components/WorkspaceInspector";
import { RequestLogDialog } from "../components/chat/RequestLogDialog";
import { VideoComposer, type Frames } from "../components/video/VideoComposer";
import { VideoInspector } from "../components/video/VideoInspector";
import { AssistantTurn, UserTurn, VideoEmptyIcon, type ResendRequest } from "../components/video/VideoTurn";
import { useVideoRun } from "../components/video/useVideoRun";
import { keys, useEndpoints, useModelProfile, useModels, useSettings, useThread } from "../lib/queries";

const LAST_MODEL_KEY = "ezclaw.lastVideoModel";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

interface Draft {
  modelId: string | null;
  params: VideoParams;
}

export function VideoPage() {
  const search = useSearch({ strict: false }) as { t?: string; start?: string };
  const threadId = search.t;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const thread = useThread(threadId);
  const models = useModels();
  const endpoints = useEndpoints();
  const settings = useSettings();
  const { live: liveRaw, attach, stop } = useVideoRun(threadId, thread.data?.activeRun);
  const live = liveRaw && liveRaw.threadId === threadId ? liveRaw : null;

  const [draft, setDraft] = useState<Draft>({ modelId: null, params: {} });
  const userEdited = useRef(false);
  const [text, setText] = useState("");
  const [frames, setFrames] = useState<Frames>(() => (search.start ? { start: search.start } : {}));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [away, setAway] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const loadedThread = thread.data?.id;
  useEffect(() => {
    userEdited.current = false;
    setSendError(null);
    if (thread.data) setDraft({ modelId: thread.data.modelId, params: thread.data.videoParams });
    else if (!threadId) setDraft({ modelId: null, params: {} });
    // Only when the thread shown changes, not on every refetch of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThread, threadId]);

  // "Make a video" from an image elsewhere arrives as ?start=<asset>.
  useEffect(() => {
    if (search.start) {
      setFrames({ start: search.start });
      setFocusSignal((n) => n + 1);
    }
  }, [search.start]);

  const modelList = models.data?.models;
  const videoModels = useMemo(() => (modelList ?? []).filter((m) => m.kind === "video"), [modelList]);
  const chosen: ModelDto | null = useMemo(() => {
    const byId = (id: string | null | undefined) => videoModels.find((m) => m.id === id) ?? null;
    return byId(draft.modelId) ?? (userEdited.current ? null : (byId(settings.data?.defaultModels.video) ?? byId(stored(LAST_MODEL_KEY))));
  }, [videoModels, draft.modelId, settings.data?.defaultModels.video]);

  const profile = useModelProfile(chosen?.id ?? null);
  const spec = profile.data?.videoSpec ?? null;

  const update = useCallback((patch: Partial<Draft>) => {
    userEdited.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const running = !!live || !!thread.data?.activeRun;

  /* The price with the settings as they stand, asked again whenever one of them changes. */
  // Only what changes the price is in the key, so typing a negative prompt does not ask again.
  const { duration, resolution, aspectRatio, audio } = draft.params;
  const quoteInput = chosen ? { modelId: chosen.id, params: { duration, resolution, aspectRatio, audio }, hasStart: !!frames.start, hasEnd: !!frames.end } : null;
  const quote = useQuery({
    queryKey: ["video-quote", quoteInput],
    queryFn: ({ signal }) => api<VideoQuoteResponse>("/video/quote", { method: "POST", body: JSON.stringify(quoteInput), signal }),
    enabled: !!quoteInput,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const estimate = !quoteInput ? null : quote.isError ? null : quote.isFetching && !quote.data ? undefined : (quote.data ?? undefined);

  const send = useCallback(
    async (req: ResendRequest) => {
      setSendError(null);
      const modelId = chosen?.id;
      if (!modelId) throw new Error("Pilih model video dulu.");
      try {
        let id = threadId;
        if (!id) {
          const created = await api<ThreadDetailDto>("/threads", { method: "POST", body: JSON.stringify({ mode: "video", modelId }) });
          id = created.id;
        }
        const res = await api<SendMessageResponse>(`/threads/${id}/videos`, {
          method: "POST",
          body: JSON.stringify({ text: req.text, modelId, params: req.params, ...(req.startFrame ? { startFrame: req.startFrame } : {}), ...(req.endFrame ? { endFrame: req.endFrame } : {}) }),
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
        if (!threadId || search.start) void navigate({ to: "/video", search: { t: threadIdNow } });
        stick.current = true;
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Gagal mengirim.");
        throw err;
      }
    },
    [attach, chosen?.id, navigate, qc, search.start, threadId],
  );

  const sendFromComposer = useCallback(async () => {
    await send({ text, params: draft.params, ...(frames.start ? { startFrame: frames.start } : {}), ...(frames.end ? { endFrame: frames.end } : {}) });
    setText("");
    setFrames({});
  }, [draft.params, frames, send, text]);

  const useFrame = useCallback((assetId: string) => {
    setFrames({ start: assetId });
    setFocusSignal((n) => n + 1);
  }, []);

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
  }, [live?.stage, thread.data?.messages.length, scrollToEnd]);

  const endpoint = chosen ? endpoints.data?.endpoints.find((e) => e.id === chosen.endpointId) : undefined;
  const keyMissing = !!endpoint && endpoint.needsKey && !endpoint.hasKey;
  const messages = thread.data?.messages ?? [];
  const noEndpoints = endpoints.isSuccess && endpoints.data.endpoints.length === 0;
  const noVideoModels = models.isSuccess && videoModels.length === 0;

  return (
    <div className="workbench flex h-full min-h-0">
      <section className="workbench-stage flex min-w-0 flex-1 flex-col" aria-label="Video">
        <ThreadHeader
          thread={thread.data}
          fallbackTitle="Video baru"
          renaming={renaming}
          setRenaming={setRenaming}
          onDelete={() => setDeleting(true)}
          showInspectorToggle
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
        />

        <div ref={scroller} onScroll={onScroll} className={`relative min-h-0 flex-1 overflow-y-auto ${!threadId && !messages.length ? "welcome-stage" : ""}`}>
          <div className="mx-auto grid w-full max-w-[var(--work-max)] gap-4 px-4 py-4">
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
                  <Link to="/video" className="btn btn-ghost no-underline">
                    Mulai video baru
                  </Link>
                </div>
              </div>
            )}

            {!threadId && messages.length === 0 && <EmptyState noEndpoints={noEndpoints} noVideoModels={noVideoModels} hasModel={!!chosen} />}

            {messages.map((m) =>
              m.role === "user" ? (
                <UserTurn key={m.id} message={m} />
              ) : (
                <AssistantTurn key={m.id} message={m} live={live && live.messageId === m.id ? live : null} running={running} onShowRequest={setLogFor} onResend={send} onUseFrame={useFrame} />
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

        <VideoComposer
          model={chosen}
          spec={spec}
          onPickModel={() => setPickerOpen(true)}
          running={running}
          keyMissing={keyMissing}
          text={text}
          onText={setText}
          frames={frames}
          onFrames={setFrames}
          params={draft.params}
          onParams={(p) => update({ params: p })}
          onSend={sendFromComposer}
          onStop={() => void stop()}
          error={sendError}
          focusSignal={focusSignal}
          estimate={estimate}
        />
      </section>

      {inspectorOpen && (
        <WorkspaceInspector label="Pengaturan video" mode="Video">
          <VideoInspector model={chosen} onPickModel={() => setPickerOpen(true)} onShowProfile={() => chosen && setProfileFor(chosen.id)} params={draft.params} onParams={(p) => update({ params: p })} running={running} />
        </WorkspaceInspector>
      )}

      <ModelPickerDialog
        open={pickerOpen}
        kind="video"
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
                  void navigate({ to: "/video", search: {} });
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
        <p className="text-body text-fg-2">Percakapan dan permintaannya dihapus. File video hasilnya tetap tersimpan di folder data EZClaw.</p>
      </Dialog>
    </div>
  );
}

function EmptyState({ noEndpoints, noVideoModels, hasModel }: { noEndpoints: boolean; noVideoModels: boolean; hasModel: boolean }) {
  return (
    <div className="welcome">
      <span className="welcome-symbol">
        <VideoEmptyIcon />
      </span>
      <h2>Dari satu kalimat atau satu gambar, jadi adegan.</h2>
      {noEndpoints ? (
        <>
          <p className="welcome-description">Hubungkan provider yang punya model video, seperti OpenRouter, Venice, atau xAI.</p>
          <div className="welcome-actions">
            <Link to="/settings/endpoints" className="btn btn-primary">
              Hubungkan provider
            </Link>
          </div>
        </>
      ) : noVideoModels ? (
        <>
          <p className="welcome-description">Belum ada model video. Tekan Tes di endpoint OpenRouter, Venice, atau xAI untuk memuat ulang daftarnya, atau ubah jenis model menjadi Video di Settings.</p>
          <div className="welcome-actions">
            <Link to="/settings/models" className="btn btn-primary">
              Buka daftar model
            </Link>
          </div>
        </>
      ) : (
        <p className="welcome-description">{hasModel ? "Tulis adegannya, atau pasang frame awal untuk menggerakkan sebuah gambar." : "Pilih model video, lalu tulis adegannya atau pasang frame awal."} Hasilnya bisa disambung: ambil frame terakhir sebagai awal video berikutnya.</p>
      )}
    </div>
  );
}
