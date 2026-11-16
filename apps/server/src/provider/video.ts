import { randomUUID } from "node:crypto";
import { openrouterVideoBody, veniceVideoBody, xaiVideoBody, type VideoBodyInput, type VideoTurnMeta, type VideoWire } from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { requestLogs } from "../db/schema.js";
import type { RegistryService } from "../services/registry.js";
import { buildHeaders, joinUrl, networkError, parseProviderError, ProviderError, redactHeaders, type ConnectionInfo } from "./http.js";
import { redactImageText } from "./image.js";

const REQUEST_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** A job that is still not done after this long is given up on. */
const JOB_TIMEOUT_MS = 60 * 60_000;
const MAX_LOGGED_RESPONSE = 8000;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
/** Poll errors in a row (network, 429, 5xx) before the job is given up on. */
const MAX_POLL_FAILURES = 8;

export interface VideoCallDeps {
  db: Db;
  registry: RegistryService;
  fetchImpl: typeof fetch;
  /** Wait between polls. Tests shorten it. */
  pollMs?: number;
}

export type VideoJob = NonNullable<VideoTurnMeta["job"]>;

export interface VideoProgress {
  status: "running";
  progress?: number;
  etaMs?: number;
}

interface Ctx {
  deps: VideoCallDeps;
  conn: ConnectionInfo;
  apiKey: string | null;
  authHeader: string | null;
  name: string;
  logMessageId: string;
  signal: AbortSignal;
  attempt: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** MP4/MOV ("ftyp" box) or WebM (EBML header). */
export function sniffVideo(bytes: Buffer): { mime: string; ext: string } | null {
  if (bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp") {
    return bytes.toString("latin1", 8, 10) === "qt" ? { mime: "video/quicktime", ext: "mov" } : { mime: "video/mp4", ext: "mp4" };
  }
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return { mime: "video/webm", ext: "webm" };
  return null;
}

async function context(deps: VideoCallDeps, modelRowId: string, logMessageId: string, signal: AbortSignal): Promise<Ctx> {
  const model = deps.registry.resolveModel(modelRowId);
  const { endpoint } = model;
  const apiKey = endpoint.authType === "none" ? null : await deps.registry.credentialFor(endpoint);
  if (endpoint.authType !== "none" && !apiKey) {
    throw new ProviderError(`Key untuk ${endpoint.name} tidak ditemukan di penyimpanan kredensial. Masukkan ulang di Settings.`);
  }
  return { deps, conn: deps.registry.connectionFor(endpoint), apiKey, authHeader: endpoint.authHeader, name: endpoint.name, logMessageId, signal, attempt: 1 };
}

/**
 * One HTTP call, written to the request log when `log` is set (the many quiet polls of a job are not).
 * Non-2xx answers throw a ProviderError carrying the status.
 */
async function call(
  ctx: Ctx,
  method: "GET" | "POST",
  url: string,
  opts: { json?: unknown; auth?: boolean; log?: boolean; accept?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const auth = opts.auth !== false;
  const headers = auth ? buildHeaders(ctx.conn, ctx.apiKey, opts.accept ?? "application/json") : { accept: opts.accept ?? "*/*" };
  if (opts.json === undefined) delete (headers as Record<string, string>)["content-type"];
  const bodyText = opts.json !== undefined ? JSON.stringify(opts.json) : undefined;
  const logId = randomUUID();
  const started = Date.now();
  if (opts.log) {
    ctx.deps.db
      .insert(requestLogs)
      .values({
        id: logId,
        messageId: ctx.logMessageId,
        attempt: ctx.attempt++,
        method,
        url,
        requestHeaders: auth ? redactHeaders(headers, ctx.authHeader) : headers,
        requestBody: bodyText ? redactImageText(bodyText) : "",
        startedAt: new Date(started),
      })
      .run();
  }
  const done = (patch: { status?: number; responseText?: string | null; error?: string | null }) => {
    if (opts.log) ctx.deps.db.update(requestLogs).set({ ...patch, durationMs: Date.now() - started }).where(eq(requestLogs.id, logId)).run();
  };
  let res: Response;
  try {
    res = await ctx.deps.fetchImpl(url, {
      method,
      headers,
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS)]),
      ...(bodyText !== undefined ? { body: bodyText } : {}),
    });
  } catch (err) {
    if (ctx.signal.aborted) {
      done({ error: "Dihentikan." });
      throw err;
    }
    const perr = err instanceof Error && err.name === "TimeoutError" ? new ProviderError(`${ctx.name} tidak menjawab tepat waktu.`, { network: true }) : networkError(ctx.conn, err);
    done({ error: perr.message });
    throw perr;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    done({ status: res.status, responseText: redactImageText(text).slice(0, MAX_LOGGED_RESPONSE) });
    throw parseProviderError(res.status, text, ctx.conn);
  }
  (res as Response & { __done?: typeof done }).__done = done;
  return res;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  (res as Response & { __done?: (p: { status?: number; responseText?: string }) => void }).__done?.({ status: res.status, responseText: text.slice(0, MAX_LOGGED_RESPONSE) });
  const v = asRecord((() => { try { return JSON.parse(text) as unknown; } catch { return null; } })());
  if (!v) throw new ProviderError(`Provider mengirim jawaban yang bukan JSON: ${text.slice(0, 200)}`);
  return v;
}

