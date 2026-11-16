import { resolveVideoParams, type Part, type RunEvent, type VideoParams, type VideoSpec, type VideoTurnMeta, type VideoWire } from "@ezclaw/core";
import { and, eq } from "drizzle-orm";
import { updateMessage } from "./agent/store.js";
import { models } from "./db/schema.js";
import { quoteVideo, submitVideo, waitForVideo, type VideoCallDeps } from "./provider/video.js";
import type { AssetService } from "./services/assets.js";
import { toDataUrl } from "./services/imageInfo.js";

export interface VideoRunDeps extends VideoCallDeps {
  assets: AssetService;
}

export interface VideoRunInput {
  threadId: string;
  assistantMessageId: string;
  modelRowId: string;
  text: string;
  params: VideoParams;
  startFrame?: string;
  endFrame?: string;
  /** A job sent before EZClaw restarted: wait for it instead of sending a new one. */
  resume?: VideoTurnMeta;
}

export interface VideoRunHandle {
  signal: AbortSignal;
  emit: (e: RunEvent) => void;
  /** True when the stop comes from EZClaw shutting down; the job is then left to be picked up on the next start. */
  shuttingDown: () => boolean;
}

export interface VideoRunResult {
  status: "complete" | "stopped" | "error";
  error?: string;
  /** The message was left waiting for its job, to be resumed after a restart. */
  parked?: boolean;
}

/**
 * Venice lists a model's text and image variants as two ids. When the owner attaches a start frame to a
 * text model (or none to an image model), the sibling on the same endpoint takes the job.
 */
function sibling(deps: VideoRunDeps, modelRowId: string, spec: VideoSpec): string | null {
  if (!spec.pairedModelId) return null;
  const row = deps.registry.resolveModel(modelRowId).row;
  return deps.db.select({ id: models.id }).from(models).where(and(eq(models.endpointId, row.endpointId), eq(models.modelId, spec.pairedModelId))).get()?.id ?? null;
}

export interface VideoPlan {
  /** The model that takes the job (Venice may switch to the sibling variant). */
  modelRowId: string;
  spec: VideoSpec;
  prompt: string;
  params: VideoParams;
  /** False when the end frame is dropped. */
  keepEnd: boolean;
  notes: string[];
}

/**
 * Everything decided before a job is sent: which model takes it, whether the frames fit, and the
 * parameters as the model accepts them. Throws with a reason the owner can act on.
 */
export function planVideo(deps: VideoRunDeps, input: { modelRowId: string; text: string; params: VideoParams; hasStart: boolean; hasEnd: boolean }): VideoPlan {
  const notes: string[] = [];
  let modelRowId = input.modelRowId;
  let { spec } = deps.registry.videoSpecFor(modelRowId);
  const { hasStart } = input;
  if ((hasStart && !spec.startFrame) || (!hasStart && !spec.textToVideo)) {
    const other = sibling(deps, modelRowId, spec);
    if (other) {
      modelRowId = other;
      spec = deps.registry.videoSpecFor(other).spec;
      notes.push(`${hasStart ? "Ada frame awal" : "Tanpa frame awal"}, jadi dipakai varian ${deps.registry.resolveModel(other).row.modelId}.`);
    }
  }
  if (hasStart && !spec.startFrame) throw new Error("Model ini hanya membuat video dari teks. Hapus frame awal, atau pilih model image-to-video.");
  if (!hasStart && !spec.textToVideo) throw new Error("Model ini butuh frame awal (image-to-video). Tambahkan gambar sebagai frame awal, atau pilih model text-to-video.");
  let keepEnd = input.hasEnd;
  if (keepEnd && !spec.endFrame) {
    notes.push("Model ini tidak menerima frame akhir, jadi frame akhir tidak dikirim.");
    keepEnd = false;
  }
  if (keepEnd && !hasStart) {
    notes.push("Frame akhir hanya dipakai bersama frame awal, jadi tidak dikirim.");
    keepEnd = false;
  }
  const prompt = input.text.trim();
  if (!prompt && (!hasStart || spec.wire === "venice-video")) throw new Error("Prompt kosong. Jelaskan video yang diinginkan.");
  if (spec.promptLimit && prompt.length > spec.promptLimit) throw new Error(`Prompt terlalu panjang untuk model ini: ${prompt.length} karakter, batasnya ${spec.promptLimit}.`);
  const resolved = resolveVideoParams(spec, input.params, { start: hasStart, end: keepEnd });
  return { modelRowId, spec, prompt, params: resolved.params, keepEnd, notes: [...notes, ...resolved.notes] };
}

export interface VideoEstimate {
  usd: number | null;
  /** Where the number comes from, or why there is none. */
  source: string;
}

/**
 * The price of a planned job: Venice's own quote, OpenRouter's listed price per second (or per video),
 * or null where the provider tells the cost only afterwards (xAI).
 */
export async function estimateVideo(deps: VideoRunDeps, plan: VideoPlan, signal: AbortSignal): Promise<VideoEstimate> {
  const model = deps.registry.resolveModel(plan.modelRowId);
  const p = plan.params;
  const duration = p.duration ?? plan.spec.defaultDuration ?? plan.spec.durations[0] ?? null;
  if (plan.spec.wire === "venice-video") {
    const usd = await quoteVideo(
      deps,
      plan.modelRowId,
      {
        model: model.row.modelId,
        duration: `${duration ?? 5}s`,
        ...(p.resolution ? { resolution: p.resolution } : {}),
        ...(p.aspectRatio ? { aspect_ratio: p.aspectRatio } : {}),
        ...(p.audio !== undefined ? { audio: p.audio } : {}),
      },
      signal,
    );
    return { usd, source: usd === null ? "Venice tidak memberi perkiraan untuk pengaturan ini" : "Venice" };
  }
  if (plan.spec.wire === "openrouter-videos") {
    const skus = (model.row.meta as { pricing?: Record<string, string> | null }).pricing ?? null;
    const num = (k: string) => (skus && skus[k] !== undefined ? Number(skus[k]) : NaN);
    const perSecond = [p.resolution ? `per-video-second-${p.resolution}` : "", "per-video-second"].map(num).find((n) => Number.isFinite(n));
    if (perSecond !== undefined && duration) return { usd: perSecond * duration, source: "harga per detik OpenRouter" };
    const flat = num("generate");
    if (Number.isFinite(flat)) return { usd: flat, source: "harga per video OpenRouter" };
    return { usd: null, source: "OpenRouter tidak mencantumkan harga model ini" };
  }
  return { usd: null, source: "xAI melaporkan biaya setelah video selesai" };
}

