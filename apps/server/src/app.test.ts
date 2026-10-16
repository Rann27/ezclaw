import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_HEADER, TOKEN_PLACEHOLDER, type ApiErrorBody } from "@ezclaw/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { BASE, TOKEN, createTestContext, type TestContext } from "./testing/harness.js";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

let ctx: TestContext;
beforeEach(() => {
  ctx = createTestContext();
});
afterEach(async () => {
  await ctx.dispose();
});

const req = (path: string, init?: RequestInit & { headers?: Record<string, string> }) => ctx.req(path, init);

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as ApiErrorBody).error.code;
}

describe("local security", () => {
  it("rejects a foreign Host header on every route", async () => {
    expect((await req("/api/health", { headers: { host: "evil.example:8787" } })).status).toBe(403);
    expect((await req("/", { headers: { host: "evil.example:8787" } })).status).toBe(403);
  });

  it("rejects API calls without or with a wrong session token", async () => {
    expect((await req("/api/health", { headers: { [TOKEN_HEADER]: "" } })).status).toBe(401);
    expect((await req("/api/health", { headers: { [TOKEN_HEADER]: "x".repeat(43) } })).status).toBe(401);
  });

  it("rejects a valid token sent from a foreign origin or a cross-site fetch", async () => {
    expect((await req("/api/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await req("/api/health", { headers: { origin: "null" } })).status).toBe(403);
    expect((await req("/api/health", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("accepts our own origin and the configured dev origin", async () => {
    expect((await req("/api/health", { headers: { origin: "http://127.0.0.1:8787" } })).status).toBe(200);
    expect((await req("/api/health", { headers: { origin: "http://localhost:5173" } })).status).toBe(200);
  });

  it("protects every new route, including the SSE stream and key endpoints", async () => {
    for (const [method, path] of [
      ["GET", "/api/endpoints"],
      ["PUT", "/api/endpoints/x/key"],
      ["GET", "/api/models"],
      ["POST", "/api/threads"],
      ["GET", "/api/runs/x/events"],
      ["GET", "/api/messages/x/request-logs"],
    ] as const) {
      const res = await req(path, { method, headers: { [TOKEN_HEADER]: "" } });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("sets anti-framing headers", async () => {
    const res = await req("/api/health");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("api", () => {
  it("reports health with the data paths and where keys are stored", async () => {
    const body = await (await req("/api/health")).json();
    expect(body).toMatchObject({ ok: true, listen: "127.0.0.1:8787", dataDir: ctx.tmp, secretStore: { backend: "memory" } });
  });

  it("returns default settings, persists a theme change, and keeps it after restart", async () => {
    expect(await ctx.json("/api/settings")).toEqual({ theme: "system", defaultModels: {}, autoRetryRejectedParams: true, codexDir: null, webSearchProvider: null, skillDirs: [] });

    const put = await req("/api/settings", { method: "PUT", body: JSON.stringify({ theme: "dark" }) });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ theme: "dark", autoRetryRejectedParams: true });

    await ctx.restart();
    expect(await ctx.json("/api/settings")).toMatchObject({ theme: "dark" });
  });

  it("rejects invalid settings with a 400 and a readable message", async () => {
    const badTheme = await req("/api/settings", { method: "PUT", body: JSON.stringify({ theme: "blue" }) });
    expect(badTheme.status).toBe(400);
    expect(await errorCode(badTheme)).toBe("invalid_request");

    expect((await req("/api/settings", { method: "PUT", body: JSON.stringify({ font: "x" }) })).status).toBe(400);

    const notJson = await req("/api/settings", { method: "PUT", body: "{" });
    expect(notJson.status).toBe(400);
    expect(await errorCode(notJson)).toBe("invalid_json");
  });

  it("falls back to the default when a stored setting no longer matches its schema", async () => {
    ctx.opened.sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('theme', '\"sepia\"', 0)").run();
    expect(await ctx.json("/api/settings")).toMatchObject({ theme: "system" });
  });

  it("lists threads per mode and validates the mode", async () => {
    expect(await ctx.json("/api/threads?mode=chat")).toEqual({ threads: [] });
    expect((await req("/api/threads?mode=video")).status).toBe(400);
  });

  it("answers unknown API paths with a JSON 404", async () => {
    const res = await req("/api/nope");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("web handler", () => {
  it("explains how to run the UI when the web build is missing", async () => {
    const res = await req("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pnpm dev");
  });

  it("injects the session token into index.html and serves assets", async () => {
    const dist = join(ctx.tmp, "web");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), `<meta name="ezclaw-session" content="${TOKEN_PLACEHOLDER}">`);
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");

    const page = await req("/agent");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`content="${TOKEN}"`);

    const asset = await req("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
  });

  it("does not serve files outside the web build", async () => {
    const dist = join(ctx.tmp, "web");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "ok");
    writeFileSync(join(ctx.tmp, "secret.txt"), "secret");
    expect((await req("/%2e%2e/secret.txt")).status).toBe(404);
  });
});

describe("config", () => {
  it("refuses non-loopback dev origins and short tokens", () => {
    expect(() => loadConfig(appRoot, { EZCLAW_DEV_ORIGIN: "http://192.168.1.5:5173" })).toThrow(/loopback/);
    expect(() => loadConfig(appRoot, { EZCLAW_SESSION_TOKEN: "short" })).toThrow(/minimal/);
    expect(() => loadConfig(appRoot, { EZCLAW_PORT: "99999" })).toThrow(/EZCLAW_PORT/);
  });

  it("generates a fresh token per launch when none is given", () => {
    const a = loadConfig(appRoot, {});
    const b = loadConfig(appRoot, {});
    expect(a.sessionToken).not.toBe(b.sessionToken);
    expect(a.sessionToken.length).toBeGreaterThanOrEqual(32);
  });
});

void BASE;
