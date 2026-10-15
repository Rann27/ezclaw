import {
  approvalDecisionSchema,
  askAnswerSchema,
  codexDirSchema,
  endpointInputSchema,
  harnessProfilePatchSchema,
  endpointPatchSchema,
  keyInputSchema,
  manualModelSchema,
  modeSchema,
  modelPatchSchema,
  sendEditSchema,
  sendImageSchema,
  sendMessageSchema,
  settingsPatchSchema,
  threadCreateSchema,
  threadPatchSchema,
  workspaceCheckSchema,
  type ApprovalRuleDto,
  type CatalogResponse,
  type CodexStatusResponse,
  type HarnessListResponse,
  type RecentWorkspacesResponse,
  type WorkspaceCheckResponse,
  type EndpointListResponse,
  type HealthResponse,
  type ModelListResponse,
  type RequestLogResponse,
  type ThreadListResponse,
} from "@ezclaw/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { desc, isNotNull } from "drizzle-orm";
import { ZodError } from "zod";
import { readCodexCatalog } from "./agent/harness.js";
import { allTools } from "./agent/tools.js";
import { defaultShell } from "./agent/shell.js";
import { Workspace } from "./agent/workspace.js";
import { threads } from "./db/schema.js";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { HttpError, errorBody } from "./errors.js";
import { MAX_ASSET_BYTES } from "./services/assets.js";
import { apiGuard, hostGuard, securityHeaders } from "./security.js";
import type { Services } from "./services/index.js";
import { getSettings, updateSettings } from "./settings.js";
import { webHandler } from "./web.js";

export interface AppDeps {
  config: ServerConfig;
  db: Db;
  dbPath: string;
  startedAt: Date;
  services: Services;
}

const HEARTBEAT_MS = 15_000;

