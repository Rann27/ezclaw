import type { MessageDto, Part, PlanItem, Usage } from "@ezclaw/core";
import { CaretRightIcon, CodeIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useMemo } from "react";
import { AskPanel, ApprovalPanel, DiffView } from "./Interactions";
import type { CallStatus, LiveAgent, LiveApproval, LiveAsk, LiveCall } from "./useAgentRun";

const Markdown = lazy(() => import("../Markdown").then((m) => ({ default: m.Markdown })));

type ToolCallPart = Extract<Part, { type: "tool_call" }>;
type ToolResultPart = Extract<Part, { type: "tool_result" }>;

export interface CallView {
  callId: string;
  name: string;
  args: unknown;
  argsError?: string;
  status: CallStatus;
  output?: string;
  durationMs?: number;
  approval?: LiveApproval;
  ask?: LiveAsk;
}

function textOf(m: MessageDto): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function reasoningOf(m: MessageDto): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

/** What a tool call is about, in a few words. */
export function describeCall(name: string, args: unknown): string {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  switch (name) {
    case "read_file":
      return `${str("path")}${a.start_line ? `:${a.start_line}${a.end_line ? `-${a.end_line}` : ""}` : ""}`;
    case "list_dir":
      return str("path") || ".";
    case "search":
      return `/${str("pattern")}/${str("path") ? ` di ${str("path")}` : ""}${str("glob") ? ` (${str("glob")})` : ""}`;
    case "write_file":
    case "edit_file":
      return str("path");
    case "apply_patch":
      return "patch";
    case "shell":
      return str("command");
    case "exec_command":
      return str("cmd");
    case "update_plan":
      return "memperbarui rencana";
    case "ask_user":
      return str("question");
    default:
      return "";
  }
}

const NODE: Record<CallStatus, string> = {
  pending: "node-skip",
  waiting: "node-wait",
  running: "node-run",
  done: "node-done",
  error: "node-fail",
  denied: "node-skip",
};

const STATUS_LABEL: Record<CallStatus, string> = {
  pending: "Menunggu giliran",
  waiting: "Menunggu kamu",
  running: "Berjalan",
  done: "Selesai",
  error: "Gagal",
  denied: "Ditolak",
};

function ToolCallCard({
  call,
  onDecide,
  onAnswer,
}: {
  call: CallView;
  onDecide: (approvalId: string, decision: "allow" | "allow_always" | "deny", reason?: string) => Promise<void>;
  onAnswer: (askId: string, answer: string) => Promise<void>;
}) {
  const summary = describeCall(call.name, call.args);
  const open = call.status === "waiting" || call.status === "error" || call.status === "denied";
  const argsText = useMemo(() => {
    try {
      return JSON.stringify(call.args, null, 2);
    } catch {
      return String(call.args);
    }
  }, [call.args]);

  return (
    <div className="relative grid gap-2">
      <span className={`node ${NODE[call.status]} absolute top-3 -left-5`} aria-hidden />
      <details open={open} className="rounded-sm border border-line bg-surface">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-dense">
          <CaretRightIcon size={12} aria-hidden className="chev text-fg-3" />
          <code className="font-semibold">{call.name}</code>
          <span className="min-w-0 flex-1 truncate text-fg-2">{summary}</span>
          <span className={call.status === "waiting" ? "text-ember-text" : call.status === "error" ? "text-danger-text" : "text-fg-3"}>
            {STATUS_LABEL[call.status]}
            {call.durationMs !== undefined && call.status !== "waiting" ? `, ${(call.durationMs / 1000).toFixed(1)} dtk` : ""}
          </span>
        </summary>
        <div className="grid gap-2 border-t border-line px-3 py-2">
          {call.argsError && (
            <p className="rounded-sm bg-danger-soft px-3 py-2 text-dense text-danger-text" role="alert">
              Argumen dari model bukan JSON valid: {call.argsError}
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-meta text-fg-3">Argumen</summary>
            <pre className="m-0 mt-1 max-h-48 overflow-auto rounded-sm bg-sunken p-2 font-code text-meta whitespace-pre-wrap break-words">{argsText}</pre>
          </details>
          {call.output !== undefined && (
            <div className="grid gap-1">
              <span className="text-meta text-fg-3">Hasil</span>
              <pre className="m-0 max-h-72 overflow-auto rounded-sm bg-sunken p-2 font-code text-meta whitespace-pre-wrap break-words">{call.output || "(kosong)"}</pre>
            </div>
          )}
        </div>
      </details>
      {call.approval && <ApprovalPanel approval={call.approval} onDecide={(d, r) => onDecide(call.approval!.approvalId, d, r)} />}
      {call.ask && <AskPanel ask={call.ask} onAnswer={(a) => onAnswer(call.ask!.askId, a)} />}
    </div>
  );
}

function formatUsage(u: Usage | null): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.inputTokens !== undefined) parts.push(`${u.inputTokens} masuk`);
  if (u.outputTokens !== undefined) parts.push(`${u.outputTokens} keluar`);
  if (u.reasoningTokens) parts.push(`${u.reasoningTokens} reasoning`);
  return parts.length ? `${parts.join(" · ")} token` : null;
}

