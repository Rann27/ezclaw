import type { ApprovalRequest, PlanItem, RunEvent, Usage } from "@ezclaw/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, followRun } from "../../api";
import { keys } from "../../lib/queries";

export type CallStatus = "pending" | "waiting" | "running" | "done" | "error" | "denied";

export interface LiveCall {
  callId: string;
  name: string;
  args: unknown;
  status: CallStatus;
  output?: string;
  durationMs?: number;
  truncated?: boolean;
}

export interface LiveApproval {
  approvalId: string;
  callId: string;
  request: ApprovalRequest;
}

export interface LiveAsk {
  askId: string;
  callId: string;
  question: string;
  options?: string[];
}

export interface LiveAgent {
  runId: string;
  threadId: string;
  /** The assistant message being written right now. */
  stepId: string | null;
  text: string;
  reasoning: string;
  notes: string[];
  usage: Usage | null;
  calls: Record<string, LiveCall>;
  approvals: LiveApproval[];
  asks: LiveAsk[];
  plan: PlanItem[] | null;
  context: { used: number; window: number | null } | null;
  /** Set when the stream broke while the run may still be going on the server. */
  disconnected: string | null;
}

function fresh(runId: string, threadId: string): LiveAgent {
  return { runId, threadId, stepId: null, text: "", reasoning: "", notes: [], usage: null, calls: {}, approvals: [], asks: [], plan: null, context: null, disconnected: null };
}

/**
 * Follows an agent run. Finished steps come from the saved thread; this only holds what is
 * happening right now: the streaming text, tool calls in flight, and questions waiting for the owner.
 */
export function useAgentRun(threadId: string | undefined, activeRun: { runId: string } | null | undefined) {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveAgent | null>(null);
  const state = useRef<LiveAgent | null>(null);
  const attachedRun = useRef<string | null>(null);
  const attachedThread = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const frame = useRef(0);

  const publish = useCallback(() => {
    frame.current = 0;
    if (state.current) setLive({ ...state.current, calls: { ...state.current.calls } });
  }, []);
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(publish);
  }, [publish]);

  const detach = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    attachedRun.current = null;
    attachedThread.current = null;
    state.current = null;
    setLive(null);
  }, []);

  const attach = useCallback(
    (runId: string, forThread: string) => {
      if (attachedRun.current === runId) return;
      controller.current?.abort();
      const ctl = new AbortController();
      controller.current = ctl;
      attachedRun.current = runId;
      attachedThread.current = forThread;
      const s = fresh(runId, forThread);
      state.current = s;
      setLive({ ...s });

      const refresh = () => qc.invalidateQueries({ queryKey: keys.thread(forThread) });

      const onEvent = (ev: RunEvent) => {
        switch (ev.type) {
          case "step_start":
            s.stepId = ev.messageId;
            s.text = "";
            s.reasoning = "";
            void refresh();
            break;
          case "text":
            s.text += ev.delta;
            break;
          case "reasoning":
            s.reasoning += ev.delta;
            break;
          case "note":
            s.notes = [...s.notes, ev.text];
            break;
          case "usage":
            s.usage = { ...s.usage, ...ev.usage };
            break;
          case "step_end": {
            const ended = ev.messageId;
            void refresh().then(() => {
              // The saved copy is on screen now, so the live text can go.
              if (state.current === s && s.stepId === ended) {
                s.stepId = null;
                s.text = "";
                s.reasoning = "";
                schedule();
              }
            });
            break;
          }
          case "tool_call":
            s.calls[ev.callId] = { callId: ev.callId, name: ev.name, args: ev.args, status: "pending" };
            break;
          case "tool_start":
            if (s.calls[ev.callId]) s.calls[ev.callId]!.status = "running";
            break;
          case "tool_result": {
            const c = s.calls[ev.callId] ?? { callId: ev.callId, name: ev.name, args: {}, status: "pending" as CallStatus };
            s.calls[ev.callId] = { ...c, status: ev.denied ? "denied" : ev.ok ? "done" : "error", output: ev.output, durationMs: ev.durationMs, truncated: ev.truncated };
            void refresh();
            break;
          }
          case "approval":
            s.approvals = [...s.approvals, { approvalId: ev.approvalId, callId: ev.callId, request: ev.request }];
            if (s.calls[ev.callId]) s.calls[ev.callId]!.status = "waiting";
            break;
          case "approval_resolved":
            s.approvals = s.approvals.filter((a) => a.approvalId !== ev.approvalId);
            break;
          case "ask":
            s.asks = [...s.asks, { askId: ev.askId, callId: ev.callId, question: ev.question, options: ev.options }];
            if (s.calls[ev.callId]) s.calls[ev.callId]!.status = "waiting";
            break;
          case "ask_resolved":
            s.asks = s.asks.filter((a) => a.askId !== ev.askId);
            break;
          case "plan":
            s.plan = ev.items;
            void qc.invalidateQueries({ queryKey: keys.thread(forThread) });
            break;
          case "context":
            s.context = { used: ev.usedTokens, window: ev.windowTokens };
            break;
          case "compaction":
            void refresh();
            break;
          default:
            return;
        }
        schedule();
      };

      void (async () => {
        let finished = false;
        try {
          await followRun(runId, {
            signal: ctl.signal,
            onEvent: (ev) => {
              if (ev.type === "done") finished = true;
              onEvent(ev);
            },
          });
        } catch (err) {
          if (ctl.signal.aborted) return;
          s.disconnected = err instanceof ApiError ? err.message : "Koneksi ke stream terputus.";
          publish();
          return;
        }
        if (ctl.signal.aborted) return;
        if (!finished) {
          s.disconnected = "Stream berhenti sebelum run selesai. Muat ulang thread untuk melihat hasil terakhir.";
          publish();
          return;
        }
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        await Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["threads"] })]);
        if (attachedRun.current === runId) {
          attachedRun.current = null;
          attachedThread.current = null;
          state.current = null;
          setLive(null);
        }
      })();
    },
    [publish, qc, schedule],
  );

  useEffect(() => {
    if (threadId && activeRun) attach(activeRun.runId, threadId);
  }, [activeRun, attach, threadId]);

  useEffect(() => {
    if (attachedThread.current && attachedThread.current !== threadId) detach();
  }, [threadId, detach]);

  useEffect(() => detach, [detach]);

  const stop = useCallback(async () => {
    const id = attachedRun.current ?? activeRun?.runId;
    if (!id) return;
    try {
      await api(`/runs/${id}/stop`, { method: "POST" });
    } catch {
      // Already finished; the stream will deliver the final state.
    }
  }, [activeRun?.runId]);

  const decide = useCallback(
    async (approvalId: string, decision: "allow" | "allow_always" | "deny", reason?: string) => {
      const run = attachedRun.current;
      if (!run) return;
      await api(`/runs/${run}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }) });
    },
    [],
  );

  const answer = useCallback(async (askId: string, text: string) => {
    const run = attachedRun.current;
    if (!run) return;
    await api(`/runs/${run}/asks/${askId}`, { method: "POST", body: JSON.stringify({ answer: text }) });
  }, []);

  return { live, attach, stop, decide, answer };
}
