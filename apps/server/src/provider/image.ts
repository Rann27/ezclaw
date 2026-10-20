import { randomUUID } from "node:crypto";
import {
  chatImageBody,
  dashscopeRoot,
  dashscopeSubmitBody,
  openaiImagesEditFields,
  openaiImagesGenerateBody,
  openrouterImagesBody,
  veniceEditBody,
  veniceMultiEditBody,
  veniceGenerateBody,
  type ChatImageMessage,
  type ImageBodyInput,
  type ImageParams,
  type ImageSpec,
  type ImageWire,
} from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { requestLogs } from "../db/schema.js";
import type { RegistryService } from "../services/registry.js";
import { fromDataUrl, sniffImage, toDataUrl } from "../services/imageInfo.js";
import { buildHeaders, joinUrl, networkError, parseProviderError, ProviderError, redactHeaders, type ConnectionInfo } from "./http.js";

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const MAX_LOGGED_RESPONSE = 8000;
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const CONCURRENCY = 4;

export interface ImageRef {
  bytes: Buffer;
  mime: string;
}

export interface GeneratedImage {
  bytes: Buffer;
  /** Seed actually used, when the request fixed one. */
  seed?: number;
}

export interface ImageCallDeps {
  db: Db;
  registry: RegistryService;
  fetchImpl: typeof fetch;
  /** Wait between polls of an async task. Tests shorten it. */
  pollMs?: number;
}

export interface ImageCallArgs {
  modelRowId: string;
  /** The prompt exactly as it goes on the wire. */
  prompt: string;
  params: ImageParams;
  n: number;
  references: ImageRef[];
  /** Conversation so far, for models that see it (chat-modalities). The last entry is the new turn. */
  chat?: ChatImageMessage[];
  logMessageId: string;
  signal: AbortSignal;
  /** True for an edit: the first reference is the image being changed, not a style guide. */
  edit?: boolean;
  /** Called once per finished image; returns the id of the saved asset. */
  onImage: (index: number, image: GeneratedImage) => string | Promise<string>;
  onSlot: (index: number, status: "running" | "done" | "error", extra?: { seed?: number; error?: string; assetId?: string }) => void;
  onNote: (text: string) => void;
}

export type SlotResult = { ok: true; image: GeneratedImage } | { ok: false; error: string };

export interface ImageCallResult {
  slots: SlotResult[];
  wire: ImageWire;
  spec: ImageSpec;
  /** Text the model wrote beside the image, if any. */
  text: string;
}

/** Hides base64 payloads so a request log stays readable and small. */
export function redactImageText(text: string): string {
  return text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (m) => `[data URL gambar, ${((m.length * 3) / 4 / 1024).toFixed(1)} KB]`)
    .replace(/"([A-Za-z0-9+/=]{2000,})"/g, (_m, b64: string) => `"[base64 ${b64.length} karakter]"`);
}

interface HttpCtx {
  deps: ImageCallDeps;
  args: ImageCallArgs;
  conn: ConnectionInfo;
  apiKey: string | null;
  authHeader: string | null;
  name: string;
  attempt: number;
}

async function send(ctx: HttpCtx, method: "GET" | "POST", url: string, init: { json?: unknown; form?: FormData; extraHeaders?: Record<string, string>; summary?: unknown }): Promise<Response> {
  const { deps, args, conn } = ctx;
  const headers = buildHeaders(conn, ctx.apiKey, "application/json, image/*");
  if (init.form || method === "GET") delete headers["content-type"];
  Object.assign(headers, init.extraHeaders);

  const bodyText = init.json !== undefined ? JSON.stringify(init.json) : init.summary !== undefined ? JSON.stringify(init.summary) : "";
  const logId = randomUUID();
  const started = Date.now();
  deps.db
    .insert(requestLogs)
    .values({
      id: logId,
      messageId: args.logMessageId,
      attempt: ctx.attempt++,
      method,
      url,
      requestHeaders: redactHeaders(headers, ctx.authHeader),
      requestBody: redactImageText(bodyText),
      startedAt: new Date(started),
    })
    .run();
  const done = (patch: { status?: number; responseText?: string | null; error?: string | null }) =>
    deps.db
      .update(requestLogs)
      .set({ ...patch, durationMs: Date.now() - started })
      .where(eq(requestLogs.id, logId))
      .run();

  const signal = AbortSignal.any([args.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { method, headers, signal, ...(init.json !== undefined ? { body: bodyText } : {}), ...(init.form ? { body: init.form } : {}) });
  } catch (err) {
    if (args.signal.aborted) {
      done({ error: "Dihentikan oleh pengguna." });
      throw err;
    }
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const perr = timedOut ? new ProviderError(`${ctx.name} tidak menjawab dalam ${REQUEST_TIMEOUT_MS / 60_000} menit.`, { network: true }) : networkError(conn, err);
    done({ error: perr.message });
    throw perr;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    done({ status: res.status, responseText: redactImageText(errText).slice(0, MAX_LOGGED_RESPONSE) });
    throw parseProviderError(res.status, errText, conn);
  }
  // Callers read the body; the log gets its summary from them through `logResponse`.
  (res as Response & { __done?: typeof done }).__done = done;
  return res;
}

