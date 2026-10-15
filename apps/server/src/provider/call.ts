import { randomUUID } from "node:crypto";
import {
  buildChatRequest,
  findRejectedKey,
  type CanonicalMessage,
  type ChatParams,
  type FinishReason,
  type Protocol,
  type RawTurn,
  type StreamEvent,
  type ToolDef,
  type Usage,
} from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { requestLogs } from "../db/schema.js";
import type { RegistryService } from "../services/registry.js";
import { getSettings } from "../settings.js";
import { parseAnthropicStream } from "./anthropicStream.js";
import { buildHeaders, joinUrl, networkError, parseProviderError, ProviderError, redactHeaders } from "./http.js";
import { parseOpenAIStream } from "./openaiStream.js";
import { parseResponsesStream } from "./responsesStream.js";

const IDLE_TIMEOUT_MS = 180_000;
const MAX_LOGGED_RESPONSE = 8000;
const RETRYABLE_STATUS = new Set([400, 422]);

export interface ToolCallRequest {
  callId: string;
  name: string;
  argsText: string;
}

/** Everything gathered from one model call. The caller creates it so a partial answer survives an error or a stop. */
export interface TurnAccumulator {
  text: string[];
  reasoning: string[];
  signature?: string;
  toolCalls: ToolCallRequest[];
  raw?: RawTurn;
  usage: Usage;
  finish: FinishReason | null;
  notes: string[];
  modelLabel: string | null;
}

export function newAccumulator(): TurnAccumulator {
  return { text: [], reasoning: [], toolCalls: [], usage: {}, finish: null, notes: [], modelLabel: null };
}

export interface ModelCallArgs {
  modelRowId: string;
  params: ChatParams;
  system?: string;
  messages: CanonicalMessage[];
  tools?: ToolDef[];
  /** Assistant message the request logs belong to. */
  logMessageId: string;
  /** Aborts when the owner presses Stop. */
  signal: AbortSignal;
  onText: (delta: string) => void;
  onReasoning: (delta: string) => void;
  onNote: (text: string) => void;
  onUsage: (usage: Usage) => void;
}

export interface ModelCallDeps {
  db: Db;
  registry: RegistryService;
  fetchImpl: typeof fetch;
}

/**
 * One request to the model, with the parts every mode shares: request building, logging with
 * secrets hidden, an idle timeout, and the single retry without a field the provider rejected.
 * Throws ProviderError on failure, or the abort error when `signal` fires; either way `acc`
 * holds whatever arrived before.
 */
