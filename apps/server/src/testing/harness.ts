import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_HEADER, type RunEvent } from "@ezclaw/core";
import { createApp } from "../app.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { openDatabase } from "../db/client.js";
import { MemoryStore } from "../secrets.js";
import { createServices, type Services } from "../services/index.js";

const appRoot = fileURLToPath(new URL("../..", import.meta.url));
export const TOKEN = "t".repeat(43);
export const BASE = "http://127.0.0.1:8787";

export interface TestContext {
  tmp: string;
  config: ServerConfig;
  opened: ReturnType<typeof openDatabase>;
  services: Services;
  secrets: MemoryStore;
  app: ReturnType<typeof createApp>;
  req(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<Response>;
  json<T = any>(path: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<T>;
  /** Reopens the database and rebuilds services, as a server restart would. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export function createTestContext(env: Record<string, string> = {}): TestContext {
  const tmp = mkdtempSync(join(tmpdir(), "ezclaw-test-"));
  const config = loadConfig(appRoot, {
    EZCLAW_DATA_DIR: tmp,
    EZCLAW_SESSION_TOKEN: TOKEN,
    EZCLAW_WEB_DIST: join(tmp, "web"),
    EZCLAW_DEV_ORIGIN: "http://localhost:5173",
    ...env,
  });
  const secrets = new MemoryStore();

  const ctx = { tmp, config, secrets } as TestContext;
  const build = () => {
    ctx.opened = openDatabase({ file: join(tmp, "ezclaw.db"), migrationsDir: config.migrationsDir });
    ctx.services = createServices({ db: ctx.opened.db, secrets, assetsDir: join(ctx.tmp, "assets"), imagePollMs: 5 });
    ctx.app = createApp({ config, db: ctx.opened.db, dbPath: ctx.opened.file, startedAt: new Date(), services: ctx.services });
  };
  build();

  ctx.req = async (path, init = {}) =>
    ctx.app.request(`${BASE}${path}`, {
      ...init,
      headers: { host: "127.0.0.1:8787", [TOKEN_HEADER]: TOKEN, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
  ctx.json = async (path, init) => {
    const res = await ctx.req(path, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as never;
  };
  ctx.restart = async () => {
    await ctx.services.runs.stopAll();
    ctx.opened.sqlite.close();
    build();
  };
  ctx.dispose = async () => {
    await ctx.services.runs.stopAll();
    ctx.opened.sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  };
  return ctx;
}

/** Reads a run's SSE stream to the end and returns the events in order. */
export async function collectRun(ctx: TestContext, runId: string, after = 0): Promise<RunEvent[]> {
  const res = await ctx.req(`/api/runs/${runId}/events?after=${after}`);
  if (!res.ok || !res.body) throw new Error(`events -> ${res.status}`);
  const events: RunEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (event && event !== "ping" && data) events.push(JSON.parse(data) as RunEvent);
    }
  }
  return events;
}
