import type { RunEvent, Usage } from "@ezclaw/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, followRun } from "../../api";
import { keys } from "../../lib/queries";

export interface LiveRun {
  runId: string;
  threadId: string;
  messageId: string;
  text: string;
  reasoning: string;
  notes: string[];
  usage: Usage | null;
  /** Set when the stream connection broke while the run may still be going on the server. */
  disconnected: string | null;
}

/**
 * Follows the answer being written. The run lives on the server, so closing the tab does not
 * stop it: opening a thread that has an active run reattaches from the first event.
 */
export function useLiveRun(threadId: string | undefined, activeRun: { runId: string; messageId: string } | null | undefined) {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveRun | null>(null);
  const attachedRun = useRef<string | null>(null);
  const attachedThread = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<LiveRun | null>(null);
  const frame = useRef<number>(0);

  const flush = useCallback(() => {
    frame.current = 0;
    if (pending.current) setLive({ ...pending.current });
  }, []);

  const detach = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    attachedRun.current = null;
    attachedThread.current = null;
    pending.current = null;
    setLive(null);
  }, []);

  const attach = useCallback(
    (runId: string, messageId: string, forThread: string) => {
      if (attachedRun.current === runId) return;
      controller.current?.abort();
      const ctl = new AbortController();
      controller.current = ctl;
      attachedRun.current = runId;
      attachedThread.current = forThread;
      const state: LiveRun = { runId, threadId: forThread, messageId, text: "", reasoning: "", notes: [], usage: null, disconnected: null };
      pending.current = state;
      setLive({ ...state });

      const onEvent = (ev: RunEvent) => {
        switch (ev.type) {
          case "text":
            state.text += ev.delta;
            break;
          case "reasoning":
            state.reasoning += ev.delta;
            break;
          case "note":
            state.notes = [...state.notes, ev.text];
            break;
          case "usage":
            state.usage = { ...state.usage, ...ev.usage };
            break;
          default:
            return;
        }
        // Many tokens arrive per frame; render once per frame.
        if (!frame.current) frame.current = requestAnimationFrame(flush);
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
          state.disconnected = err instanceof ApiError ? err.message : "Koneksi ke stream terputus.";
          setLive({ ...state });
          return;
        }
        if (ctl.signal.aborted) return;
        if (!finished) {
          state.disconnected = "Stream berhenti sebelum jawaban selesai. Muat ulang thread untuk melihat hasil terakhir.";
          setLive({ ...state });
          return;
        }
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        // Show the saved message before dropping the live view, so nothing flickers.
        await Promise.all([
          qc.invalidateQueries({ queryKey: keys.thread(forThread) }),
          qc.invalidateQueries({ queryKey: ["threads"] }),
        ]);
        if (attachedRun.current === runId) {
          attachedRun.current = null;
          attachedThread.current = null;
          pending.current = null;
          setLive(null);
        }
      })();
    },
    [flush, qc],
  );

  // Reattach when a thread opens with a run already going (reload, or another tab started it).
  useEffect(() => {
    if (threadId && activeRun) attach(activeRun.runId, activeRun.messageId, threadId);
  }, [activeRun, attach, threadId]);

  // Moving to another thread only stops listening to the old run; the run itself carries on.
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

  return { live, attach, stop };
}