export async function callModel(deps: ModelCallDeps, args: ModelCallArgs, acc: TurnAccumulator): Promise<void> {
  const { db, registry, fetchImpl } = deps;
  const model = registry.resolveModel(args.modelRowId);
  const { endpoint, resolved } = model;
  acc.modelLabel = `${endpoint.name} / ${model.row.modelId}`;
  const conn = registry.connectionFor(endpoint);
  const apiKey = endpoint.authType === "none" ? null : registry.getApiKey(endpoint.id);
  if (endpoint.authType !== "none" && !apiKey) {
    throw new ProviderError(`Key untuk ${endpoint.name} tidak ditemukan di penyimpanan kredensial. Masukkan ulang di Settings.`);
  }

  const note = (t: string) => {
    if (acc.notes.includes(t)) return;
    acc.notes.push(t);
    args.onNote(t);
  };
  const sessionOmit: string[] = [];
  const autoRetry = getSettings(db).autoRetryRejectedParams;
  const protocol = endpoint.protocol as Protocol;

  for (let attempt = 1; ; attempt++) {
    const built = buildChatRequest({
      protocol,
      modelId: model.row.modelId,
      profile: resolved.profile,
      params: args.params,
      system: args.system,
      messages: args.messages,
      tools: args.tools,
      omit: [...resolved.omit, ...sessionOmit],
    });
    for (const n of built.notes) note(n);
    // A field this very call just retried without was already explained by the retry note.
    for (const d of built.dropped) if (!sessionOmit.includes(d.param)) note(`${d.param} tidak dikirim: ${d.reason}`);

    const url = joinUrl(endpoint.baseUrl, built.path);
    const headers = buildHeaders(conn, apiKey, "text/event-stream");
    const bodyText = JSON.stringify(built.body);
    const logId = randomUUID();
    const logStart = Date.now();
    db.insert(requestLogs)
      .values({
        id: logId,
        messageId: args.logMessageId,
        attempt,
        method: "POST",
        url,
        requestHeaders: redactHeaders(headers, endpoint.authHeader),
        requestBody: bodyText,
        startedAt: new Date(logStart),
      })
      .run();
    const logDone = (patch: { status?: number; responseText?: string | null; error?: string | null }) =>
      db
        .update(requestLogs)
        .set({ ...patch, durationMs: Date.now() - logStart })
        .where(eq(requestLogs.id, logId))
        .run();

    const idle = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), IDLE_TIMEOUT_MS);
    };
    const signal = AbortSignal.any([args.signal, idle.signal]);

    try {
      armIdle();
      let res: Response;
      try {
        res = await fetchImpl(url, { method: "POST", headers, body: bodyText, signal });
      } catch (err) {
        if (args.signal.aborted) throw err;
        if (idle.signal.aborted) throw new ProviderError(`Tidak ada respons dari ${endpoint.name} selama ${IDLE_TIMEOUT_MS / 1000} detik.`, { network: true });
        throw networkError(conn, err);
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        logDone({ status: res.status, responseText: errText.slice(0, MAX_LOGGED_RESPONSE) });
        const perr = parseProviderError(res.status, errText, conn);
        if (autoRetry && attempt === 1 && RETRYABLE_STATUS.has(res.status)) {
          const key = findRejectedKey({ message: perr.opts.raw ?? "", param: perr.opts.param, bodyKeys: Object.keys(built.body) });
          if (key) {
            registry.learnOmit(args.modelRowId, key);
            sessionOmit.push(key);
            note(`Field "${key}" ditolak model ini, jadi dikirim ulang tanpanya. Model ini tidak akan menerimanya lagi (bisa dibatalkan di Profil model).`);
            continue;
          }
        }
        throw perr;
      }

      let events = 0;
      for await (const ev of streamEvents(res, protocol, endpoint.kind === "local" || endpoint.presetId === "custom")) {
        armIdle();
        events++;
        applyEvent(acc, ev, args);
      }
      logDone({
        status: res.status,
        responseText: JSON.stringify({
          finishReason: acc.finish,
          usage: acc.usage,
          textChars: acc.text.join("").length,
          reasoningChars: acc.reasoning.join("").length,
          toolCalls: acc.toolCalls.map((c) => c.name),
          events,
        }),
      });
      return;
    } catch (err) {
      if (args.signal.aborted) logDone({ error: "Dihentikan oleh pengguna." });
      else if (idle.signal.aborted) logDone({ error: `Tidak ada data dari ${endpoint.name}.` });
      else logDone({ error: err instanceof Error ? err.message : String(err) });
      if (idle.signal.aborted && !args.signal.aborted) {
        throw new ProviderError(`Koneksi ke ${endpoint.name} berhenti mengirim data selama ${IDLE_TIMEOUT_MS / 1000} detik.`, { network: true });
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }
  }
}

function applyEvent(acc: TurnAccumulator, ev: StreamEvent, args: ModelCallArgs) {
  switch (ev.type) {
    case "text":
      acc.text.push(ev.delta);
      args.onText(ev.delta);
      break;
    case "reasoning":
      acc.reasoning.push(ev.delta);
      args.onReasoning(ev.delta);
      break;
    case "reasoning_signature":
      acc.signature = (acc.signature ?? "") + ev.signature;
      break;
    case "tool_call":
      acc.toolCalls.push({ callId: ev.callId, name: ev.name, argsText: ev.argsText });
      break;
    case "raw":
      acc.raw = ev.raw;
      break;
    case "usage":
      acc.usage = { ...acc.usage, ...ev.usage };
      args.onUsage(ev.usage);
      break;
    case "finish":
      acc.finish = ev.reason;
      break;
  }
}

