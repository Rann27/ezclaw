import {
  DEFAULT_LOOP,
  type AgentLoopConfig,
  type ApprovalMode,
  type CanonicalMessage,
  type ChatParams,
  type PlanItem,
  type ApprovalRequest,
  type Part,
  type RunEvent,
  type RunStopReason,
  type ThreadHarness,
  type Usage,
} from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { threads } from "../db/schema.js";
import { callModel, newAccumulator, type ModelCallDeps, type TurnAccumulator } from "../provider/call.js";
import { ProviderError } from "../provider/http.js";
import { decide, type ApprovalRules } from "./approvals.js";
import { loadProjectInstructions, renderSystemPrompt, type HarnessService } from "./harness.js";
import { defaultShell, type ShellKind } from "./shell.js";
import { insertMessage, loadHistoryEntries, touchThread, updateMessage, type HistoryEntry } from "./store.js";
import { clipOutput, selectTools, ToolArgError, type ToolEnv, type ToolImpl } from "./tools.js";
import { Workspace } from "./workspace.js";

/** What the loop needs from the run it belongs to. */
export interface RunHandle {
  /** Aborts when the owner presses Stop. */
  readonly signal: AbortSignal;
  emit(event: RunEvent): void;
  approve(request: ApprovalRequest, callId: string): Promise<{ decision: "allow" | "allow_always" | "deny"; reason?: string }>;
  ask(callId: string, question: string, options?: string[]): Promise<string>;
}

export interface AgentDeps extends ModelCallDeps {
  rules: ApprovalRules;
  harness: HarnessService;
  codexDir: () => string | null;
}

export interface AgentRunInput {
  threadId: string;
  modelRowId: string;
  params: ChatParams;
  approvalMode: ApprovalMode;
  workspace: string;
  harness: ThreadHarness;
  /** The thread's own system prompt. */
  userPrompt: string;
}

export interface AgentResult {
  status: "complete" | "stopped" | "error";
  error?: string;
  stopReason?: RunStopReason;
  finishReason?: string;
}

const RESERVED_FOR_REPLY = 0.1;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageChars(m: CanonicalMessage): number {
  let n = 0;
  for (const p of m.parts) {
    if (p.type === "text" || p.type === "reasoning") n += p.text.length;
    else if (p.type === "tool_call") n += JSON.stringify(p.args ?? {}).length + p.name.length;
    else if (p.type === "tool_result") n += p.output.length;
  }
  return n;
}

function estimateHistory(history: CanonicalMessage[], system: string | undefined): number {
  const chars = history.reduce((n, m) => n + messageChars(m), 0) + (system?.length ?? 0);
  return Math.ceil(chars / 3.5);
}

function osName(): string {
  return process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
}

function describeError(err: unknown): string {
  if (err instanceof ProviderError || err instanceof Error) return err.message;
  return String(err);
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (err instanceof Error && err.name === "AbortError");
}