export function createApp({ config, db, dbPath, startedAt, services }: AppDeps) {
  const { registry, runs, chat, secrets, harness, rules, assets, image } = services;
  const app = new Hono();
  app.use("*", hostGuard(config.allowedHosts));
  app.use("*", securityHeaders);

  const api = new Hono();
  api.use("*", apiGuard({ allowedOrigins: config.allowedOrigins, sessionToken: config.sessionToken }));

  api.get("/health", (c) =>
    c.json<HealthResponse>({
      ok: true,
      version: config.version,
      listen: `${config.host}:${config.port}`,
      dataDir: config.dataDir,
      dbPath,
      startedAt: startedAt.toISOString(),
      secretStore: secrets.status(),
    }),
  );

  /* ---------------------------------------------------------------- settings */
  api.get("/settings", (c) => c.json(getSettings(db)));
  api.put("/settings", async (c) => {
    const patch = settingsPatchSchema.parse(await readJson(c.req.raw));
    return c.json(updateSettings(db, patch));
  });

  /* ---------------------------------------------------------------- endpoints */
  api.get("/catalog", (c) => c.json<CatalogResponse>(registry.catalog()));
  api.get("/endpoints", (c) => c.json<EndpointListResponse>({ endpoints: registry.listEndpoints() }));
  api.post("/endpoints", async (c) => {
    const input = endpointInputSchema.parse(await readJson(c.req.raw));
    return c.json(registry.createEndpoint(input), 201);
  });
  api.patch("/endpoints/:id", async (c) => {
    const patch = endpointPatchSchema.parse(await readJson(c.req.raw));
    return c.json(registry.updateEndpoint(c.req.param("id"), patch));
  });
  api.delete("/endpoints/:id", (c) => {
    registry.deleteEndpoint(c.req.param("id"));
    return c.body(null, 204);
  });
  api.put("/endpoints/:id/key", async (c) => {
    const { key } = keyInputSchema.parse(await readJson(c.req.raw));
    return c.json(registry.setKey(c.req.param("id"), key));
  });
  api.delete("/endpoints/:id/key", (c) => c.json(registry.clearKey(c.req.param("id"))));
  api.post("/endpoints/:id/test", async (c) => c.json(await registry.testEndpoint(c.req.param("id"))));
  api.post("/endpoints/:id/models", async (c) => {
    const input = manualModelSchema.parse(await readJson(c.req.raw));
    return c.json(registry.addManualModel(c.req.param("id"), input), 201);
  });

  /* ------------------------------------------------------------------ models */
  api.get("/models", (c) => c.json<ModelListResponse>({ models: registry.listModels() }));
  api.get("/models/:id/profile", (c) => c.json(registry.modelProfile(c.req.param("id"))));
  api.patch("/models/:id", async (c) => {
    const patch = modelPatchSchema.parse(await readJson(c.req.raw));
    return c.json(registry.patchModel(c.req.param("id"), patch));
  });
  api.delete("/models/:id", (c) => {
    registry.deleteModel(c.req.param("id"));
    return c.body(null, 204);
  });

  /* ----------------------------------------------------------------- threads */
  api.get("/threads", (c) => {
    const mode = modeSchema.parse(c.req.query("mode"));
    return c.json<ThreadListResponse>({ threads: chat.list(mode) });
  });
  api.post("/threads", async (c) => {
    const input = threadCreateSchema.parse(await readJson(c.req.raw));
    const settings = getSettings(db);
    const role = input.mode === "agent" ? "agent" : input.mode === "image" ? "image" : input.mode === "edit" ? "edit" : "chat";
    const defaultModelId = settings.defaultModels[role] ?? (input.mode === "edit" ? settings.defaultModels.image : input.mode === "image" ? undefined : settings.defaultModels.chat);
    return c.json(
      chat.create({ mode: input.mode, modelId: input.modelId, defaultModelId, workspace: input.workspace, approvalMode: input.approvalMode, harness: input.harness }),
      201,
    );
  });
  api.get("/threads/:id", (c) => c.json(chat.detail(c.req.param("id"))));
  api.patch("/threads/:id", async (c) => {
    const patch = threadPatchSchema.parse(await readJson(c.req.raw));
    return c.json(chat.patch(c.req.param("id"), patch));
  });
  api.delete("/threads/:id", (c) => {
    chat.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/threads/:id/messages", async (c) => {
    const input = sendMessageSchema.parse(await readJson(c.req.raw));
    return c.json(chat.send(c.req.param("id"), input), 201);
  });

  api.post("/threads/:id/edits", async (c) => {
    const input = sendEditSchema.parse(await readJson(c.req.raw));
    return c.json(image.sendEdit(c.req.param("id"), input), 201);
  });
  api.post("/threads/:id/images", async (c) => {
    const input = sendImageSchema.parse(await readJson(c.req.raw));
    return c.json(image.send(c.req.param("id"), input), 201);
  });

  /* ------------------------------------------------------------------ assets */
  api.post("/assets", async (c) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_ASSET_BYTES) throw new HttpError(413, "file_too_large", `Gambar lebih besar dari ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    return c.json(assets.save(bytes, "upload"), 201);
  });
  api.get("/assets/:id/info", (c) => c.json(assets.dto(c.req.param("id"))));
  api.get("/assets/:id", (c) => {
    const { bytes, mime, file } = assets.read(c.req.param("id"));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": mime,
        "content-length": String(bytes.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        ...(c.req.query("download") === "1" ? { "content-disposition": `attachment; filename="${file}"` } : {}),
      },
    });
  });

  /* -------------------------------------------------------------------- runs */
  api.post("/runs/:id/stop", (c) => {
    if (!runs.stop(c.req.param("id"))) throw new HttpError(404, "run_not_active", "Tidak ada jawaban yang berjalan dengan ID ini.");
    return c.body(null, 202);
  });

  api.post("/runs/:id/approvals/:approvalId", async (c) => {
    const body = approvalDecisionSchema.parse(await readJson(c.req.raw));
    if (!runs.resolveApproval(c.req.param("id"), c.req.param("approvalId"), body)) {
      throw new HttpError(404, "approval_not_found", "Permintaan izin ini sudah dijawab atau run-nya sudah selesai.");
    }
    return c.body(null, 204);
  });
  api.post("/runs/:id/asks/:askId", async (c) => {
    const body = askAnswerSchema.parse(await readJson(c.req.raw));
    if (!runs.answerAsk(c.req.param("id"), c.req.param("askId"), body.answer)) {
      throw new HttpError(404, "ask_not_found", "Pertanyaan ini sudah dijawab atau run-nya sudah selesai.");
    }
    return c.body(null, 204);
  });

  /* ---------------------------------------------------------------- workspaces */
  api.post("/workspaces/check", async (c) => {
    const { path } = workspaceCheckSchema.parse(await readJson(c.req.raw));
    const v = Workspace.validate(path);
    return c.json<WorkspaceCheckResponse>(v.ok ? { ok: true, root: v.root } : { ok: false, message: v.message });
  });
  api.get("/workspaces/recent", (c) => {
    const rows = db.select({ w: threads.workspace }).from(threads).where(isNotNull(threads.workspace)).orderBy(desc(threads.updatedAt)).limit(40).all();
    const unique = [...new Set(rows.map((r) => r.w).filter((w): w is string => !!w))].slice(0, 8);
    return c.json<RecentWorkspacesResponse>({ workspaces: unique });
  });

  /* ------------------------------------------------------------------- harness */
  api.get("/harness", (c) =>
    c.json<HarnessListResponse>({
      profiles: harness.list(),
      tools: allTools(defaultShell()).map((t) => ({ name: t.name, description: t.def.description, readOnly: t.readOnly })),
    }),
  );
  api.post("/harness/:id/duplicate", (c) => c.json(harness.duplicate(c.req.param("id")), 201));
  api.patch("/harness/:id", async (c) => {
    const patch = harnessProfilePatchSchema.parse(await readJson(c.req.raw));
    return c.json(harness.update(c.req.param("id"), patch));
  });
  api.delete("/harness/:id", (c) => {
    harness.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/codex/status", async (c) => {
    const body = await readJson(c.req.raw);
    const dir = body && typeof body === "object" && "dir" in body ? codexDirSchema.parse(body).dir : getSettings(db).codexDir;
    const catalog = readCodexCatalog(dir);
    return c.json<CodexStatusResponse>({ ok: catalog.ok, message: catalog.message, models: catalog.models.map((m) => m.slug) });
  });

  /* ------------------------------------------------------------ approval rules */
  api.get("/threads/:id/rules", (c) => {
    const thread = chat.detail(c.req.param("id"));
    const list: ApprovalRuleDto[] = thread.workspace ? rules.list(thread.workspace) : [];
    return c.json({ rules: list });
  });
  api.delete("/threads/:id/rules/:ruleId", (c) => {
    const thread = chat.detail(c.req.param("id"));
    if (thread.workspace) rules.remove(thread.workspace, c.req.param("ruleId"));
    return c.body(null, 204);
  });

  api.get("/runs/:id/events", (c) => {
    const runId = c.req.param("id");
    if (!runs.has(runId)) throw new HttpError(404, "run_not_found", "Run tidak ditemukan atau sudah lama selesai. Muat ulang thread untuk melihat hasilnya.");
    const after = Math.max(0, Number.parseInt(c.req.query("after") ?? "0", 10) || 0);

    return streamSSE(c, async (stream) => {
      let cursor = after;
      let dirty = true;
      let aborted = false;
      let wake: (() => void) | null = null;
      const off = runs.onChange(runId, () => {
        dirty = true;
        wake?.();
      });
      stream.onAbort(() => {
        aborted = true;
        wake?.();
      });
      const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {}), HEARTBEAT_MS);
      try {
        while (!aborted) {
          if (!dirty) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          dirty = false;
          const snap = runs.snapshot(runId, cursor);
          if (!snap) break;
          for (const ev of snap.events) {
            await stream.writeSSE({ id: String(cursor), event: ev.type, data: JSON.stringify(ev) });
            cursor++;
          }
          if (snap.done) break;
        }
      } finally {
        clearInterval(heartbeat);
        off?.();
      }
    });
  });

  api.get("/messages/:id/request-logs", (c) => {
    const logs = chat.requestLogs(c.req.param("id")).map((l) => ({
      attempt: l.attempt,
      method: l.method,
      url: l.url,
      requestHeaders: l.requestHeaders,
      requestBody: safeParse(l.requestBody),
      status: l.status,
      responseText: l.responseText,
      error: l.error,
      durationMs: l.durationMs,
      startedAt: l.startedAt.toISOString(),
    }));
    return c.json<RequestLogResponse>({ logs });
  });

  api.all("*", (c) => c.json(errorBody("not_found", "Endpoint API tidak ditemukan."), 404));

  app.route("/api", api);
  app.get("*", webHandler({ distDir: config.webDistDir, sessionToken: config.sessionToken }));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json(errorBody(err.code, err.message), err.status);
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
      return c.json(errorBody("invalid_request", `Data request tidak valid${where}: ${issue?.message ?? "format salah"}.`), 400);
    }
    console.error(err);
    return c.json(errorBody("internal", "Terjadi kesalahan di server EZClaw. Detail ada di log terminal."), 500);
  });

  return app;
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Body request bukan JSON yang valid.");
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