/** Picks the right stream parser, and copes with servers that ignore `stream: true`. */
function streamEvents(res: Response, protocol: Protocol, parseThinkTags: boolean): AsyncGenerator<StreamEvent> {
  const type = res.headers.get("content-type") ?? "";
  if (!res.body) throw new ProviderError("Provider membalas tanpa isi (body kosong).");
  if (type.includes("application/json")) return nonStreaming(res, protocol);
  if (protocol === "anthropic") return parseAnthropicStream(res.body);
  if (protocol === "openai-responses") return parseResponsesStream(res.body);
  return parseOpenAIStream(res.body, { parseThinkTags });
}

type Json = Record<string, unknown>;
const isRec = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

async function* nonStreaming(res: Response, protocol: Protocol): AsyncGenerator<StreamEvent> {
  const json = (await res.json()) as Json;
  const err = json.error;
  if (err) {
    const msg = isRec(err) && typeof err.message === "string" ? err.message : "Provider membalas dengan error.";
    throw new ProviderError(msg, { raw: msg });
  }

  let sawCall = false;
  if (protocol === "anthropic") {
    const blocks = Array.isArray(json.content) ? (json.content as Json[]) : [];
    for (const b of blocks) {
      if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking) yield { type: "reasoning", delta: b.thinking };
      if (b.type === "text" && typeof b.text === "string") yield { type: "text", delta: b.text };
      if (b.type === "tool_use" && typeof b.id === "string") {
        sawCall = true;
        yield { type: "tool_call", callId: b.id, name: String(b.name ?? ""), argsText: JSON.stringify(b.input ?? {}) };
      }
    }
    if (blocks.length) yield { type: "raw", raw: { protocol: "anthropic", data: blocks } };
  } else if (protocol === "openai-responses") {
    const items = Array.isArray(json.output) ? (json.output as Json[]) : [];
    for (const item of items) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const c of item.content as Json[]) if (c.type === "output_text" && typeof c.text === "string") yield { type: "text", delta: c.text };
      }
      if (item.type === "reasoning" && Array.isArray(item.content)) {
        for (const c of item.content as Json[]) if (typeof c.text === "string") yield { type: "reasoning", delta: c.text };
      }
      if (item.type === "function_call") {
        sawCall = true;
        yield { type: "tool_call", callId: String(item.call_id ?? item.id ?? ""), name: String(item.name ?? ""), argsText: String(item.arguments ?? "{}") };
      }
    }
    if (items.length) yield { type: "raw", raw: { protocol: "openai-responses", data: items } };
  } else {
    const choice = Array.isArray(json.choices) ? (json.choices[0] as Json | undefined) : undefined;
    const message = isRec(choice?.message) ? choice.message : {};
    const r = message.reasoning_content ?? message.reasoning;
    if (typeof r === "string" && r) yield { type: "reasoning", delta: r };
    if (typeof message.content === "string" && message.content) yield { type: "text", delta: message.content };
    const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [];
    for (const c of calls) {
      const fn = isRec(c.function) ? c.function : {};
      sawCall = true;
      yield { type: "tool_call", callId: String(c.id ?? `call_${randomUUID().slice(0, 6)}`), name: String(fn.name ?? ""), argsText: String(fn.arguments ?? "{}") };
    }
    if (Object.keys(message).length) yield { type: "raw", raw: { protocol: "openai-chat", data: message } };
  }
  yield { type: "finish", reason: sawCall ? "tool_calls" : "other" };
}