export async function runAgent(deps: AgentDeps, run: RunHandle, input: AgentRunInput): Promise<AgentResult> {
  const { db, registry, harness: harnessService } = deps;
  const model = registry.resolveModel(input.modelRowId);
  const modelProfile = model.resolved.profile;

  const profile = harnessService.require(input.harness.profileId);
  const shell: ShellKind = defaultShell();
  const ws = new Workspace(input.workspace);
  const harnessOn = input.harness.on;
  const loop: AgentLoopConfig = harnessOn ? profile.loop : { ...DEFAULT_LOOP };
  const toolNames = harnessOn ? profile.tools : input.harness.tools;
  const tools = selectTools(toolNames, shell);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  let system: string | undefined;
  if (harnessOn) {
    system = renderSystemPrompt(
      profile,
      {
        date: new Date().toLocaleDateString("sv-SE"),
        os: osName(),
        shell,
        workspace: ws.root,
        approval: input.approvalMode,
        modelId: model.row.modelId,
        userPrompt: input.userPrompt,
        codexDir: deps.codexDir(),
      },
      loadProjectInstructions(ws.root, profile.projectInstructions),
    );
  } else {
    system = input.userPrompt.trim() || undefined;
  }

  if (tools.length && !modelProfile.tools) {
    run.emit({ type: "note", text: "Profil model ini belum menyatakan dukungan tools. Agent tetap mencoba; jika provider menolak, atur lewat Profil model." });
  }

  const setPlan = (items: PlanItem[]) => {
    db.update(threads).set({ plan: items }).where(eq(threads.id, input.threadId)).run();
    run.emit({ type: "plan", items });
  };

  let lastUsage: Usage | null = null;
  let sinceLastCall = 0;
  let finishReason: string | undefined;

  for (let step = 1; ; step++) {
    if (run.signal.aborted) return { status: "stopped" };
    if (step > loop.maxSteps) {
      const text = `Berhenti setelah ${loop.maxSteps} langkah (batas run). Kirim pesan lagi jika pekerjaan perlu dilanjutkan.`;
      insertMessage(db, { threadId: input.threadId, role: "assistant", parts: [{ type: "text", text }], status: "complete" });
      run.emit({ type: "note", text });
      return { status: "complete", stopReason: "max_steps", finishReason };
    }

    const placeholder = insertMessage(db, { threadId: input.threadId, role: "assistant", parts: [{ type: "text", text: "" }], status: "streaming", modelLabel: `${model.endpoint.name} / ${model.row.modelId}` });
    run.emit({ type: "step_start", messageId: placeholder.id, step });
    const started = Date.now();

    /* ---- keep the conversation inside the context window */
    let entries = loadHistoryEntries(db, input.threadId);
    const window = modelProfile.contextLength;
    if (window) {
      const estimated = lastUsage ? (lastUsage.inputTokens ?? 0) + (lastUsage.outputTokens ?? 0) + sinceLastCall : estimateHistory(entries.map((e) => e.message), system);
      run.emit({ type: "context", usedTokens: estimated, windowTokens: window });
      if (estimated > window * Math.min(loop.compactAt, 1 - RESERVED_FOR_REPLY) && entries.length > 6) {
        if (await compactHistory(deps, run, input, entries, placeholder.id)) {
          entries = loadHistoryEntries(db, input.threadId);
          lastUsage = null;
          sinceLastCall = 0;
        }
      }
    } else {
      run.emit({ type: "context", usedTokens: 0, windowTokens: null });
    }

    /* ---- ask the model */
    const history = entries.map((e) => e.message);
    const acc = newAccumulator();
    let failure: unknown = null;
    try {
      await callModel(
        deps,
        {
          modelRowId: input.modelRowId,
          params: input.params,
          system,
          messages: history,
          tools: tools.map((t) => t.def),
          logMessageId: placeholder.id,
          signal: run.signal,
          onText: (delta) => run.emit({ type: "text", delta }),
          onReasoning: (delta) => run.emit({ type: "reasoning", delta }),
          onNote: (text) => run.emit({ type: "note", text }),
          onUsage: (usage) => run.emit({ type: "usage", usage }),
        },
        acc,
      );
    } catch (err) {
      failure = err;
    }

    const stopped = isAbort(failure, run.signal);
    const parts = turnParts(acc);
    const calls = parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call");
    const text = acc.text.join("");

    updateMessage(db, placeholder.id, {
      parts: parts.length ? parts : [{ type: "text", text: "" }],
      status: stopped ? "stopped" : failure ? "error" : "complete",
      error: failure && !stopped ? describeError(failure) : null,
      notes: acc.notes,
      usage: Object.keys(acc.usage).length ? acc.usage : null,
      finishReason: acc.finish,
      modelLabel: acc.modelLabel,
      durationMs: Date.now() - started,
      raw: acc.raw ?? null,
    });
    touchThread(db, input.threadId);
    run.emit({ type: "step_end", messageId: placeholder.id });
    if (Object.keys(acc.usage).length) {
      lastUsage = acc.usage;
      sinceLastCall = 0;
    }
    finishReason = acc.finish ?? finishReason;

    if (stopped) return { status: "stopped", finishReason };
    if (failure) return { status: "error", error: describeError(failure), finishReason };
    if (!calls.length) {
      if (acc.finish === "length" && !text) return { status: "error", error: "Jawaban terpotong sebelum model sempat menulis apa pun. Naikkan max_output_tokens di panel parameter.", finishReason };
      return { status: "complete", finishReason };
    }

    /* ---- run the tools it asked for */
    for (const c of calls) run.emit({ type: "tool_call", callId: c.callId, name: c.name, args: c.args, ...(c.argsError ? { argsError: c.argsError } : {}) });

    const baseEnv = { workspace: ws, config: loop, shell, signal: run.signal, setPlan };
    const results = await executeCalls(deps, run, input, baseEnv, toolMap, calls, loop);
    insertMessage(db, { threadId: input.threadId, role: "tool", parts: results, status: "complete" });
    sinceLastCall = estimateTokens("x".repeat(results.reduce((n, r) => n + (r.type === "tool_result" ? r.output.length : 0), 0)));

    if (run.signal.aborted) return { status: "stopped", finishReason };
  }
}

