import { randomUUID } from "node:crypto";
import type {
  ApprovalMode,
  ApprovalRequest,
  CanonicalMessage,
  ChatParams,
  FinishReason,
  Part,
  RunEvent,
  RunStopReason,
  ThreadHarness,
} from "@ezclaw/core";
import { compactHistory, runAgent, type RunHandle } from "./agent/loop.js";
import { loadHistoryEntries } from "./agent/store.js";
import { touchThread, updateMessage } from "./agent/store.js";
import type { Db } from "./db/client.js";
import { runImage, type ImageRunDeps, type ImageRunInput, type ImageRunResult } from "./imageRun.js";
import { callModel, newAccumulator, type TurnAccumulator } from "./provider/call.js";
import { ProviderError } from "./provider/http.js";

const KEEP_FINISHED_RUN_MS = 5 * 60_000;
/** Share of the context window at which a chat thread is compacted. */
const CHAT_COMPACT_AT = 0.8;

export interface ChatRunInput {
  threadId: string;
  assistantMessageId: string;
  modelRowId: string;
  system: string | undefined;
  params: ChatParams;
  history: CanonicalMessage[];
}

export interface AgentRunStart {
  threadId: string;
  modelRowId: string;
  params: ChatParams;
  approvalMode: ApprovalMode;
  workspace: string;
  harness: ThreadHarness;
  userPrompt: string;
  /** The user message that started this run. */
  startMessageId: string;
}

type Decision = { decision: "allow" | "allow_always" | "deny"; reason?: string };

type Pending =
  | { kind: "approval"; resolve: (d: Decision) => void }
  | { kind: "ask"; resolve: (answer: string) => void; reject: (err: Error) => void };

interface ActiveRun {
  id: string;
  threadId: string;
  messageId: string;
  events: RunEvent[];
  listeners: Set<() => void>;
  done: boolean;
  abort: AbortController;
  stopRequested: boolean;
  pendings: Map<string, Pending>;
  /** Settles once the answer has been saved, so shutdown can wait for it. */
  finished: Promise<void>;
}

export interface RunSnapshot {
  events: RunEvent[];
  done: boolean;
}

function describeError(err: unknown): string {
  return err instanceof ProviderError || err instanceof Error ? err.message : String(err);
}