async function readVideo(res: Response, source: string): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_VIDEO_BYTES) throw new ProviderError(`Video dari ${source} lebih besar dari ${MAX_VIDEO_BYTES / 1024 / 1024} MB.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  (res as Response & { __done?: (p: { status?: number; responseText?: string }) => void }).__done?.({ status: res.status, responseText: `[video ${(bytes.length / 1024 / 1024).toFixed(1)} MB]` });
  if (!sniffVideo(bytes)) throw new ProviderError(`${source} mengirim data yang bukan video.`);
  return bytes;
}

/** Transient poll trouble (network, rate limit, provider busy): keep waiting instead of failing the paid job. */
function transient(err: unknown): boolean {
  if (!(err instanceof ProviderError)) return false;
  return err.opts.network === true || err.status === 429 || (err.status !== undefined && err.status >= 500);
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

/* ------------------------------------------------------------------ submit */

export interface SubmitArgs {
  modelRowId: string;
  wire: VideoWire;
  body: VideoBodyInput;
  logMessageId: string;
  signal: AbortSignal;
}

/** Sends the job. The returned job must be saved before polling, so a restart can pick it up. */
export async function submitVideo(deps: VideoCallDeps, args: SubmitArgs): Promise<VideoJob> {
  const ctx = await context(deps, args.modelRowId, args.logMessageId, args.signal);
  const base = ctx.conn.baseUrl;
  const submittedAt = new Date().toISOString();
  switch (args.wire) {
    case "openrouter-videos": {
      const json = await readJson(await call(ctx, "POST", joinUrl(base, "/videos"), { json: openrouterVideoBody(args.body), log: true }));
      const id = asString(json.id);
      if (!id) throw new ProviderError("OpenRouter tidak mengembalikan ID job video.");
      return { id, submittedAt };
    }
    case "venice-video": {
      const json = await readJson(await call(ctx, "POST", joinUrl(base, "/video/queue"), { json: veniceVideoBody(args.body), log: true }));
      const id = asString(json.queue_id);
      if (!id) throw new ProviderError("Venice tidak mengembalikan queue_id.");
      const downloadUrl = asString(json.download_url);
      return { id, submittedAt, ...(downloadUrl ? { downloadUrl } : {}) };
    }
    case "xai-videos": {
      const json = await readJson(await call(ctx, "POST", joinUrl(base, "/videos/generations"), { json: xaiVideoBody(args.body), log: true }));
      const id = asString(json.request_id);
      if (!id) throw new ProviderError("xAI tidak mengembalikan request_id.");
      return { id, submittedAt };
    }
  }
}

/* -------------------------------------------------------------------- wait */

export interface WaitArgs {
  modelRowId: string;
  /** The model id sent at submit (Venice's retrieve still accepts it). */
  modelId: string;
  wire: VideoWire;
  job: VideoJob;
  logMessageId: string;
  signal: AbortSignal;
  onProgress: (p: VideoProgress) => void;
  onDownloading: () => void;
}

export interface VideoResult {
  bytes: Buffer;
  costUsd?: number;
}

type PollState = { done: false; progress?: number; etaMs?: number } | { done: true; bytes?: Buffer; url?: string; urlAuth?: boolean; costUsd?: number };

async function pollOnce(ctx: Ctx, args: WaitArgs): Promise<PollState> {
  const base = ctx.conn.baseUrl;
  switch (args.wire) {
    case "openrouter-videos": {
      const json = await readJson(await call(ctx, "GET", joinUrl(base, `/videos/${encodeURIComponent(args.job.id)}`)));
      const status = asString(json.status);
      if (status === "completed") {
        const urls = Array.isArray(json.unsigned_urls) ? json.unsigned_urls.filter((u): u is string => typeof u === "string") : [];
        const usage = asRecord(json.usage);
        return { done: true, url: urls[0] ?? joinUrl(base, `/videos/${encodeURIComponent(args.job.id)}/content?index=0`), urlAuth: true, ...(asNumber(usage?.cost) !== null ? { costUsd: asNumber(usage?.cost)! } : {}) };
      }
      if (status === "failed" || status === "cancelled" || status === "expired") {
        throw new ProviderError(asString(json.error) ?? `Job video OpenRouter berakhir dengan status ${status}.`);
      }
      return { done: false };
    }
    case "venice-video": {
      const res = await call(ctx, "POST", joinUrl(base, "/video/retrieve"), { json: { model: args.modelId, queue_id: args.job.id }, accept: "application/json, video/mp4", timeoutMs: DOWNLOAD_TIMEOUT_MS });
      const type = res.headers.get("content-type") ?? "";
      if (type.startsWith("video/")) return { done: true, bytes: await readVideo(res, ctx.name) };
      const json = await readJson(res);
      if (json.status === "COMPLETED") {
        if (!args.job.downloadUrl) throw new ProviderError("Venice menyatakan video selesai tetapi tidak ada tautan unduhan.");
        return { done: true, url: args.job.downloadUrl, urlAuth: false };
      }
      const avg = asNumber(json.average_execution_time);
      const ran = asNumber(json.execution_duration);
      return { done: false, ...(avg ? { etaMs: avg } : {}), ...(avg && ran !== null ? { progress: Math.min(99, Math.round((ran / avg) * 100)) } : {}) };
    }
    case "xai-videos": {
      const json = await readJson(await call(ctx, "GET", joinUrl(base, `/videos/${encodeURIComponent(args.job.id)}`)));
      const status = asString(json.status);
      if (status === "done") {
        const video = asRecord(json.video);
        if (video?.respect_moderation === false) throw new ProviderError("Video ditolak moderasi xAI, jadi tidak ada hasil yang bisa diunduh.");
        const url = asString(video?.url);
        if (!url) throw new ProviderError("xAI menyatakan video selesai tetapi tidak ada URL video.");
        const ticks = asNumber(asRecord(json.usage)?.cost_in_usd_ticks);
        return { done: true, url, urlAuth: false, ...(ticks !== null ? { costUsd: ticks / 1e10 } : {}) };
      }
      if (status === "failed" || status === "expired") {
        const error = asRecord(json.error);
        throw new ProviderError(asString(error?.message) ?? `Job video xAI berakhir dengan status ${status}.`);
      }
      const progress = asNumber(json.progress);
      return { done: false, ...(progress !== null ? { progress } : {}) };
    }
  }
}

/** Polls until the job is done, then downloads the video. Transient trouble while waiting is ridden out. */
export async function waitForVideo(deps: VideoCallDeps, args: WaitArgs): Promise<VideoResult> {
  const ctx = await context(deps, args.modelRowId, args.logMessageId, args.signal);
  const interval = deps.pollMs ?? (args.wire === "openrouter-videos" ? 10_000 : 5_000);
  const deadline = new Date(args.job.submittedAt).getTime() + JOB_TIMEOUT_MS;
  let failures = 0;
  for (;;) {
    let state: PollState;
    try {
      state = await pollOnce(ctx, args);
      failures = 0;
    } catch (err) {
      if (args.signal.aborted || !transient(err) || ++failures >= MAX_POLL_FAILURES) throw err;
      await sleep(interval * Math.min(failures, 4), args.signal);
      continue;
    }
    if (state.done) {
      args.onDownloading();
      let bytes = state.bytes;
      if (!bytes) {
        const res = await call(ctx, "GET", state.url!, { auth: state.urlAuth === true, log: true, accept: "video/*", timeoutMs: DOWNLOAD_TIMEOUT_MS });
        bytes = await readVideo(res, ctx.name);
      }
      if (args.wire === "venice-video") {
        // Venice keeps the file until told; it is saved here now.
        await call(ctx, "POST", joinUrl(ctx.conn.baseUrl, "/video/complete"), { json: { model: args.modelId, queue_id: args.job.id } }).catch(() => {});
      }
      return { bytes, ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}) };
    }
    args.onProgress({ status: "running", ...(state.progress !== undefined ? { progress: state.progress } : {}), ...(state.etaMs !== undefined ? { etaMs: state.etaMs } : {}) });
    if (Date.now() > deadline) throw new ProviderError(`Video belum selesai setelah ${JOB_TIMEOUT_MS / 60_000} menit, jadi EZClaw berhenti menunggu.`);
    await sleep(interval, args.signal);
  }
}

/** Venice's price for a job before it is sent, in USD; null when it cannot be asked. */
export async function quoteVideo(deps: VideoCallDeps, modelRowId: string, body: Record<string, unknown>, signal: AbortSignal): Promise<number | null> {
  try {
    const ctx = await context(deps, modelRowId, "", signal);
    const json = await readJson(await call(ctx, "POST", joinUrl(ctx.conn.baseUrl, "/video/quote"), { json: body }));
    return asNumber(json.quote);
  } catch {
    return null;
  }
}
