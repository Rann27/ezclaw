import type { Part, SendMessageResponse, SendVideoInput, VideoQuoteInput, VideoQuoteResponse } from "@ezclaw/core";
import { eq } from "drizzle-orm";
import { insertMessage } from "../agent/store.js";
import type { Db } from "../db/client.js";
import { threads } from "../db/schema.js";
import { HttpError } from "../errors.js";
import type { RunManager } from "../runs.js";
import type { AssetService } from "./assets.js";
import { DEFAULT_TITLE, titleFrom } from "./chat.js";
import type { RegistryService } from "./registry.js";
import { estimateVideo, planVideo, type VideoRunDeps } from "../videoRun.js";

/** Starts video turns: checks the model and frames, saves the owner's message, and hands the job to the run manager. */
export class VideoService {
  constructor(
    private readonly db: Db,
    private readonly registry: RegistryService,
    private readonly runs: RunManager,
    private readonly assets: AssetService,
    private readonly deps: VideoRunDeps,
  ) {}

  /** What the job would cost with these settings, and whether it would be refused before sending. */
  async quote(input: VideoQuoteInput, signal: AbortSignal): Promise<VideoQuoteResponse> {
    const model = this.registry.resolveModel(input.modelId);
    if (model.row.kind !== "video") throw new HttpError(400, "not_a_video_model", "Model ini bukan model video.");
    // An empty prompt is fine while the owner is still typing; the price does not depend on it.
    const text = input.text.trim() || "x";
    try {
      const plan = planVideo(this.deps, { modelRowId: input.modelId, text, params: input.params, hasStart: input.hasStart, hasEnd: input.hasEnd });
      const estimate = await estimateVideo(this.deps, plan, signal);
      return { ...estimate, modelId: this.registry.resolveModel(plan.modelRowId).row.modelId, error: null };
    } catch (err) {
      return { usd: null, source: "", modelId: model.row.modelId, error: err instanceof Error ? err.message : String(err) };
    }
  }

  send(threadId: string, input: SendVideoInput): SendMessageResponse {
    const thread = this.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread) throw new HttpError(404, "thread_not_found", "Thread tidak ditemukan.");
    if (thread.mode !== "video") throw new HttpError(400, "not_video_thread", "Thread ini bukan thread Video.");
    if (this.runs.activeForThread(threadId)) {
      throw new HttpError(409, "run_active", "Masih ada video yang dibuat di thread ini. Tunggu selesai atau tekan Stop.");
    }
    const model = this.registry.resolveModel(input.modelId);
    if (model.row.kind !== "video") {
      throw new HttpError(400, "not_a_video_model", "Model ini bukan model video. Pilih model video, atau tandai modelnya sebagai model video di Settings, bagian Model.");
    }
    if (model.endpoint.authType !== "none" && !this.registry.hasCredential(model.endpoint)) {
      throw new HttpError(400, "key_missing", `Endpoint ${model.endpoint.name} belum punya key. Isi di Settings, bagian Endpoint.`);
    }
    if (!input.text.trim() && !input.startFrame) throw new HttpError(400, "empty_prompt", "Tulis prompt, atau pasang frame awal.");
    if (input.endFrame && !input.startFrame) throw new HttpError(400, "end_without_start", "Frame akhir butuh frame awal.");
    for (const id of [input.startFrame, input.endFrame]) {
      if (!id) continue;
      if (!this.assets.dto(id).mime.startsWith("image/")) throw new HttpError(400, "frame_not_image", "Frame harus berupa gambar.");
    }

    const params = input.params ?? thread.videoParams;
    const userParts: Part[] = [
      ...(input.text.trim() ? [{ type: "text" as const, text: input.text }] : []),
      ...(input.startFrame ? [{ type: "image" as const, assetId: input.startFrame, role: "start_frame" }] : []),
      ...(input.endFrame ? [{ type: "image" as const, assetId: input.endFrame, role: "end_frame" }] : []),
    ];
    const user = insertMessage(this.db, { threadId, role: "user", parts: userParts, status: "complete" });
    const assistant = insertMessage(this.db, { threadId, role: "assistant", parts: [], status: "streaming", modelLabel: `${model.endpoint.name} / ${model.row.modelId}` });
    const title = input.text.trim() ? titleFrom(input.text) : "Video dari gambar";
    this.db
      .update(threads)
      .set({ modelRowId: input.modelId, videoParams: params, updatedAt: new Date(), ...(thread.title === DEFAULT_TITLE ? { title } : {}) })
      .where(eq(threads.id, threadId))
      .run();

    const runId = this.runs.startVideo({
      threadId,
      assistantMessageId: assistant.id,
      modelRowId: input.modelId,
      text: input.text,
      params,
      ...(input.startFrame ? { startFrame: input.startFrame } : {}),
      ...(input.endFrame ? { endFrame: input.endFrame } : {}),
    });
    return { runId, userMessageId: user.id, assistantMessageId: assistant.id };
  }
}
