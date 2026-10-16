import type { ChatParams, MessageDto, ModelDto, SendMessageResponse, ThreadDetailDto, ThreadHarness } from "@ezclaw/core";
import { ArrowDownIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { ModelPickerDialog } from "../components/ModelPicker";
import { ProfileDialog } from "../components/ProfileDialog";
import { ThreadHeader } from "../components/ThreadHeader";
import { Composer } from "../components/chat/Composer";
import { Inspector } from "../components/chat/Inspector";
import { AssistantMessage, UserMessage } from "../components/chat/MessageView";
import { RequestLogDialog } from "../components/chat/RequestLogDialog";
import { useLiveRun } from "../components/chat/useLiveRun";
import { keys, useEndpoints, useModels, useSettings, useThread } from "../lib/queries";

const LAST_MODEL_KEY = "ezclaw.lastModel";
const WIDE = "(min-width: 1280px)";

const CHAT_HARNESS: ThreadHarness = { on: true, profileId: "ezclaw-chat", tools: [] };

interface Draft {
  modelId: string | null;
  systemPrompt: string;
  params: ChatParams;
  harness: ThreadHarness;
}

function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(WIDE);
      mql.addEventListener("change", cb);
      return () => mql.removeEventListener("change", cb);
    },
    () => window.matchMedia(WIDE).matches,
  );
}

function readLastModel(): string | null {
  try {
    return localStorage.getItem(LAST_MODEL_KEY);
  } catch {
    return null;
  }
}

function lastUserText(messages: MessageDto[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") {
      return m.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("");
    }
  }
  return null;
}

