import { APPROVAL_MODES, APPROVAL_MODE_LABELS, type ApprovalMode, type ChatParams, type MessageDto, type ModelDto, type SendMessageResponse, type ThreadDetailDto, type ThreadHarness, type WorkspaceCheckResponse, type CheckpointDto, type RestoreResponse } from "@ezclaw/core";
import { ArrowDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { FolderPicker } from "../components/agent/FolderPicker";
import { AgentInspector } from "../components/agent/AgentInspector";
import { AgentTimeline, PlanPanel } from "../components/agent/AgentTimeline";
import { useAgentRun } from "../components/agent/useAgentRun";
import { Dialog } from "../components/Dialog";
import { ModelPickerDialog } from "../components/ModelPicker";
import { ProfileDialog } from "../components/ProfileDialog";
import { ThreadHeader } from "../components/ThreadHeader";
import { Composer } from "../components/chat/Composer";
import { RequestLogDialog } from "../components/chat/RequestLogDialog";
import { keys, useCheckpoints, useEndpoints, useModels, useRecentWorkspaces, useSettings, useThread } from "../lib/queries";

const LAST_MODEL_KEY = "ezclaw.lastAgentModel";
const LAST_WORKSPACE_KEY = "ezclaw.lastWorkspace";
const WIDE = "(min-width: 1280px)";
const DEFAULT_HARNESS: ThreadHarness = { on: true, profileId: "ezclaw-agent", tools: [] };

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

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
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

function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

interface Draft {
  modelId: string | null;
  systemPrompt: string;
  params: ChatParams;
}

export function AgentPage() {
  const search = useSearch({ strict: false }) as { t?: string };
  const threadId = search.t;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const wide = useWide();

  const thread = useThread(threadId);
  const models = useModels();
  const endpoints = useEndpoints();
  const settings = useSettings();
  const recent = useRecentWorkspaces();
  const { live: liveRaw, attach, stop, decide, answer } = useAgentRun(threadId, thread.data?.activeRun);
  const live = liveRaw && liveRaw.threadId === threadId ? liveRaw : null;

  const [draft, setDraft] = useState<Draft>({ modelId: null, systemPrompt: "", params: {} });
  const userEdited = useRef(false);
  const [pendingHarness, setPendingHarness] = useState<ThreadHarness>(DEFAULT_HARNESS);
  const [pendingMode, setPendingMode] = useState<ApprovalMode>("ask");
  const [workspaceText, setWorkspaceText] = useState(() => stored(LAST_WORKSPACE_KEY) ?? "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmFull, setConfirmFull] = useState(false);
  const checkpoints = useCheckpoints(threadId);
  const [undoing, setUndoing] = useState<CheckpointDto | null>(null);
  const [undoResult, setUndoResult] = useState<RestoreResponse | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  /* ----------------------------------------------------- draft initialisation */
  const loadedThread = thread.data?.id;
  useEffect(() => {
    userEdited.current = false;
    setSendError(null);
    if (thread.data) setDraft({ modelId: thread.data.modelId, systemPrompt: thread.data.systemPrompt, params: thread.data.params });
    else if (!threadId) setDraft({ modelId: null, systemPrompt: "", params: {} });
    // Re-run only when the thread being shown changes, not on every refetch of the same thread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThread, threadId]);

  const modelList = models.data?.models;
  const chosen: ModelDto | null = useMemo(() => {
    if (!modelList) return null;
    const textModels = modelList.filter((m) => m.kind !== "image");
    const byId = (id: string | null | undefined) => textModels.find((m) => m.id === id) ?? null;
    return byId(draft.modelId) ?? (userEdited.current ? null : (byId(settings.data?.defaultModels.agent) ?? byId(stored(LAST_MODEL_KEY))));
  }, [modelList, draft.modelId, settings.data?.defaultModels.agent]);

  const update = useCallback((patch: Partial<Draft>) => {
    userEdited.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const saveTimer = useRef<number>(0);
  useEffect(() => {
    if (!userEdited.current || !threadId) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api<ThreadDetailDto>(`/threads/${threadId}`, { method: "PATCH", body: JSON.stringify({ modelId: draft.modelId, systemPrompt: draft.systemPrompt, params: draft.params }) }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(saveTimer.current);
  }, [draft, threadId]);

  /* -------------------------------------------------------------------- state */
  const running = !!live || !!thread.data?.activeRun;
  const harness = thread.data?.harness ?? pendingHarness;
  const approvalMode: ApprovalMode = thread.data?.approvalMode ?? pendingMode;
  const messages = thread.data?.messages ?? [];

  const patchThread = useCallback(
    async (body: object) => {
      if (!threadId) return;
      setSendError(null);
      try {
        await api<ThreadDetailDto>(`/threads/${threadId}`, { method: "PATCH", body: JSON.stringify(body) });
        await qc.invalidateQueries({ queryKey: keys.thread(threadId) });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Pengaturan gagal disimpan.");
      }
    },
    [qc, threadId],
  );

  const changeHarness = (h: ThreadHarness) => (threadId ? void patchThread({ harness: h }) : setPendingHarness(h));
  const changeMode = (mode: ApprovalMode) => {
    if (mode === "full" && approvalMode !== "full") return setConfirmFull(true);
    if (threadId) void patchThread({ approvalMode: mode });
    else setPendingMode(mode);
  };

  /* ------------------------------------------------------------------- sending */
  const send = useCallback(
    async (text: string) => {
      setSendError(null);
      const modelId = chosen?.id;
      if (!modelId) throw new Error("Pilih model dulu.");
      try {
        let id = threadId;
        if (!id) {
          if (!workspaceText.trim()) throw new Error("Isi folder workspace dulu.");
          const created = await api<ThreadDetailDto>("/threads", { method: "POST", body: JSON.stringify({ mode: "agent", workspace: workspaceText.trim(), modelId, harness: pendingHarness, approvalMode: pendingMode }) });
          id = created.id;
          try {
            localStorage.setItem(LAST_WORKSPACE_KEY, workspaceText.trim());
          } catch {
            // Remembering the folder is a convenience only.
          }
        }
        const res = await api<SendMessageResponse>(`/threads/${id}/messages`, { method: "POST", body: JSON.stringify({ text, modelId, systemPrompt: draft.systemPrompt, params: draft.params }) });
        try {
          localStorage.setItem(LAST_MODEL_KEY, modelId);
        } catch {
          // Convenience only.
        }
        const threadIdNow = id;
        await qc.fetchQuery({ queryKey: keys.thread(threadIdNow), queryFn: () => api<ThreadDetailDto>(`/threads/${threadIdNow}`), staleTime: 0 });
        attach(res.runId, id);
        void qc.invalidateQueries({ queryKey: ["threads"] });
        void qc.invalidateQueries({ queryKey: keys.workspaces });
        if (!threadId) void navigate({ to: "/agent", search: { t: id } });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : "Pesan gagal dikirim.");
        throw err;
      }
    },
    [attach, chosen?.id, draft.params, draft.systemPrompt, navigate, pendingHarness, pendingMode, qc, threadId, workspaceText],
  );

  const retry = useCallback(() => {
    const text = lastUserText(messages);
    if (text) void send(text).catch(() => {});
  }, [messages, send]);

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
  }, [live?.text, live?.reasoning, live?.approvals.length, live?.asks.length, messages.length, scrollToEnd]);

  /* ---------------------------------------------------------------- rendering */
  const endpoint = chosen ? endpoints.data?.endpoints.find((e) => e.id === chosen.endpointId) : undefined;
  const keyMissing = !!endpoint && endpoint.needsKey && !endpoint.hasKey;
  const noEndpoints = endpoints.isSuccess && endpoints.data.endpoints.length === 0;
  const plan = live?.plan ?? thread.data?.plan ?? [];
  const pendingCount = (live?.approvals.length ?? 0) + (live?.asks.length ?? 0);
  const blockedBecause = !threadId && !workspaceText.trim() ? "Isi folder workspace dulu." : null;

  const inspector = (
    <AgentInspector
      thread={thread.data}
      pendingHarness={pendingHarness}
      onHarness={changeHarness}
      model={chosen}
      onPickModel={() => setPickerOpen(true)}
      onShowProfile={() => chosen && setProfileFor(chosen.id)}
      systemPrompt={draft.systemPrompt}
      onSystemPrompt={(v) => update({ systemPrompt: v })}
      params={draft.params}
      onParams={(p) => update({ params: p })}
      running={running}
    />
  );

  const modeControl = (
    <div className="seg" role="radiogroup" aria-label="Mode izin">
      {APPROVAL_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          role="radio"
          aria-checked={approvalMode === mode}
          disabled={running || (mode === "full" && !threadId)}
          title={mode === "full" && !threadId ? "Bisa dinyalakan setelah thread dibuat" : undefined}
          onClick={() => changeMode(mode)}
        >
          {APPROVAL_MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );

  const harnessSwitch = (
    <button type="button" role="switch" aria-checked={harness.on} disabled={running} className="switch" onClick={() => changeHarness({ ...harness, on: !harness.on })}>
      <span className="switch-track" aria-hidden />
      {harness.on ? "Harness ON" : "Harness OFF"}
    </button>
  );

  const contextMeter =
    live?.context && live.context.window ? (
      <span className="font-code text-meta text-fg-3" title="Perkiraan konteks terpakai dari jendela konteks model">
        {formatTokens(live.context.used)} / {formatTokens(live.context.window)}
      </span>
    ) : null;

  return (
    <div className="flex h-full min-h-0">
      <section className="flex min-w-0 flex-1 flex-col" aria-label="Tugas agent">
        <ThreadHeader
          thread={thread.data}
          fallbackTitle="Tugas baru"
          renaming={renaming}
          setRenaming={setRenaming}
          onDelete={() => setDeleting(true)}
          showInspectorToggle={!wide}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
        >
          {thread.data?.workspace && (
            <span className="hidden max-w-60 items-center gap-1.5 truncate text-dense text-fg-2 md:flex" title={thread.data.workspace}>
              <FolderSimpleIcon size={16} aria-hidden />
              <code className="truncate">{thread.data.workspace}</code>
            </span>
          )}
        </ThreadHeader>

        <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid w-full max-w-[calc(var(--read-max)+3rem)] gap-6 px-4 py-6">
            {threadId && thread.isPending && (
              <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
                <span className="node node-run" aria-hidden />
                Memuat tugas
              </p>
            )}
            {threadId && thread.isError && (
              <div className="grid gap-3 rounded-md bg-danger-soft p-4 text-ui text-danger-text" role="alert">
                <p>{thread.error.message}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-secondary" onClick={() => void thread.refetch()}>
                    Coba lagi
                  </button>
                  <Link to="/agent" className="btn btn-ghost no-underline">
                    Mulai tugas baru
                  </Link>
                </div>
              </div>
            )}

            {!threadId && (
              <NewTask noEndpoints={noEndpoints} value={workspaceText} onChange={setWorkspaceText} recent={recent.data?.workspaces ?? []} />
            )}

            {plan.length > 0 && <PlanPanel items={plan} />}

            {messages.length > 0 && (
              <AgentTimeline
                messages={messages}
                live={live}
                running={running}
                onShowRequest={setLogFor}
                onDecide={(id, d, r) => decide(id, d, r)}
                onAnswer={(id, a) => answer(id, a)}
                onRetry={retry}
                threadId={threadId ?? ""}
                checkpoints={checkpoints.data?.checkpoints ?? []}
                onUndo={(cp) => {
                  setUndoResult(null);
                  setUndoError(null);
                  setUndoing(cp);
                }}
                canRetry={!running}
              />
            )}

            {live?.disconnected && (
              <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
                {live.disconnected}
              </p>
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
              Ke langkah terbaru
            </button>
          )}
        </div>

        {pendingCount > 0 && (
          <div className="mx-auto w-full max-w-[calc(var(--read-max)+3rem)] px-4 pb-2">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md bg-ember-soft px-4 py-2 text-left text-ui text-ember-text"
              onClick={() => document.querySelector<HTMLElement>('[aria-label="Menunggu persetujuan"], [aria-label="Pertanyaan dari agent"]')?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              <span className="node node-wait" aria-hidden />
              <span className="font-semibold">Agent menunggu keputusanmu</span>
              <span className="text-fg-2">({pendingCount}). Klik untuk melihat.</span>
            </button>
          </div>
        )}

        <Composer
          model={chosen}
          onPickModel={() => setPickerOpen(true)}
          running={running}
          keyMissing={keyMissing}
          onSend={send}
          onStop={() => void stop()}
          error={sendError}
          focusSignal={focusSignal}
          placeholder={threadId ? "Arahkan agent, atau tulis tugas berikutnya" : "Jelaskan tugasnya"}
          blockedBecause={blockedBecause}
          extra={
            <>
              {modeControl}
              {harnessSwitch}
            </>
          }
          trailing={contextMeter}
        />
      </section>

      {wide && (
        <aside aria-label="Pengaturan tugas" className="hidden w-[var(--inspector-w)] shrink-0 overflow-y-auto border-l border-line bg-surface xl:block">
          {inspector}
        </aside>
      )}
      {!wide && (
        <Dialog open={inspectorOpen} onClose={() => setInspectorOpen(false)} title="Pengaturan tugas" width="max-w-md">
          {inspector}
        </Dialog>
      )}

      <ModelPickerDialog open={pickerOpen} onClose={() => { setPickerOpen(false); setFocusSignal((n) => n + 1); }} selectedId={chosen?.id ?? null} onSelect={(m) => update({ modelId: m.id })} />
      <ProfileDialog modelId={profileFor} onClose={() => setProfileFor(null)} />
      <RequestLogDialog messageId={logFor} onClose={() => setLogFor(null)} />

      <Dialog
        open={undoing !== null}
        onClose={() => setUndoing(null)}
        title={undoResult ? "Perubahan dibatalkan" : "Batalkan perubahan file dari tugas ini?"}
        width="max-w-lg"
        footer={
          undoResult ? (
            <button type="button" className="btn btn-primary" onClick={() => setUndoing(null)}>
              Tutup
            </button>
          ) : (
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setUndoing(null)}>
                Batal
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  if (!undoing || !threadId) return;
                  setUndoError(null);
                  try {
                    const res = await api<RestoreResponse>(`/threads/${threadId}/checkpoints/${undoing.runMessageId}/restore`, { method: "POST", body: "{}" });
                    setUndoResult(res);
                    void qc.invalidateQueries({ queryKey: keys.checkpoints(threadId) });
                  } catch (err) {
                    setUndoError(err instanceof Error ? err.message : "Gagal mengembalikan file.");
                  }
                }}
              >
                Kembalikan file
              </button>
            </>
          )
        }
      >
        {undoing && !undoResult && (
          <div className="grid gap-3 text-body text-fg-2">
            <p>File di bawah dikembalikan ke isinya sebelum tugas ini dimulai. File yang dibuat tugas ini dihapus. Perubahan sesudahnya pada file yang sama juga ikut hilang.</p>
            <ul className="grid max-h-56 gap-1 overflow-y-auto rounded-sm bg-sunken p-2 font-code text-dense">
              {undoing.files.map((f) => (
                <li key={f.path} className="break-all">
                  {f.created ? "hapus " : "kembalikan "}
                  {f.path}
                  {!f.restorable && <span className="text-danger-text"> (terlalu besar, tidak bisa)</span>}
                </li>
              ))}
            </ul>
            <p className="text-dense text-fg-3">Hanya perubahan lewat tools file EZClaw yang tercatat. Yang diubah lewat perintah shell tidak ikut dikembalikan.</p>
          </div>
        )}
        {undoResult && (
          <div className="grid gap-2 text-body text-fg-2">
            <p>{undoResult.restored.length} file dikembalikan.</p>
            {undoResult.skipped.length > 0 && (
              <ul className="grid gap-1 rounded-sm bg-danger-soft p-2 text-dense text-danger-text">
                {undoResult.skipped.map((s) => (
                  <li key={s.path}>
                    {s.path}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {undoError && (
          <p className="mt-2 rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
            {undoError}
          </p>
        )}
      </Dialog>

      <Dialog
        open={confirmFull}
        onClose={() => setConfirmFull(false)}
        title="Nyalakan Otomatis penuh?"
        width="max-w-md"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmFull(false)}>
              Batal
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => {
                setConfirmFull(false);
                void patchThread({ approvalMode: "full", confirmFull: true });
              }}
            >
              Nyalakan Otomatis penuh
            </button>
          </>
        }
      >
        <div className="grid gap-3 text-body text-fg-2">
          <p>
            Agent akan menulis file dan menjalankan perintah di dalam <code className="break-all">{thread.data?.workspace}</code> tanpa bertanya.
          </p>
          <p>Perintah berisiko (menghapus rekursif, git push --force, dan sejenisnya) dan menulis file di luar workspace tetap meminta izin.</p>
          <p>EZClaw tidak memakai sandbox sistem operasi di Windows, jadi perlindungannya hanya dari daftar di atas dan batas folder.</p>
        </div>
      </Dialog>

      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Hapus tugas ini?"
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
                  void navigate({ to: "/agent" });
                } catch (err) {
                  setDeleting(false);
                  setSendError(err instanceof Error ? err.message : "Tugas gagal dihapus.");
                }
              }}
            >
              Hapus tugas
            </button>
          </>
        }
      >
        <p className="text-body text-fg-2">Riwayat langkah dan catatan request di tugas ini ikut terhapus. File di workspace tidak disentuh.</p>
      </Dialog>
    </div>
  );
}

function NewTask({ noEndpoints, value, onChange, recent }: { noEndpoints: boolean; value: string; onChange: (v: string) => void; recent: string[] }) {
  const id = useId();
  const [check, setCheck] = useState<WorkspaceCheckResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [picking, setPicking] = useState(false);
  // A folder chosen in the picker is already known to exist; only typing clears the check.
  const picked = useRef<string | null>(null);

  useEffect(() => {
    if (value !== picked.current) setCheck(null);
  }, [value]);

  async function verify() {
    setChecking(true);
    try {
      setCheck(await api<WorkspaceCheckResponse>("/workspaces/check", { method: "POST", body: JSON.stringify({ path: value.trim() }) }));
    } catch (err) {
      setCheck({ ok: false, message: err instanceof Error ? err.message : "Folder tidak bisa diperiksa." });
    } finally {
      setChecking(false);
    }
  }

  if (noEndpoints) {
    return (
      <div className="grid gap-3 py-8">
        <h1 className="text-hero font-semibold">Belum ada model</h1>
        <p className="text-body text-fg-2">Agent butuh model yang mendukung tool calling. Tambahkan endpoint dulu.</p>
        <Link to="/settings/endpoints" className="btn btn-primary justify-self-start no-underline">
          Tambah endpoint
        </Link>
      </div>
    );
  }

  return (
    <section className="grid gap-4 py-6" aria-labelledby="new-task">
      <h1 id="new-task" className="text-hero font-semibold">
        Mulai tugas agent
      </h1>
      <p className="max-w-prose text-body text-fg-2">Agent bekerja di satu folder: membaca dan mengubah file di sana, dan menjalankan perintah. Pilih foldernya, lalu jelaskan tugasnya di bawah.</p>
      <div className="grid gap-2">
        <label htmlFor={id} className="text-dense font-semibold">
          Folder workspace
        </label>
        <div className="flex flex-wrap gap-2">
          <input id={id} className="input min-w-60 flex-1 font-code" value={value} placeholder="F:\proyek\aplikasi" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
          <button type="button" className="btn btn-primary" onClick={() => setPicking(true)}>
            <FolderSimpleIcon size={16} aria-hidden />
            Pilih folder
          </button>
          <button type="button" className="btn btn-secondary" disabled={!value.trim() || checking} onClick={() => void verify()}>
            {checking ? "Memeriksa" : "Periksa"}
          </button>
        </div>
        <FolderPicker
          open={picking}
          onClose={() => setPicking(false)}
          initial={value.trim() || recent[0] || null}
          recent={recent}
          onPick={(p) => {
            picked.current = p;
            onChange(p);
            setPicking(false);
            setCheck({ ok: true, root: p });
          }}
        />
        {check && (
          <p className={check.ok ? "text-dense text-fg-2" : "rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text"} role={check.ok ? "status" : "alert"}>
            {check.ok ? `Folder ditemukan: ${check.root}` : check.message}
          </p>
        )}
        <p className="text-meta text-fg-3">Pilih lewat tombol, atau ketik path absolut.</p>
      </div>
      {recent.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-dense font-semibold">Baru dipakai</span>
          <ul className="grid gap-1">
            {recent.map((w) => (
              <li key={w}>
                <button type="button" className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-dense hover:bg-sunken" onClick={() => onChange(w)} aria-pressed={value === w}>
                  <FolderSimpleIcon size={16} aria-hidden />
                  <code className="break-all">{w}</code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