function turnParts(acc: TurnAccumulator): Part[] {
  const parts: Part[] = [];
  const reasoning = acc.reasoning.join("");
  if (reasoning || acc.signature) parts.push({ type: "reasoning", text: reasoning, ...(acc.signature ? { signature: acc.signature } : {}) });
  const text = acc.text.join("");
  if (text) parts.push({ type: "text", text });
  for (const c of acc.toolCalls) {
    try {
      const parsed: unknown = JSON.parse(c.argsText || "{}");
      parts.push({ type: "tool_call", callId: c.callId, name: c.name, args: parsed });
    } catch (err) {
      parts.push({ type: "tool_call", callId: c.callId, name: c.name, args: {}, argsError: err instanceof Error ? err.message : "JSON tidak valid" });
    }
  }
  return parts;
}

type ToolCallPart = Extract<Part, { type: "tool_call" }>;
type ToolResultPart = Extract<Part, { type: "tool_result" }>;

async function executeCalls(
  deps: AgentDeps,
  run: RunHandle,
  input: AgentRunInput,
  baseEnv: Omit<ToolEnv, "ask">,
  toolMap: Map<string, ToolImpl>,
  calls: ToolCallPart[],
  loop: AgentLoopConfig,
): Promise<ToolResultPart[]> {
  const finish = (call: ToolCallPart, ok: boolean, output: string, started: number, extra: { denied?: boolean } = {}): ToolResultPart => {
    const clipped = clipOutput(output, loop.toolOutputLimit);
    const durationMs = Date.now() - started;
    run.emit({ type: "tool_result", callId: call.callId, name: call.name, ok, output: clipped.text, durationMs, truncated: clipped.truncated, ...(extra.denied ? { denied: true } : {}) });
    return { type: "tool_result", callId: call.callId, name: call.name, output: clipped.text, ...(ok ? {} : { isError: true }), ...(extra.denied ? { denied: true } : {}) };
  };

  // Prepare every call first, so bad arguments are reported without waiting on anyone.
  type Slot = { call: ToolCallPart; tool: ToolImpl | null; prepared: ReturnType<ToolImpl["prepare"]> | null; error: string | null };
  const slots: Slot[] = calls.map((call) => {
    const tool = toolMap.get(call.name) ?? null;
    if (!tool) return { call, tool, prepared: null, error: `Tool "${call.name}" tidak tersedia. Tool yang ada: ${[...toolMap.keys()].join(", ") || "(tidak ada)"}.` };
    if (call.argsError) return { call, tool, prepared: null, error: `Argumen bukan JSON yang valid (${call.argsError}). Kirim ulang dengan JSON yang benar.` };
    const env: ToolEnv = { ...baseEnv, ask: (question, options) => run.ask(call.callId, question, options) };
    try {
      return { call, tool, prepared: tool.prepare(call.args, env), error: null };
    } catch (err) {
      return { call, tool, prepared: null, error: err instanceof ToolArgError ? err.message : `Tool gagal disiapkan: ${describeError(err)}` };
    }
  });

  const results = new Map<string, ToolResultPart>();
  const runOne = async (slot: Slot): Promise<ToolResultPart> => {
    const started = Date.now();
    const { call } = slot;
    if (slot.error || !slot.prepared) return finish(call, false, slot.error ?? "Tool tidak bisa dijalankan.", started);
    if (run.signal.aborted) return finish(call, false, "Dihentikan sebelum tool ini dijalankan.", started);

    const need = slot.prepared.need;
    if (decide(need, input.approvalMode, deps.rules, input.workspace) === "ask" && need) {
      let answer: Awaited<ReturnType<RunHandle["approve"]>>;
      try {
        answer = await run.approve(need.request, call.callId);
      } catch {
        return finish(call, false, "Dihentikan sebelum ada keputusan izin.", started);
      }
      if (run.signal.aborted) return finish(call, false, "Dihentikan sebelum ada keputusan izin.", started);
      if (answer.decision === "deny") {
        const why = answer.reason?.trim() ? ` Alasan: ${answer.reason.trim()}` : "";
        return finish(call, false, `Pengguna menolak izin untuk tool ini.${why} Jangan coba mencapai hasil yang sama dengan cara lain; ubah rencana atau tanyakan.`, started, { denied: true });
      }
      if (answer.decision === "allow_always" && need.request.rulePattern) deps.rules.add(input.workspace, need.request.rulePattern);
    }

    run.emit({ type: "tool_start", callId: call.callId });
    try {
      const outcome = await slot.prepared.run();
      return finish(call, !outcome.isError, outcome.output, started);
    } catch (err) {
      if (run.signal.aborted) return finish(call, false, "Dihentikan oleh pengguna.", started);
      const message = err instanceof ToolArgError ? err.message : `Tool gagal: ${describeError(err)}`;
      return finish(call, false, message, started);
    }
  };

  const allReadOnly = slots.every((s) => s.tool?.readOnly && !s.prepared?.need);
  if (allReadOnly && slots.length > 1) {
    const done = await Promise.all(slots.map(runOne));
    done.forEach((r) => results.set(r.callId, r));
  } else {
    for (const slot of slots) results.set(slot.call.callId, await runOne(slot));
  }
  return calls.map((c) => results.get(c.callId)!);
}

