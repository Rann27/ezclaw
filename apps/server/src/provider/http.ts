import type { AuthType } from "@ezclaw/registry";
import type { Protocol } from "@ezclaw/core";

export interface ConnectionInfo {
  protocol: Protocol;
  baseUrl: string;
  authType: AuthType;
  authHeader: string | null;
  extraHeaders: Record<string, string>;
  name: string;
  isLocal: boolean;
}

export const ANTHROPIC_VERSION = "2023-06-01";

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function buildHeaders(conn: ConnectionInfo, apiKey: string | null, accept: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json", accept };
  if (conn.protocol === "anthropic") headers["anthropic-version"] = ANTHROPIC_VERSION;
  Object.assign(headers, conn.extraHeaders);
  if (apiKey) {
    if (conn.authType === "bearer") headers.authorization = `Bearer ${apiKey}`;
    else if (conn.authType === "header" && conn.authHeader) headers[conn.authHeader.toLowerCase()] = apiKey;
  }
  return headers;
}

const SECRET_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "proxy-authorization", "cookie"]);

/** Copies headers for storage, hiding anything that carries a credential. */
export function redactHeaders(headers: Record<string, string>, authHeader: string | null): Record<string, string> {
  const secret = new Set(SECRET_HEADERS);
  if (authHeader) secret.add(authHeader.toLowerCase());
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = secret.has(name.toLowerCase()) ? "[disembunyikan]" : value;
  }
  return out;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly opts: {
      status?: number;
      /** The field the provider blames, when it says so. */
      param?: string | null;
      code?: string | null;
      /** The provider's own message, unmodified. */
      raw?: string;
      network?: boolean;
    } = {},
  ) {
    super(message);
  }
  get status() {
    return this.opts.status;
  }
}

function pickMessage(body: unknown): { message: string | null; param: string | null; code: string | null } {
  if (typeof body !== "object" || body === null) return { message: null, param: null, code: null };
  const root = body as Record<string, unknown>;
  const err = (typeof root.error === "object" && root.error !== null ? root.error : root) as Record<string, unknown>;
  const message = typeof err.message === "string" ? err.message : typeof root.message === "string" ? root.message : typeof root.error === "string" ? root.error : null;
  const param = typeof err.param === "string" ? err.param : null;
  const code = typeof err.code === "string" ? err.code : typeof err.type === "string" ? err.type : null;
  return { message, param, code };
}

/** Parses an error response (OpenAI-style, Anthropic-style, or plain text) into a ProviderError. */
export function parseProviderError(status: number, text: string, conn: Pick<ConnectionInfo, "name" | "isLocal" | "baseUrl">): ProviderError {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: HTML error page or plain text.
  }
  const { message, param, code } = pickMessage(parsed);
  const raw = (message ?? text).trim().slice(0, 2000);
  const detail = raw ? ` Pesan provider: ${raw}` : "";

  let friendly: string;
  switch (status) {
    case 401:
      friendly = `${conn.name} menolak key (401). Periksa key di Settings, bagian Endpoint.${detail}`;
      break;
    case 402:
      friendly = `${conn.name} meminta pembayaran (402): saldo atau kuota habis.${detail}`;
      break;
    case 403:
      friendly = `${conn.name} melarang akses (403). Key tidak punya izin untuk model atau wilayah ini.${detail}`;
      break;
    case 404:
      friendly = `${conn.name} tidak menemukan alamat atau model (404). Periksa base URL dan ID model.${detail}`;
      break;
    case 429:
      friendly = `${conn.name} membatasi laju request (429). Tunggu sebentar lalu coba lagi.${detail}`;
      break;
    default:
      friendly = status >= 500 ? `${conn.name} sedang bermasalah (${status}).${detail}` : `${conn.name} menolak request (${status}).${detail}`;
  }
  return new ProviderError(friendly, { status, param, code, raw });
}

export function networkError(conn: Pick<ConnectionInfo, "name" | "isLocal" | "baseUrl">, cause: unknown): ProviderError {
  const reason = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
  const hint = conn.isLocal ? ` Pastikan server ${conn.name} berjalan.` : " Periksa koneksi internet dan base URL.";
  return new ProviderError(`Tidak bisa menjangkau ${conn.baseUrl} (${reason}).${hint}`, { network: true });
}

/** Last 4 characters, for showing which key is stored. */
export function keyLast4(key: string): string {
  return key.slice(-4);
}