function stopError(): Error {
  const e = new Error("Dihentikan oleh pengguna.");
  e.name = "AbortError";
  return e;
}

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly byThread = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly agent: ImageRunDeps,
  ) {}

  activeForThread(threadId: string): { runId: string; messageId: string } | null {
    const id = this.byThread.get(threadId);
    const run = id ? this.runs.get(id) : undefined;
    return run && !run.done ? { runId: run.id, messageId: run.messageId } : null;
  }

  private create(threadId: string, messageId: string): ActiveRun {
    const run: ActiveRun = {
      id: randomUUID(),
      threadId,
      messageId,
      events: [],
      listeners: new Set(),
      done: false,
      abort: new AbortController(),
      stopRequested: false,
      pendings: new Map(),
      finished: Promise.resolve(),
    };
    this.runs.set(run.id, run);
    this.byThread.set(threadId, run.id);
    this.emit(run, { type: "start", messageId });
    return run;
  }

  startChat(input: ChatRunInput): string {
    const run = this.create(input.threadId, input.assistantMessageId);
    run.finished = this.executeChat(run, input);
    return run.id;
  }

  startAgent(input: AgentRunStart): string {
    const run = this.create(input.threadId, input.startMessageId);
    run.finished = this.executeAgent(run, input);
    return run.id;
  }

  startImage(input: ImageRunInput): string {
    const run = this.create(input.threadId, input.assistantMessageId);
    run.finished = this.executeImage(run, input);
    return run.id;
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.done) return false;
    run.stopRequested = true;
    run.abort.abort();
    // Anything waiting on the owner stops waiting.
    for (const [id, p] of run.pendings) {
      if (p.kind === "approval") p.resolve({ decision: "deny", reason: "Run dihentikan." });
      else p.reject(stopError());
      run.pendings.delete(id);
    }
    return true;
  }

  /** Aborts every running response and waits until each partial answer is saved. Used on shutdown. */
  async stopAll(): Promise<void> {
    this.agent.processes.stopAll();
    const pending = [...this.runs.values()].filter((r) => !r.done);
    for (const run of pending) this.stop(run.id);
    await Promise.allSettled(pending.map((r) => r.finished));
  }

  resolveApproval(runId: string, approvalId: string, decision: Decision): boolean {
    const run = this.runs.get(runId);
    const pending = run?.pendings.get(approvalId);
    if (!run || !pending || pending.kind !== "approval") return false;
    run.pendings.delete(approvalId);
    this.emit(run, { type: "approval_resolved", approvalId, decision: decision.decision });
    pending.resolve(decision);
    return true;
  }

  answerAsk(runId: string, askId: string, answer: string): boolean {
    const run = this.runs.get(runId);
    const pending = run?.pendings.get(askId);
    if (!run || !pending || pending.kind !== "ask") return false;
    run.pendings.delete(askId);
    this.emit(run, { type: "ask_resolved", askId });
    pending.resolve(answer);
    return true;
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Events from `after` on. */
  snapshot(runId: string, after: number): RunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return { events: run.events.slice(after), done: run.done };
  }

  onChange(runId: string, listener: () => void): (() => void) | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  private emit(run: ActiveRun, event: RunEvent) {
    run.events.push(event);
    for (const l of run.listeners) l();
  }

  private finish(run: ActiveRun) {
    run.done = true;
    for (const l of run.listeners) l();
    setTimeout(() => {
      this.runs.delete(run.id);
      if (this.byThread.get(run.threadId) === run.id) this.byThread.delete(run.threadId);
    }, KEEP_FINISHED_RUN_MS).unref();
  }

  private handle(run: ActiveRun): RunHandle {
    return {
      signal: run.abort.signal,
      emit: (event) => this.emit(run, event),
      approve: (request: ApprovalRequest, callId: string) =>
        new Promise<Decision>((resolve) => {
          const approvalId = randomUUID();
          run.pendings.set(approvalId, { kind: "approval", resolve });
          this.emit(run, { type: "approval", approvalId, callId, request });
        }),
      ask: (callId, question, options) =>
        new Promise<string>((resolve, reject) => {
          const askId = randomUUID();
          run.pendings.set(askId, { kind: "ask", resolve, reject });
          this.emit(run, { type: "ask", askId, callId, question, ...(options ? { options } : {}) });
        }),
    };
  }

  private async executeChat(run: ActiveRun, input: ChatRunInput) {
    const started = Date.now();
    const acc: TurnAccumulator = newAccumulator();
    let status: "complete" | "stopped" | "error" = "complete";
    let errorMessage: string | null = null;

    try {
      const history = await this.fitChatHistory(run, input);
      await callModel(
        this.agent,
        {
          modelRowId: input.modelRowId,
          params: input.params,
          system: input.system,
          messages: history,
          logMessageId: input.assistantMessageId,
          signal: run.abort.signal,
          onText: (delta) => this.emit(run, { type: "text", delta }),
          onReasoning: (delta) => this.emit(run, { type: "reasoning", delta }),
          onNote: (text) => this.emit(run, { type: "note", text }),
          onUsage: (usage) => this.emit(run, { type: "usage", usage }),
        },
        acc,
      );
    } catch (err) {
      if (run.stopRequested || run.abort.signal.aborted) status = "stopped";
      else {
        status = "error";
        errorMessage = describeError(err);
        if (!(err instanceof ProviderError)) console.error(err);
      }
    }

    const parts: Part[] = [];
    const reasoning = acc.reasoning.join("");
    if (reasoning) parts.push({ type: "reasoning", text: reasoning, ...(acc.signature ? { signature: acc.signature } : {}) });
    parts.push({ type: "text", text: acc.text.join("") });

    updateMessage(this.db, input.assistantMessageId, {
      parts,
      status,
      error: errorMessage,
      notes: acc.notes,
      usage: Object.keys(acc.usage).length ? acc.usage : null,
      finishReason: acc.finish,
      modelLabel: acc.modelLabel,
      durationMs: Date.now() - started,
      raw: acc.raw ?? null,
    });
    touchThread(this.db, input.threadId);

    const finishReason: FinishReason | null = acc.finish;
    this.emit(run, { type: "done", status, ...(finishReason ? { finishReason } : {}), ...(errorMessage ? { error: errorMessage } : {}) });
    this.finish(run);
  }

  private async executeImage(run: ActiveRun, input: ImageRunInput) {
    let result: ImageRunResult;
    try {
      result = await runImage(this.agent, { signal: run.abort.signal, emit: (e) => this.emit(run, e) }, input);
    } catch (err) {
      if (run.stopRequested || run.abort.signal.aborted) result = { status: "stopped" };
      else {
        result = { status: "error", error: describeError(err) };
        if (!(err instanceof ProviderError)) console.error(err);
      }
    }
    touchThread(this.db, input.threadId);
    this.emit(run, { type: "done", status: result.status, ...(result.error ? { error: result.error } : {}) });
    this.finish(run);
  }

  /**
   * Chat keeps the whole conversation, so a long thread would eventually overflow the model's window.
   * When it gets close, the oldest part is replaced by a summary (the same compaction Agent uses).
   */
  private async fitChatHistory(run: ActiveRun, input: ChatRunInput): Promise<CanonicalMessage[]> {
    const window = this.agent.registry.resolveModel(input.modelRowId).resolved.profile.contextLength;
    if (!window) return input.history;
    const chars = input.history.reduce((n, m) => n + m.parts.reduce((k, p) => k + (p.type === "text" || p.type === "reasoning" ? p.text.length : 0), 0), 0) + (input.system?.length ?? 0);
    if (chars / 3.5 < window * CHAT_COMPACT_AT || input.history.length <= 6) return input.history;
    const entries = loadHistoryEntries(this.db, input.threadId);
    const handle = { signal: run.abort.signal, emit: (e: RunEvent) => this.emit(run, e) };
    if (!(await compactHistory(this.agent, handle, { threadId: input.threadId, modelRowId: input.modelRowId }, entries, input.assistantMessageId))) return input.history;
    return loadHistoryEntries(this.db, input.threadId).map((e) => e.message);
  }

  private async executeAgent(run: ActiveRun, input: AgentRunStart) {
    let status: "complete" | "stopped" | "error" = "complete";
    let error: string | undefined;
    let stopReason: RunStopReason | undefined;
    let finishReason: string | undefined;

    try {
      const result = await runAgent(this.agent, this.handle(run), {
        threadId: input.threadId,
        modelRowId: input.modelRowId,
        params: input.params,
        approvalMode: input.approvalMode,
        workspace: input.workspace,
        harness: input.harness,
        userPrompt: input.userPrompt,
        runMessageId: input.startMessageId,
      });
      status = result.status;
      error = result.error;
      stopReason = result.stopReason;
      finishReason = result.finishReason;
    } catch (err) {
      if (run.stopRequested || run.abort.signal.aborted) status = "stopped";
      else {
        status = "error";
        error = describeError(err);
        if (!(err instanceof ProviderError)) console.error(err);
      }
    }

    touchThread(this.db, input.threadId);
    this.emit(run, {
      type: "done",
      status,
      ...(finishReason ? { finishReason: finishReason as FinishReason } : {}),
      ...(error ? { error } : {}),
      ...(stopReason ? { stopReason } : {}),
    });
    this.finish(run);
  }
}