const SUMMARY_SYSTEM = `You compress a long working session between a user and a coding agent so the agent can continue it with less context. Write a faithful summary in the language the user used. Include: the user's goal and constraints, decisions made, files created or changed (paths), commands run and their important results, errors found and how they were fixed, the current state, and what remains to do. Keep exact names, paths, and numbers. Do not invent anything. Do not address the user.`;

/** Replaces the oldest part of the conversation with a model-written summary. Returns false if it could not. */
async function compactHistory(deps: AgentDeps, run: RunHandle, input: AgentRunInput, entries: HistoryEntry[], logMessageId: string): Promise<boolean> {
  const { db } = deps;
  // Keep the latest few messages as they are; never start the kept part on a tool result.
  let cut = Math.max(1, entries.length - 6);
  while (cut > 0 && entries[cut]?.message.role === "tool") cut--;
  if (cut < 2) return false;

  const toSummarize = entries.slice(0, cut).map((e) => e.message);
  const transcript = toSummarize
    .map((m) => {
      if (m.role === "user") return `USER: ${m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}`;
      if (m.role === "assistant") {
        return `ASSISTANT: ${m.parts
          .map((p) => (p.type === "text" ? p.text : p.type === "tool_call" ? `[memanggil ${p.name} ${JSON.stringify(p.args).slice(0, 300)}]` : ""))
          .join("")}`;
      }
      return `TOOL RESULT: ${m.parts.map((p) => (p.type === "tool_result" ? `${p.name}: ${p.output.slice(0, 1500)}` : "")).join(" | ")}`;
    })
    .join("\n\n");

  const acc = newAccumulator();
  try {
    await callModel(
      deps,
      {
        modelRowId: input.modelRowId,
        params: { max_output_tokens: 4000 },
        system: SUMMARY_SYSTEM,
        messages: [{ role: "user", parts: [{ type: "text", text: `Summarize this session:\n\n${transcript.slice(0, 400_000)}` }] }],
        logMessageId,
        signal: run.signal,
        onText: () => {},
        onReasoning: () => {},
        onNote: () => {},
        onUsage: () => {},
      },
      acc,
    );
  } catch {
    run.emit({ type: "note", text: "Ringkasan otomatis gagal dibuat, jadi riwayat dikirim apa adanya." });
    return false;
  }
  const summary = acc.text.join("").trim();
  if (!summary) return false;

  const previous = db.select({ seq: threads.summarySeq }).from(threads).where(eq(threads.id, input.threadId)).get()?.seq ?? 0;
  const lastSummarised = entries[cut - 1]?.seq ?? 0;
  db.update(threads)
    .set({ summary, summarySeq: Math.max(previous, lastSummarised) })
    .where(eq(threads.id, input.threadId))
    .run();
  run.emit({ type: "compaction", before: toSummarize.length, after: 1 });
  run.emit({ type: "note", text: `Riwayat dipadatkan: ${toSummarize.length} pesan lama diganti ringkasan supaya muat di konteks model.` });
  return true;
}