export function PlanPanel({ items }: { items: PlanItem[] }) {
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <section aria-labelledby="plan-title" className="grid gap-2 rounded-md border border-line bg-surface p-4">
      <h3 id="plan-title" className="flex items-center justify-between text-dense font-semibold">
        Rencana
        <span className="font-normal text-fg-3">
          {done} dari {items.length} selesai
        </span>
      </h3>
      <ol className="grid gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-ui">
            <span className={`node mt-1.5 ${item.status === "completed" ? "node-done" : item.status === "in_progress" ? "node-run" : "node-skip"}`} aria-hidden />
            <span className={item.status === "completed" ? "text-fg-3 line-through" : item.status === "in_progress" ? "font-semibold" : "text-fg-2"}>{item.text}</span>
            <span className="sr-only">
              {item.status === "completed" ? " (selesai)" : item.status === "in_progress" ? " (sedang dikerjakan)" : " (belum)"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface TimelineProps {
  messages: MessageDto[];
  live: LiveAgent | null;
  /** True while the thread has a run, even before its stream has attached. */
  running: boolean;
  onShowRequest: (messageId: string) => void;
  onDecide: (approvalId: string, decision: "allow" | "allow_always" | "deny", reason?: string) => Promise<void>;
  onAnswer: (askId: string, answer: string) => Promise<void>;
  onRetry: () => void;
  canRetry: boolean;
}

export function AgentTimeline({ messages, live, running, onShowRequest, onDecide, onAnswer, onRetry, canRetry }: TimelineProps) {
  // Results saved with the thread, keyed by the call they answer.
  const saved = useMemo(() => {
    const map = new Map<string, ToolResultPart>();
    for (const m of messages) if (m.role === "tool") for (const p of m.parts) if (p.type === "tool_result") map.set(p.callId, p);
    return map;
  }, [messages]);

  const lastStepId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  return (
    <div className="grid gap-6">
      {messages.map((m) => {
        if (m.role === "tool") return null;
        if (m.role === "user") {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[min(56ch,100%)] whitespace-pre-wrap break-words rounded-md bg-sunken px-4 py-3 text-body">{textOf(m)}</div>
            </div>
          );
        }

        const isLive = live?.stepId === m.id;
        const text = isLive ? live.text : textOf(m);
        const reasoning = isLive ? live.reasoning : reasoningOf(m);
        const streaming = m.status === "streaming" && !!running;
        const callParts = m.parts.filter((p): p is ToolCallPart => p.type === "tool_call");
        const calls: CallView[] = callParts.map((p) => {
          const result = saved.get(p.callId);
          const liveCall: LiveCall | undefined = live?.calls[p.callId];
          const approval = live?.approvals.find((a) => a.callId === p.callId);
          const ask = live?.asks.find((a) => a.callId === p.callId);
          if (result) {
            return { callId: p.callId, name: p.name, args: p.args, argsError: p.argsError, status: result.denied ? "denied" : result.isError ? "error" : "done", output: result.output, durationMs: liveCall?.durationMs };
          }
          return {
            callId: p.callId,
            name: p.name,
            args: p.args,
            argsError: p.argsError,
            status: liveCall?.status ?? (running ? "pending" : "error"),
            output: liveCall?.output ?? (running ? undefined : "Run berakhir sebelum tool ini selesai."),
            durationMs: liveCall?.durationMs,
            approval,
            ask,
          };
        });
        const notes = [...new Set([...m.notes, ...(isLive ? live.notes : [])])];
        const usage = isLive ? live.usage ?? m.usage : m.usage;
        const usageText = formatUsage(usage);
        const failed = m.status === "error";
        const stopped = m.status === "stopped";

        return (
          <article key={m.id} className="relative grid max-w-[var(--read-max)] gap-3 border-l border-line pl-5" aria-label="Langkah agent" aria-busy={streaming}>
            <span className={`node ${streaming ? "node-run" : failed ? "node-fail" : stopped ? "node-skip" : "node-done"} absolute top-2 -left-[4px]`} aria-hidden />

            {reasoning && (
              <details open={streaming && !text && !calls.length} className="rounded-sm border border-line">
                <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-dense text-fg-2">
                  {streaming && !text ? "Berpikir" : "Reasoning"}
                  <span className="text-fg-3">{reasoning.length} karakter</span>
                </summary>
                <div className="max-h-60 overflow-y-auto border-t border-line px-3 py-2 text-dense whitespace-pre-wrap break-words text-fg-2">{reasoning}</div>
              </details>
            )}

            {streaming && !text && !reasoning && !calls.length && (
              <p className="flex items-center gap-2 text-ui text-fg-2" role="status">
                Menunggu respons {m.modelLabel ?? "model"}
              </p>
            )}

            {text && (
              <Suspense fallback={<p className="whitespace-pre-wrap text-body">{text}</p>}>
                <Markdown text={text} streaming={streaming} />
              </Suspense>
            )}

            {calls.length > 0 && (
              <div className="grid gap-2">
                {calls.map((c) => (
                  <ToolCallCard key={c.callId} call={c} onDecide={onDecide} onAnswer={onAnswer} />
                ))}
              </div>
            )}

            {notes.length > 0 && (
              <ul className="grid gap-1.5">
                {notes.map((n) => (
                  <li key={n} className="rounded-sm bg-sunken px-3 py-1.5 text-dense text-fg-2">
                    {n}
                  </li>
                ))}
              </ul>
            )}

            {failed && (
              <div className="grid gap-2 rounded-sm bg-danger-soft px-3 py-2 text-ui text-danger-text" role="alert">
                <p>{m.error ?? "Langkah ini gagal."}</p>
                {canRetry && m.id === lastStepId && (
                  <button type="button" className="btn btn-secondary justify-self-start" onClick={onRetry}>
                    Kirim ulang pesan terakhir
                  </button>
                )}
              </div>
            )}

            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-fg-3">
              <span>{streaming ? "Sedang bekerja" : failed ? "Gagal" : stopped ? "Dihentikan" : "Selesai"}</span>
              {m.modelLabel && <span className="font-code">{m.modelLabel}</span>}
              {usageText && <span>{usageText}</span>}
              {!streaming && m.durationMs !== null && <span>{(m.durationMs / 1000).toFixed(1)} dtk</span>}
              {!streaming && (
                <button type="button" className="btn btn-ghost ml-auto min-h-7 px-2 text-meta" onClick={() => onShowRequest(m.id)}>
                  <CodeIcon size={14} aria-hidden />
                  Lihat request
                </button>
              )}
            </footer>
          </article>
        );
      })}
    </div>
  );
}

export { DiffView };
