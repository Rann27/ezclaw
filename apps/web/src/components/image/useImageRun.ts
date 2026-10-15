import type { RunEvent } from "@ezclaw/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, followRun } from "../../api";
import { keys } from "../../lib/queries";

export interface Slot {
  status: "queued" | "running" | "done" | "error";
  assetId?: string;
  seed?: number;
  error?: string;
}

export interface LiveImageRun {
  runId: string;
  threadId: string;
  messageId: string;
  slots: Slot[];
  composed: { prompt: string; useLastImage: boolean } | null;
  notes: string[];
  disconnected: string | null;
}

/**
 * Follows an image turn: which slots are queued, running, done or failed, and the prompt the
 * Prompt Composer wrote. The run lives on the server, so a reload reattaches from the first event.
 */
export function useImageRun(threadId: string | undefined, activeRun: { runId: string; messageId: string } | null | undefined) {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveImageRun | null>(null);
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
      const state: LiveImageRun = { runId, threadId: forThread, messageId, slots: [], composed: null, notes: [], disconnected: null };
      setLive({ ...state });

      const apply = (ev: RunEvent) => {
        if (ev.type === "image_slot") {
          const slots = [...state.slots];
          slots[ev.index] = {
            status: ev.status,
            ...(ev.assetId ? { assetId: ev.assetId } : {}),
            ...(ev.seed !== undefined ? { seed: ev.seed } : {}),
            ...(ev.error ? { error: ev.error } : {}),
          };
          // Slots arrive in order, but never leave a hole in the array.
          for (let i = 0; i < slots.length; i++) slots[i] ??= { status: "queued" };
          state.slots = slots;
        } else if (ev.type === "composed") {
          state.composed = { prompt: ev.prompt, useLastImage: ev.useLastImage };
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
        // Show the saved message before dropping the live view, so nothing flickers.
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