/** One video turn: checks, the job, waiting, saving the file, and writing the message. */
export async function runVideo(deps: VideoRunDeps, handle: VideoRunHandle, input: VideoRunInput): Promise<VideoRunResult> {
  const started = Date.now();
  const notes: string[] = [];
  const note = (t: string) => {
    if (notes.includes(t)) return;
    notes.push(t);
    handle.emit({ type: "note", text: t });
  };
  let modelRowId = input.modelRowId;
  let model = deps.registry.resolveModel(modelRowId);
  const label = () => `${model.endpoint.name} / ${model.row.modelId}`;
  const finalize = (patch: Parameters<typeof updateMessage>[2]) => updateMessage(deps.db, input.assistantMessageId, { notes, modelLabel: label(), durationMs: Date.now() - started, ...patch });

  let meta: VideoTurnMeta | null = input.resume ?? null;
  try {
    let wire: VideoWire;
    if (meta?.job) {
      wire = meta.wire;
      if (meta.modelRowId) {
        modelRowId = meta.modelRowId;
        model = deps.registry.resolveModel(modelRowId);
      }
      note("EZClaw dimulai ulang saat video ini dibuat. Menunggu job yang sama di provider, tanpa mengirim ulang.");
    } else {
      const plan = planVideo(deps, { modelRowId, text: input.text, params: input.params, hasStart: !!input.startFrame, hasEnd: !!input.endFrame });
      plan.notes.forEach(note);
      modelRowId = plan.modelRowId;
      model = deps.registry.resolveModel(modelRowId);
      const endFrame = plan.keepEnd ? input.endFrame : undefined;
      const prompt = plan.prompt;
      const resolved = { params: plan.params };
      wire = plan.spec.wire;
      const frameUrl = (id: string) => {
        const f = deps.assets.read(id);
        return toDataUrl(f.mime, f.bytes);
      };
      const body = {
        modelId: model.row.modelId,
        prompt,
        params: resolved.params,
        ...(input.startFrame ? { startFrame: frameUrl(input.startFrame) } : {}),
        ...(endFrame ? { endFrame: frameUrl(endFrame) } : {}),
      };

      const estimate = await estimateVideo(deps, plan, handle.signal);
      if (estimate.usd !== null) note(`Perkiraan biaya: $${estimate.usd.toFixed(3)} (${estimate.source}).`);

      meta = {
        wire,
        modelId: model.row.modelId,
        modelRowId,
        prompt,
        params: resolved.params,
        ...(input.startFrame ? { startFrame: input.startFrame } : {}),
        ...(endFrame ? { endFrame } : {}),
      };
      handle.emit({ type: "video_progress", status: "submitted", elapsedMs: 0 });
      const job = await submitVideo(deps, { modelRowId, wire, body, logMessageId: input.assistantMessageId, signal: handle.signal });
      meta = { ...meta, job };
      // Saved before waiting: if EZClaw stops now, the next start keeps waiting for this paid job.
      updateMessage(deps.db, input.assistantMessageId, { raw: { protocol: "video", data: meta }, modelLabel: label() });
    }

    const job = meta.job!;
    const submitted = new Date(job.submittedAt).getTime();
    const result = await waitForVideo(deps, {
      modelRowId,
      modelId: meta.modelId,
      wire,
      job,
      logMessageId: input.assistantMessageId,
      signal: handle.signal,
      onProgress: (p) => handle.emit({ type: "video_progress", status: "running", elapsedMs: Date.now() - submitted, ...(p.progress !== undefined ? { progress: p.progress } : {}), ...(p.etaMs !== undefined ? { etaMs: p.etaMs } : {}) }),
      onDownloading: () => handle.emit({ type: "video_progress", status: "downloading", elapsedMs: Date.now() - submitted }),
    });
    const asset = deps.assets.saveVideo(result.bytes);
    meta = { ...meta, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) };
    const parts: Part[] = [{ type: "video", assetId: asset.id }];
    finalize({ parts, status: "complete", error: null, raw: { protocol: "video", data: meta }, ...(result.costUsd !== undefined ? { usage: { costUsd: result.costUsd } } : {}) });
    return { status: "complete" };
  } catch (err) {
    if (handle.signal.aborted) {
      if (handle.shuttingDown() && meta?.job) {
        // Left as "streaming" with its job: the next start resumes it.
        updateMessage(deps.db, input.assistantMessageId, { notes });
        return { status: "stopped", parked: true };
      }
      if (meta?.job) note("Berhenti menunggu. Job di provider mungkin tetap selesai dan tetap ditagih.");
      finalize({ status: "stopped", error: null, ...(meta ? { raw: { protocol: "video", data: meta } } : {}) });
      return { status: "stopped" };
    }
    const message = err instanceof Error ? err.message : String(err);
    finalize({ status: "error", error: message, ...(meta ? { raw: { protocol: "video", data: meta } } : {}) });
    return { status: "error", error: message };
  }
}