export function ChatPage() {
  const search = useSearch({ strict: false }) as { t?: string };
  const threadId = search.t;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wide = useWide();

  const thread = useThread(threadId);
  const models = useModels();
  const endpoints = useEndpoints();
  const settings = useSettings();
  const { live: liveRaw, attach, stop } = useLiveRun(threadId, thread.data?.activeRun);
  const live = liveRaw && liveRaw.threadId === threadId ? liveRaw : null;

  const [draft, setDraft] = useState<Draft>({ modelId: null, systemPrompt: "", params: {}, harness: CHAT_HARNESS });
  const userEdited = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  /* ----------------------------------------------------- draft initialisation */
  const loadedThread = thread.data?.id;
  useEffect(() => {
    userEdited.current = false;
    setSendError(null);
    if (thread.data) {
      setDraft({ modelId: thread.data.modelId, systemPrompt: thread.data.systemPrompt, params: thread.data.params, harness: thread.data.harness });
    } else if (!threadId) {
      setDraft({ modelId: null, systemPrompt: "", params: {}, harness: CHAT_HARNESS });
    }
    // Re-run only when the thread being shown changes, not on every refetch of the same thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThread, threadId]);

  const modelList = models.data?.models;
  const chosen: ModelDto | null = useMemo(() => {
    if (!modelList) return null;
    const textModels = modelList.filter((m) => m.kind !== "image");
    const byId = (id: string | null | undefined) => textModels.find((m) => m.id === id) ?? null;
    return byId(draft.modelId) ?? (userEdited.current ? null : byId(settings.data?.defaultModels.chat) ?? byId(readLastModel()));
  }, [modelList, draft.modelId, settings.data?.defaultModels.chat]);

  const update = useCallback((patch: Partial<Draft>) => {
    userEdited.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  // Save settings changed before the first message, and keep a stored thread in step.
  const saveTimer = useRef<number>(0);
  useEffect(() => {
    if (!userEdited.current || !threadId) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api<ThreadDetailDto>(`/threads/${threadId}`, {
        method: "PATCH",
        body: JSON.stringify({ modelId: draft.modelId, systemPrompt: draft.systemPrompt, params: draft.params, harness: draft.harness }),
      }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(saveTimer.current);
  }, [draft, threadId]);

  /* ------------------------------------------------------------------ sending */
  const running = !!live || !!thread.data?.activeRun;

  const send = useCallback(
    async (text: string) => {
      setSendError(null);
      const modelId = chosen?.id;
      if (!modelId) throw new Error("Pilih model dulu.");
      try {
        let id = threadId;
        if (!id) {
          const created = await api<ThreadDetailDto>("/threads", { method: "POST", body: JSON.stringify({ mode: "chat", modelId, harness: draft.harness }) });
          id = created.id;
        }
        const res = await api<SendMessageResponse>(`/threads/${id}/messages`, {
          method: "POST",
          body: JSON.stringify({ text, modelId, systemPrompt: draft.systemPrompt, params: draft.params }),
        });
        try {
          localStorage.setItem(LAST_MODEL_KEY, modelId);
        } catch {
          // The last model is a convenience only.
        }
        const threadIdNow = id;
        await qc.fetchQuery({ queryKey: keys.thread(threadIdNow), queryFn: () => api<ThreadDetailDto>(`/threads/${threadIdNow}`), staleTime: 0 });
        attach(res.runId, res.assistantMessageId ?? "", id);
        void qc.invalidateQueries({ queryKey: ["threads"] });
        if (!threadId) void navigate({ to: "/chat", search: { t: id } });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Pesan gagal dikirim.");
        throw err;
      }
    },
    [attach, chosen?.id, draft.params, draft.systemPrompt, navigate, qc, threadId],
  );

  const retry = useCallback(() => {
    const text = lastUserText(thread.data?.messages ?? []);
    if (text) void send(text).catch(() => {});
  }, [send, thread.data?.messages]);

  /* ------------------------------------------------------------------ scrolling */
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAway(!near);
  };
  const scrollToEnd = useCallback((smooth = false) => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);
  useEffect(() => {
    stick.current = true;
    scrollToEnd();
  }, [threadId, scrollToEnd]);
  useEffect(() => {
    if (stick.current) scrollToEnd();
  }, [live?.text, live?.reasoning, thread.data?.messages.length, scrollToEnd]);

  /* ---------------------------------------------------------------- rendering */
  const endpoint = chosen ? endpoints.data?.endpoints.find((e) => e.id === chosen.endpointId) : undefined;
  const keyMissing = !!endpoint && endpoint.needsKey && !endpoint.hasKey;
  const messages = thread.data?.messages ?? [];
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;
  const inspectorVisible = wide || inspectorOpen;

  const inspector = (
    <Inspector
      model={chosen}
      onPickModel={() => setPickerOpen(true)}
      onShowProfile={() => chosen && setProfileFor(chosen.id)}
      systemPrompt={draft.systemPrompt}
      onSystemPrompt={(v) => update({ systemPrompt: v })}
      params={draft.params}
      onParams={(p) => update({ params: p })}
      harness={draft.harness}
      onHarness={(h) => update({ harness: h })}
      running={running}
    />
  );

  const noEndpoints = endpoints.isSuccess && endpoints.data.endpoints.length === 0;

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Percakapan">
        <ThreadHeader
          thread={thread.data}
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
                  <Link to="/chat" className="btn btn-ghost no-underline">
                    Buka thread baru
                  </Link>
                </div>
              </div>
            )}

            {!threadId && messages.length === 0 && <EmptyState noEndpoints={noEndpoints} hasModel={!!chosen} />}

            {messages.map((m) =>
              m.role === "user" ? (
                <UserMessage key={m.id} message={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  live={live && live.messageId === m.id ? live : null}
                  onShowRequest={setLogFor}
                  onRetry={retry}
                  canRetry={m.id === lastAssistantId && !running}
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
                scrollToEnd(true);
              }}
            >
              <ArrowDownIcon size={16} aria-hidden />
              Ke jawaban terbaru
            </button>
          )}
        </div>

        <Composer
          model={chosen}
          onPickModel={() => setPickerOpen(true)}
          running={running}
          keyMissing={keyMissing}
          onSend={send}
          onStop={() => void stop()}
          error={sendError}
          focusSignal={focusSignal}
        />
      </section>

      {inspectorVisible && wide && (
        <aside aria-label="Pengaturan percakapan" className="hidden w-[var(--inspector-w)] shrink-0 overflow-y-auto border-l border-line bg-surface xl:block">
          {inspector}
        </aside>
      )}
      {!wide && (
        <Dialog open={inspectorOpen} onClose={() => setInspectorOpen(false)} title="Pengaturan percakapan" width="max-w-md">
          {inspector}
        </Dialog>
      )}

      <ModelPickerDialog open={pickerOpen} onClose={() => { setPickerOpen(false); setFocusSignal((n) => n + 1); }} selectedId={chosen?.id ?? null} onSelect={(m) => update({ modelId: m.id })} />
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
                  void navigate({ to: "/chat" });
                } catch (err) {
                  setDeleting(false);
                  setSendError(err instanceof Error ? err.message : "Thread gagal dihapus.");
                }
              }}
            >
              Hapus thread
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">Seluruh pesan dan catatan request di thread ini ikut terhapus dan tidak bisa dikembalikan.</p>
      </Dialog>
    </div>
  );
}

function EmptyState({ noEndpoints, hasModel }: { noEndpoints: boolean; hasModel: boolean }) {
  if (noEndpoints) {
    return (
      <div className="grid gap-3 py-10">
        <h1 className="text-hero font-semibold">Belum ada model</h1>
        <p className="text-body text-fg-2">Tambahkan API key OpenRouter, Venice, atau provider lain untuk mulai. Key disimpan di penyimpanan kredensial komputer ini.</p>
        <Link to="/settings/endpoints" className="btn btn-primary justify-self-start no-underline">
          Tambah endpoint
        </Link>
      </div>
    );
  }
  return (
    <div className="grid gap-3 py-10">
      <h1 className="text-hero font-semibold">Mulai percakapan</h1>
      <p className="text-body text-fg-2">{hasModel ? "Tulis pesan pertamamu di bawah. Parameter dan system prompt ada di panel pengaturan." : "Pilih model di bawah, lalu tulis pesan pertamamu."}</p>
    </div>
  );
}
