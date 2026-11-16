import type { RunEvent } from "@ezclaw/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, followRun } from "../../api";
import { keys } from "../../lib/queries";

export interface LiveVideoRun {
  runId: string;
  threadId: string;
  messageId: string;
  /** null until the job reaches the provider. */
  stage: "submitted" | "running" | "downloading" | null;
  progress: number | null;
  /** Provider's estimate of the whole job, when it gives one. */
  etaMs: number | null;
  /** Time since the job was sent, as last reported, and when that report came in. */
  elapsedMs: number;
  reportedAt: number;
  notes: string[];
  disconnected: string | null;
}

/** Follows a video turn on the server. A reload reattaches from the first event, so nothing is lost. */
export function useVideoRun(threadId: string | undefined, activeRun: { runId: string; messageId: string } | null | undefined) {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveVideoRun | null>(null);
  const attachedRun = useRef<string | null>(null);
  const attachedThread = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const detach = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    attachedRun.current = null;
    attachedThread.current = null;
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
      const state: LiveVideoRun = { runId, threadId: forThread, messageId, stage: null, progress: null, etaMs: null, elapsedMs: 0, reportedAt: Date.now(), notes: [], disconnected: null };
      setLive({ ...state });

      const apply = (ev: RunEvent) => {
        if (ev.type === "video_progress") {
          state.stage = ev.status;
          state.elapsedMs = ev.elapsedMs;
          state.reportedAt = Date.now();
          if (ev.progress !== undefined) state.progress = ev.progress;
          if (ev.etaMs !== undefined) state.etaMs = ev.etaMs;
        } else if (ev.type === "note") {
          state.notes = [...state.notes, ev.text];
        } else return;
        setLive({ ...state });
      };

      void (async () => {
        let finished = false;
        try {
          await followRun(runId, {
            signal: ctl.signal,
            onEvent: (ev) => {
              if (ev.type === "done") finished = true;
              apply(ev);
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
          state.disconnected = "Stream berhenti sebelum selesai. Muat ulang thread untuk melihat hasil terakhir.";
          setLive({ ...state });
          return;
        }
        await Promise.all([qc.invalidateQueries({ queryKey: keys.thread(forThread) }), qc.invalidateQueries({ queryKey: ["threads"] })]);
        if (attachedRun.current === runId) {
          attachedRun.current = null;
          attachedThread.current = null;
          setLive(null);
        }
      })();
    },
    [qc],
  );

  useEffect(() => {
    if (threadId && activeRun) attach(activeRun.runId, activeRun.messageId, threadId);
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
      // Already finished; the stream delivers the final state.
    }
  }, [activeRun?.runId]);

  return { live, attach, stop };
}