function logResponse(res: Response, text: string) {
  (res as Response & { __done?: (p: { status?: number; responseText?: string | null }) => void }).__done?.({ status: res.status, responseText: redactImageText(text).slice(0, MAX_LOGGED_RESPONSE) });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  logResponse(res, text);
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v === "object" && v !== null) return v as Record<string, unknown>;
  } catch {
    // Fall through to the error below.
  }
  throw new ProviderError(`Provider mengirim jawaban yang bukan JSON: ${text.slice(0, 200)}`);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function requireImage(bytes: Buffer, source: string): Buffer {
  if (!sniffImage(bytes)) throw new ProviderError(`${source} mengirim data yang bukan gambar.`);
  return bytes;
}

/** Downloads a result URL the provider returned. Only http(s) is followed, with a size cap. */
async function download(ctx: HttpCtx, url: string): Promise<Buffer> {
  if (!/^https?:\/\//i.test(url)) throw new ProviderError("Provider mengirim alamat gambar yang tidak didukung.");
  let res: Response;
  try {
    res = await ctx.deps.fetchImpl(url, { signal: AbortSignal.any([ctx.args.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
  } catch (err) {
    if (ctx.args.signal.aborted) throw err;
    throw networkError(ctx.conn, err);
  }
  if (!res.ok) throw new ProviderError(`Gagal mengunduh hasil gambar (${res.status}).`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new ProviderError("Hasil gambar terlalu besar untuk diunduh.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new ProviderError("Hasil gambar terlalu besar untuk diunduh.");
  return requireImage(buf, "URL hasil");
}

async function fromB64OrUrl(ctx: HttpCtx, item: Record<string, unknown>): Promise<Buffer> {
  if (typeof item.b64_json === "string") return requireImage(Buffer.from(item.b64_json, "base64"), "Provider");
  if (typeof item.url === "string") {
    const fromData = fromDataUrl(item.url);
    return fromData ? requireImage(fromData, "Provider") : download(ctx, item.url);
  }
  throw new ProviderError("Jawaban provider tidak berisi gambar.");
}

/* ------------------------------------------------------------------ wires */

async function openaiImages(ctx: HttpCtx, body: ImageBodyInput, refs: ImageRef[]): Promise<Buffer[]> {
  const { baseUrl } = ctx.conn;
  let res: Response;
  if (refs.length === 0) {
    res = await send(ctx, "POST", joinUrl(baseUrl, "/images/generations"), { json: openaiImagesGenerateBody(body) });
  } else {
    const form = new FormData();
    for (const [k, v] of Object.entries(openaiImagesEditFields(body))) form.append(k, v);
    refs.forEach((r, i) => form.append("image[]", new Blob([new Uint8Array(r.bytes)], { type: r.mime }), `reference-${i + 1}.${r.mime.split("/")[1] ?? "png"}`));
    const summary = { multipart: openaiImagesEditFields(body), images: refs.map((r) => `${r.mime}, ${Math.round(r.bytes.length / 1024)} KB`) };
    res = await send(ctx, "POST", joinUrl(baseUrl, "/images/edits"), { form, summary });
  }
  const json = await readJson(res);
  const items = asArray(json.data).map(asRecord).filter((x): x is Record<string, unknown> => !!x);
  if (items.length === 0) throw new ProviderError("Jawaban provider tidak berisi gambar.");
  return Promise.all(items.map((it) => fromB64OrUrl(ctx, it)));
}

async function openrouterImages(ctx: HttpCtx, body: ImageBodyInput): Promise<Buffer[]> {
  const res = await send(ctx, "POST", joinUrl(ctx.conn.baseUrl, "/images"), { json: openrouterImagesBody(body) });
  const json = await readJson(res);
  const items = asArray(json.data).map(asRecord).filter((x): x is Record<string, unknown> => !!x);
  if (items.length === 0) throw new ProviderError("Jawaban provider tidak berisi gambar.");
  return Promise.all(items.map((it) => fromB64OrUrl(ctx, it)));
}

/**
 * Venice. Editing: one input image goes to /image/edit, several to /image/multi-edit (first is edited).
 * Both answer with the image bytes. Generating goes to /image/generate (JSON), with any references
 * sent as style references.
 */
async function venice(ctx: HttpCtx, body: ImageBodyInput, editing: boolean): Promise<Buffer[]> {
  if (editing) {
    const multi = body.references.length > 1;
    const res = await send(ctx, "POST", joinUrl(ctx.conn.baseUrl, multi ? "/image/multi-edit" : "/image/edit"), { json: multi ? veniceMultiEditBody(body) : veniceEditBody(body) });
    const type = res.headers.get("content-type") ?? "";
    if (/application\/json/i.test(type)) {
      const json = await readJson(res);
      const first = asArray(json.images)[0];
      if (typeof first !== "string") throw new ProviderError("Jawaban Venice tidak berisi gambar.");
      return [requireImage(Buffer.from(first, "base64"), "Venice")];
    }
    const buf = Buffer.from(await res.arrayBuffer());
    logResponse(res, JSON.stringify({ contentType: type, bytes: buf.length }));
    if (res.headers.get("x-venice-is-blurred") === "true") {
      ctx.args.onNote("Venice memburamkan hasil ini karena safe mode menilainya konten dewasa.");
    }
    if (res.headers.get("x-venice-is-content-violation") === "true") {
      ctx.args.onNote("Venice menandai hasil ini melanggar kebijakan kontennya.");
    }
    return [requireImage(buf, "Venice")];
  }
  const res = await send(ctx, "POST", joinUrl(ctx.conn.baseUrl, "/image/generate"), { json: veniceGenerateBody(body) });
  if (res.headers.get("x-venice-is-blurred") === "true") {
    ctx.args.onNote("Venice memburamkan hasil ini karena safe mode menilainya konten dewasa.");
  }
  const json = await readJson(res);
  const images = asArray(json.images).filter((x): x is string => typeof x === "string");
  if (images.length === 0) throw new ProviderError("Jawaban Venice tidak berisi gambar.");
  return images.map((b64) => requireImage(Buffer.from(b64, "base64"), "Venice"));
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

async function dashscope(ctx: HttpCtx, body: ImageBodyInput): Promise<Buffer[]> {
  const root = dashscopeRoot(ctx.conn.baseUrl);
  const submit = await send(ctx, "POST", `${root}/services/aigc/text2image/image-synthesis`, { json: dashscopeSubmitBody(body), extraHeaders: { "x-dashscope-async": "enable" } });
  const submitted = await readJson(submit);
  const taskId = asRecord(submitted.output)?.task_id;
  if (typeof taskId !== "string") throw new ProviderError("DashScope tidak mengembalikan ID task.");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const every = ctx.deps.pollMs ?? 3000;
  while (Date.now() < deadline) {
    await sleep(every, ctx.args.signal);
    const res = await send(ctx, "GET", `${root}/tasks/${encodeURIComponent(taskId)}`, {});
    const output = asRecord((await readJson(res)).output);
    const status = output?.task_status;
    if (status === "SUCCEEDED") {
      const urls = asArray(output?.results).map((r) => asRecord(r)?.url).filter((u): u is string => typeof u === "string");
      if (urls.length === 0) throw new ProviderError("DashScope selesai tanpa gambar.");
      return Promise.all(urls.map((u) => download(ctx, u)));
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      const msg = typeof output?.message === "string" ? output.message : typeof output?.code === "string" ? output.code : status;
      throw new ProviderError(`DashScope menggagalkan task: ${msg}`);
    }
  }
  throw new ProviderError("Task DashScope belum selesai setelah 10 menit.");
}

async function chatModalities(ctx: HttpCtx, args: ImageCallArgs, modelId: string, textOutput: boolean): Promise<{ images: Buffer[]; text: string }> {
  const messages = args.chat ?? [{ role: "user" as const, text: args.prompt, images: args.references.map((r) => toDataUrl(r.mime, r.bytes)) }];
  const res = await send(ctx, "POST", joinUrl(ctx.conn.baseUrl, "/chat/completions"), { json: chatImageBody({ modelId, messages, params: args.params, textOutput }) });
  const json = await readJson(res);
  const message = asRecord(asRecord(asArray(json.choices)[0])?.message);
  const urls = asArray(message?.images)
    .map((i) => asRecord(asRecord(i)?.image_url)?.url)
    .filter((u): u is string => typeof u === "string");
  if (urls.length === 0) throw new ProviderError("Model tidak mengembalikan gambar. Mungkin model ini tidak mendukung output gambar, atau permintaannya ditolak oleh filter.");
  const images = await Promise.all(
    urls.map(async (u) => {
      const buf = fromDataUrl(u);
      return buf ? requireImage(buf, "Model") : download(ctx, u);
    }),
  );
  const text = typeof message?.content === "string" ? message.content : "";
  return { images, text };
}

/* ------------------------------------------------------------------ entry */

/**
 * Makes `n` images with whichever wire the model uses. Slots finish independently: one failed image does not
 * discard the others. Throws only when the request cannot start at all (missing key) or the run is stopped.
 */
export async function generateImages(deps: ImageCallDeps, args: ImageCallArgs): Promise<ImageCallResult> {
  const { registry } = deps;
  const model = registry.resolveModel(args.modelRowId);
  const { endpoint } = model;
  const { wire, spec, textOutput } = registry.imageSpecFor(args.modelRowId);
  const conn = registry.connectionFor(endpoint);
  const apiKey = endpoint.authType === "none" ? null : registry.getApiKey(endpoint.id);
  if (endpoint.authType !== "none" && !apiKey) {
    throw new ProviderError(`Key untuk ${endpoint.name} tidak ditemukan di penyimpanan kredensial. Masukkan ulang di Settings.`);
  }
  const ctx: HttpCtx = { deps, args, conn, apiKey, authHeader: endpoint.authHeader, name: endpoint.name, attempt: 1 };
  const refUrls = args.references.map((r) => toDataUrl(r.mime, r.bytes));
  const bodyFor = (n: number, seedOffset = 0): ImageBodyInput => ({
    modelId: model.row.modelId,
    prompt: args.prompt,
    params: seedOffset && args.params.seed !== undefined ? { ...args.params, seed: args.params.seed + seedOffset } : args.params,
    n,
    references: refUrls,
  });

  // Wires that return only one image per request run one request per slot, in parallel.
  // Venice edits answer with one image per request; its generate takes `variants`.
  const veniceEditing = wire === "venice-image" && args.references.length > 0 && (args.edit === true || spec.editOnly);
  const perSlot = wire === "dashscope-async" || wire === "chat-modalities" || veniceEditing;
  const slots: SlotResult[] = Array.from({ length: args.n }, () => ({ ok: false as const, error: "Tidak dijalankan." }));
  let text = "";

  const finishSlot = async (i: number, image: Buffer, seed?: number) => {
    const generated: GeneratedImage = { bytes: image, ...(seed !== undefined ? { seed } : {}) };
    slots[i] = { ok: true, image: generated };
    const assetId = await args.onImage(i, generated);
    args.onSlot(i, "done", { assetId, ...(seed !== undefined ? { seed } : {}) });
  };
  const failSlot = (i: number, err: unknown) => {
    if (args.signal.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    slots[i] = { ok: false, error: message };
    args.onSlot(i, "error", { error: message });
  };

  if (perSlot) {
    const queue = Array.from({ length: args.n }, (_, i) => i);
    const worker = async () => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        args.onSlot(i, "running");
        const seed = args.params.seed !== undefined ? args.params.seed + i : undefined;
        try {
          let out: Buffer[];
          if (wire === "dashscope-async") out = await dashscope(ctx, bodyFor(1, i));
          else if (wire === "venice-image") out = await venice(ctx, bodyFor(1, i), true);
          else {
            const r = await chatModalities(ctx, args, model.row.modelId, textOutput);
            out = r.images;
            if (r.text && !text) text = r.text;
          }
          await finishSlot(i, out[0]!, seed);
        } catch (err) {
          failSlot(i, err);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, args.n) }, worker));
  } else {
    for (let i = 0; i < args.n; i++) args.onSlot(i, "running");
    try {
      let out: Buffer[];
      if (wire === "openai-images") out = await openaiImages(ctx, bodyFor(args.n), args.references);
      else if (wire === "openrouter-images") out = await openrouterImages(ctx, bodyFor(args.n));
      else out = await venice(ctx, bodyFor(args.n), false);
      if (out.length < args.n) args.onNote(`Provider hanya mengembalikan ${out.length} dari ${args.n} gambar.`);
      for (let i = 0; i < args.n; i++) {
        const img = out[i];
        if (img) await finishSlot(i, img, args.n === 1 ? args.params.seed : undefined);
        else failSlot(i, new ProviderError("Provider tidak mengembalikan gambar untuk slot ini."));
      }
    } catch (err) {
      if (args.signal.aborted) throw err;
      for (let i = 0; i < args.n; i++) failSlot(i, err);
    }
  }
  return { slots, wire, spec, text };
}
