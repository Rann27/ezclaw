import { TOKEN_HEADER, TOKEN_META, type ApiErrorBody, type RunEvent } from "@ezclaw/core";
import { readSse } from "./lib/sse";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const UNREACHABLE = "Server EZClaw tidak terjangkau. Pastikan proses server di terminal masih berjalan.";

function sessionToken(): string {
  return document.querySelector<HTMLMetaElement>(`meta[name="${TOKEN_META}"]`)?.content ?? "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(TOKEN_HEADER, sessionToken());
  if (init.body !== undefined) headers.set("content-type", "application/json");

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, "unreachable", UNREACHABLE);
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // The dev proxy answers with a non-JSON 5xx when the API process is down.
    }
    if (!body?.error) {
      throw res.status >= 500
        ? new ApiError(res.status, "unreachable", UNREACHABLE)
        : new ApiError(res.status, "http_error", `Server membalas status ${res.status}.`);
    }
    throw new ApiError(res.status, body.error.code, body.error.message);
  }
  return (await res.json()) as T;
}

/**
 * Follows a run's event stream until it ends. `after` is how many events were already seen,
 * so a reconnect continues where it left off. Resolves when the run is done or the signal aborts.
 */
export async function followRun(
  runId: string,
  opts: { after?: number; signal?: AbortSignal; onEvent: (event: RunEvent, index: number) => void },
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/runs/${runId}/events?after=${opts.after ?? 0}`, {
      headers: { [TOKEN_HEADER]: sessionToken(), accept: "text/event-stream" },
      signal: opts.signal,
    });
  } catch (err) {
    if (opts.signal?.aborted) return;
    throw new ApiError(0, "unreachable", UNREACHABLE);
  }
  if (!res.ok || !res.body) {
    let message = `Server membalas status ${res.status}.`;
    let code = "http_error";
    try {
      const body = (await res.json()) as ApiErrorBody;
      message = body.error.message;
      code = body.error.code;
    } catch {
      // keep the generic message
    }
    throw new ApiError(res.status, code, message);
  }
  let index = opts.after ?? 0;
  try {
    for await (const frame of readSse(res.body, opts.signal)) {
      if (frame.event === "ping") continue;
      opts.onEvent(JSON.parse(frame.data) as RunEvent, index++);
    }
  } catch (err) {
    if (opts.signal?.aborted) return;
    throw err;
  }
}
