import type { Part, SendEditInput, SendImageInput, SendMessageResponse } from "@ezclaw/core";
import { eq } from "drizzle-orm";
import { insertMessage } from "../agent/store.js";
import type { Db } from "../db/client.js";
import { models, threads } from "../db/schema.js";
import { HttpError } from "../errors.js";
import type { RunManager } from "../runs.js";
import { getSettings } from "../settings.js";
import type { AssetService } from "./assets.js";
import { DEFAULT_TITLE, titleFrom } from "./chat.js";
import type { RegistryService } from "./registry.js";

/** Starts image turns: checks the model and references, saves the owner's message, and hands the work to the run manager. */
export class ImageService {
  constructor(
    private readonly db: Db,
    private readonly registry: RegistryService,
    private readonly runs: RunManager,
    private readonly assets: AssetService,
  ) {}

  /** Starts an edit turn: `target` is the image to change, `references` carry roles, `keep` says what to leave alone. */
  sendEdit(threadId: string, input: SendEditInput): SendMessageResponse {
    const thread = this.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread) throw new HttpError(404, "thread_not_found", "Thread tidak ditemukan.");
    if (thread.mode !== "edit") throw new HttpError(400, "not_edit_thread", "Thread ini bukan thread Edit.");
    if (this.runs.activeForThread(threadId)) {
      throw new HttpError(409, "run_active", "Masih ada edit yang berjalan di thread ini. Tunggu selesai atau tekan Stop.");
    }
    const model = this.registry.resolveModel(input.modelId);
    if (model.row.kind !== "image") {
      throw new HttpError(400, "not_an_image_model", "Model ini menjawab dengan teks. Pilih model gambar yang bisa mengedit.");
    }
    if (this.registry.imageSpecFor(input.modelId).spec.maxInputImages < 1) {
      throw new HttpError(400, "model_cannot_edit", "Model ini tidak menerima gambar input, jadi tidak bisa mengedit. Pilih model lain, atau ganti jalurnya di Pengaturan.");
    }
    if (model.endpoint.authType !== "none" && !this.registry.getApiKey(model.endpoint.id)) {
      throw new HttpError(400, "key_missing", `Endpoint ${model.endpoint.name} belum punya key. Isi di Settings, bagian Endpoint.`);
    }
    this.assets.dto(input.target);
    for (const ref of input.references) this.assets.dto(ref.assetId);

    const params = input.params ?? thread.imageParams;
    const settings = getSettings(this.db);
    const composerId = settings.defaultModels.composer ?? settings.defaultModels.chat ?? null;
    const composerModelRowId = composerId && this.db.select({ id: models.id }).from(models).where(eq(models.id, composerId)).get() ? composerId : null;

    const userParts: Part[] = [
      { type: "text", text: input.text },
      { type: "image", assetId: input.target, role: "target" },
      ...input.references.map<Part>((r) => ({ type: "image", assetId: r.assetId, ...(r.role ? { role: r.role } : {}) })),
    ];
    const user = insertMessage(this.db, { threadId, role: "user", parts: userParts, status: "complete" });
    const assistant = insertMessage(this.db, { threadId, role: "assistant", parts: [], status: "streaming", modelLabel: `${model.endpoint.name} / ${model.row.modelId}` });
    this.db
      .update(threads)
      .set({ modelRowId: input.modelId, imageParams: params, updatedAt: new Date(), ...(thread.title === DEFAULT_TITLE ? { title: titleFrom(input.text) } : {}) })
      .where(eq(threads.id, threadId))
      .run();

    const runId = this.runs.startImage({
      threadId,
      assistantMessageId: assistant.id,
      modelRowId: input.modelId,
      text: input.text,
      exact: input.exact === true,
      params,
      references: input.references,
      composerModelRowId,
      edit: { target: input.target, keep: input.keep },
    });
    return { runId, userMessageId: user.id, assistantMessageId: assistant.id };
  }

  send(threadId: string, input: SendImageInput): SendMessageResponse {
    const thread = this.db.select().from(threads).where(eq(threads.id, threadId)).get();
    if (!thread) throw new HttpError(404, "thread_not_found", "Thread tidak ditemukan.");
    if (thread.mode !== "image") throw new HttpError(400, "not_image_thread", "Thread ini bukan thread Image.");
    if (this.runs.activeForThread(threadId)) {
      throw new HttpError(409, "run_active", "Masih ada gambar yang dibuat di thread ini. Tunggu selesai atau tekan Stop.");
    }

    const model = this.registry.resolveModel(input.modelId);
    if (model.row.kind !== "image") {
      throw new HttpError(400, "not_an_image_model", "Model ini menjawab dengan teks. Pilih model gambar, atau tandai modelnya sebagai model gambar di Settings, bagian Model.");
    }
    if (model.endpoint.authType !== "none" && !this.registry.getApiKey(model.endpoint.id)) {
      throw new HttpError(400, "key_missing", `Endpoint ${model.endpoint.name} belum punya key. Isi di Settings, bagian Endpoint.`);
    }
    for (const ref of input.references) this.assets.dto(ref.assetId);

    const params = input.params ?? thread.imageParams;
    const settings = getSettings(this.db);
    const composerId = settings.defaultModels.composer ?? settings.defaultModels.chat ?? null;
    const composerModelRowId = composerId && this.db.select({ id: models.id }).from(models).where(eq(models.id, composerId)).get() ? composerId : null;

    const userParts: Part[] = [
      { type: "text", text: input.text },
      ...input.references.map<Part>((r) => ({ type: "image", assetId: r.assetId, ...(r.role ? { role: r.role } : {}) })),
    ];
    const user = insertMessage(this.db, { threadId, role: "user", parts: userParts, status: "complete" });
    const assistant = insertMessage(this.db, {
      threadId,
      role: "assistant",
      parts: [],
      status: "streaming",
      modelLabel: `${model.endpoint.name} / ${model.row.modelId}`,
    });
    this.db
      .update(threads)
      .set({ modelRowId: input.modelId, imageParams: params, updatedAt: new Date(), ...(thread.title === DEFAULT_TITLE ? { title: titleFrom(input.text) } : {}) })
      .where(eq(threads.id, threadId))
      .run();

    const runId = this.runs.startImage({
      threadId,
      assistantMessageId: assistant.id,
      modelRowId: input.modelId,
      text: input.text,
      exact: input.exact === true,
      params,
      references: input.references,
      composerModelRowId,
    });
    return { runId, userMessageId: user.id, assistantMessageId: assistant.id };
  }
}
