import {
  type LibraryResponse,
  type SearchResponse,
  mcpImportSchema,
  mcpPromptGetSchema,
  mcpServerCreateSchema,
  mcpServerPatchSchema,
  skillContentSchema,
  skillCreateSchema,
  skillImportSchema,
  skillStatePatchSchema,
  type McpImportResponse,
  type McpListResponse,
  type McpPromptResult,
  type SkillImportResponse,
  type SkillListResponse,
  approvalDecisionSchema,
  askAnswerSchema,
  codexDirSchema,
  endpointInputSchema,
  approxTokens,
  memoryCreateSchema,
  memoryPatchSchema,
  webSearchKeySchema,
  type CheckpointListResponse,
  type MemoryListResponse,
  type RestoreResponse,
  type WebSearchStatus,
  harnessImportSchema,
  harnessProfilePatchSchema,
  type HarnessPreviewResponse,
  endpointPatchSchema,
  keyInputSchema,
  manualModelSchema,
  modeSchema,
  modelPatchSchema,
  mkdirSchema,
  sendEditSchema,
  type DirListResponse,
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
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { desc, isNotNull } from "drizzle-orm";
import { ZodError } from "zod";
import { loadProjectInstructions, readCodexCatalog, renderPrompt } from "./agent/harness.js";
import { everyTool, selectTools } from "./agent/toolRegistry.js";
import { defaultShell } from "./agent/shell.js";
import { Workspace } from "./agent/workspace.js";
import { threads } from "./db/schema.js";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { HttpError, errorBody } from "./errors.js";
import { MAX_ASSET_BYTES } from "./services/assets.js";
import { listDirs, makeDir } from "./services/folders.js";
import { apiGuard, hostGuard, securityHeaders } from "./security.js";
import type { Services } from "./services/index.js";
import { getSettings, updateSettings } from "./settings.js";
import { parseMcpConfig, readConfigFile } from "./mcp/import.js";
import { listLibrary } from "./services/library.js";
import { attachmentParts, storeAttachment } from "./services/attachments.js";
import { pickFolderNative } from "./services/nativePicker.js";
import { webHandler } from "./web.js";

export interface AppDeps {
  config: ServerConfig;
  db: Db;
  dbPath: string;
  startedAt: Date;
  services: Services;
}

const HEARTBEAT_MS = 15_000;

// The bundle this process runs from; a newer file on disk means a build happened after start.
const CODE_FILE = fileURLToPath(import.meta.url);
const codeMtime = (): number => {
  try {
    return statSync(CODE_FILE).mtimeMs;
  } catch {
    return 0;
  }
};
const LOADED_MTIME = codeMtime();

function webEntry(distDir: string): string | null {
  try {
    return /<script[^>]*type="module"[^>]*src="([^"]+)"/.exec(readFileSync(join(distDir, "index.html"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createApp({ config, db, dbPath, startedAt, services }: AppDeps) {
  const { registry, runs, chat, secrets, harness, rules, assets, image, memory, checkpoints, processes, mcp, skills } = services;
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
      stale: codeMtime() > LOADED_MTIME,
      webEntry: webEntry(config.webDistDir),
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
    return c.json<ThreadListResponse>({ threads: chat.list(mode, c.req.query("archived") === "1") });
  });
  api.post("/threads", async (c) => {
    const input = threadCreateSchema.parse(await readJson(c.req.raw));
    const settings = getSettings(db);
    const role = input.mode === "agent" ? "agent" : input.mode === "image" ? "image" : input.mode === "edit" ? "edit" : "chat";
    const defaultModelId = settings.defaultModels[role] ?? (input.mode === "edit" ? settings.defaultModels.image : input.mode === "image" ? undefined : settings.defaultModels.chat);
    return c.json(
      chat.create({ mode: input.mode, modelId: input.modelId, defaultModelId, workspace: input.workspace, approvalMode: input.approvalMode, confirmFull: input.confirmFull, harness: input.harness }),
      201,
    );
  });
  api.get("/threads/:id", (c) => c.json(chat.detail(c.req.param("id"))));
  api.get("/search", (c) => c.json<SearchResponse>({ hits: chat.search((c.req.query("q") ?? "").slice(0, 200)) }));
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
    const extra = input.attachments?.length ? await attachmentParts(assets, input.attachments) : [];
    return c.json(chat.send(c.req.param("id"), input, extra), 201);
  });
  api.post("/attachments", async (c) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_ASSET_BYTES) throw new HttpError(413, "file_too_large", `File lebih besar dari ${MAX_ASSET_BYTES / 1024 / 1024} MB.`);
    const name = decodeURIComponent(c.req.header("x-file-name") ?? "lampiran").slice(0, 200);
    const stored = storeAttachment(assets, Buffer.from(await c.req.arrayBuffer()), name);
    return c.json({ ...stored.asset, attachmentKind: stored.kind }, 201);
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
  api.patch("/assets/:id", async (c) => {
    const body = (await readJson(c.req.raw)) as { favorite?: unknown };
    if (typeof body.favorite !== "boolean") throw new HttpError(400, "invalid_request", "Kirim { favorite: true|false }.");
    return c.json(assets.setFavorite(c.req.param("id"), body.favorite));
  });
  api.get("/library", (c) => {
    const mode = c.req.query("mode");
    return c.json<LibraryResponse>(
      listLibrary(db, {
        q: c.req.query("q") ?? undefined,
        mode: mode === "image" || mode === "edit" ? mode : undefined,
        model: c.req.query("model") || undefined,
        favorite: c.req.query("favorite") === "1",
        offset: Number(c.req.query("offset") ?? 0) || 0,
        limit: Number(c.req.query("limit") ?? 60) || 60,
      }),
    );
  });
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

  api.get("/fs/dirs", (c) => c.json<DirListResponse>(listDirs(c.req.query("path") || undefined)));
  api.post("/fs/pick-folder", async (c) => {
    const body = (await readJson(c.req.raw)) as { initial?: unknown; title?: unknown };
    const path = await pickFolderNative({
      initial: typeof body.initial === "string" ? body.initial.slice(0, 1000) : null,
      title: typeof body.title === "string" ? body.title.slice(0, 120) : undefined,
    });
    return c.json({ path });
  });
  api.post("/fs/mkdir", async (c) => {
    const { parent, name } = mkdirSchema.parse(await readJson(c.req.raw));
    return c.json({ path: makeDir(parent, name) }, 201);
  });

  /* ------------------------------------------------------------------- harness */
  api.get("/harness", (c) =>
    c.json<HarnessListResponse>({
      profiles: harness.list(),
      tools: everyTool(defaultShell()).map((t) => ({ name: t.name, description: t.def.description, readOnly: t.readOnly })),
    }),
  );
  api.post("/harness/:id/duplicate", (c) => c.json(harness.duplicate(c.req.param("id")), 201));
  api.post("/harness/import", async (c) => {
    const input = harnessImportSchema.parse(await readJson(c.req.raw));
    return c.json(harness.importText(input.name, input.mode, input.text), 201);
  });
  api.get("/harness/:id/preview", (c) => {
    const profile = harness.require(c.req.param("id"));
    const workspace = c.req.query("workspace") ?? "";
    const rendered = renderPrompt(
      profile,
      {
        date: new Date().toLocaleDateString("sv-SE"),
        os: process.platform,
        shell: defaultShell(),
        workspace: workspace || "(folder workspace)",
        approval: "ask",
        modelId: "",
        userPrompt: "",
        codexDir: getSettings(db).codexDir,
        memories: memory.forPrompt(workspace || null),
      },
      workspace ? loadProjectInstructions(workspace, profile.projectInstructions) : [],
    );
    const tag = profile.userTag;
    const tools = selectTools(profile.tools, defaultShell(), profile.toolStyle).map((t) => ({ name: t.name, description: t.def.description }));
    const total = [rendered.text, ...rendered.developer, rendered.context].join("\n");
    return c.json<HarnessPreviewResponse>({
      text: rendered.text,
      developer: rendered.developer,
      context: rendered.context,
      userMessage: tag ? `<${tag}>\n…\n</${tag}>` : "…",
      tools,
      stableChars: rendered.stableChars,
      approxTokens: approxTokens(total),
    });
  });
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
  /* ------------------------------------------------------------- undo and processes */
  api.get("/threads/:id/checkpoints", (c) => c.json<CheckpointListResponse>({ checkpoints: checkpoints.list(c.req.param("id")) }));
  api.post("/threads/:id/checkpoints/:runMessageId/restore", (c) => c.json<RestoreResponse>(checkpoints.restore(c.req.param("id"), c.req.param("runMessageId"))));
  api.get("/threads/:id/processes", (c) => c.json({ processes: processes.list(c.req.param("id")) }));
  api.post("/threads/:id/processes/:pid/stop", (c) => {
    try {
      return c.json(processes.stop(c.req.param("id"), c.req.param("pid")));
    } catch (err) {
      throw new HttpError(404, "process_not_found", err instanceof Error ? err.message : "Proses tidak ditemukan.");
    }
  });

  /* ------------------------------------------------------------------ memory */
  api.get("/memories", (c) => c.json<MemoryListResponse>({ memories: memory.list() }));
  api.post("/memories", async (c) => {
    const input = memoryCreateSchema.parse(await readJson(c.req.raw));
    return c.json(memory.create({ text: input.text, scope: input.scope, workspace: input.workspace ?? null, source: "user", status: "active" }), 201);
  });
  api.patch("/memories/:id", async (c) => c.json(memory.update(c.req.param("id"), memoryPatchSchema.parse(await readJson(c.req.raw)))));
  api.delete("/memories/:id", (c) => {
    memory.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  /* --------------------------------------------------------------------- MCP */
  api.get("/mcp", (c) => c.json<McpListResponse>({ servers: mcp.list(), callbackUrl: mcp.callbackUrl }));
  api.post("/mcp", async (c) => c.json(mcp.create(mcpServerCreateSchema.parse(await readJson(c.req.raw))), 201));
  api.patch("/mcp/:id", async (c) => c.json(await mcp.update(c.req.param("id"), mcpServerPatchSchema.parse(await readJson(c.req.raw)))));
  api.delete("/mcp/:id", async (c) => {
    await mcp.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/mcp/:id/connect", async (c) => {
    const id = c.req.param("id");
    mcp.row(id);
    await mcp.disconnect(id);
    await mcp.connect(id).catch(() => {});
    return c.json(mcp.dto(mcp.row(id)));
  });
  api.post("/mcp/:id/logout", async (c) => c.json(await mcp.logout(c.req.param("id"))));
  api.post("/mcp/:id/prompts/:name", async (c) => {
    const { arguments: args } = mcpPromptGetSchema.parse(await readJson(c.req.raw));
    return c.json<McpPromptResult>({ text: await mcp.getPrompt(c.req.param("id"), c.req.param("name"), args) });
  });
  api.post("/mcp/import", async (c) => {
    const input = mcpImportSchema.parse(await readJson(c.req.raw));
    const text = "text" in input ? input.text : readConfigFile(input.source, getSettings(db).codexDir);
    const entries = parseMcpConfig(text);
    if (!entries.length) throw new HttpError(400, "mcp_import_empty", "Tidak ada MCP server di config itu.");
    return c.json<McpImportResponse>(mcp.importServers(entries));
  });

  /* ------------------------------------------------------------------ skills */
  const skillWs = (c: { req: { query(k: string): string | undefined } }) => c.req.query("workspace") || null;
  api.get("/skills", (c) => c.json<SkillListResponse>(skills.list(skillWs(c))));
  api.post("/skills", async (c) => c.json(skills.create(skillCreateSchema.parse(await readJson(c.req.raw))), 201));
  api.patch("/skills/:id", async (c) => {
    skills.setState(c.req.param("id"), skillStatePatchSchema.parse(await readJson(c.req.raw)), skillWs(c));
    return c.json(skills.list(skillWs(c)).skills.find((s) => s.id === c.req.param("id")));
  });
  api.get("/skills/:id/content", (c) => c.json(skills.read(c.req.param("id"), skillWs(c))));
  api.put("/skills/:id/content", async (c) => {
    skills.write(c.req.param("id"), skillContentSchema.parse(await readJson(c.req.raw)).content);
    return c.body(null, 204);
  });
  api.delete("/skills/:id", (c) => {
    skills.remove(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/skills/import", async (c) => {
    const input = skillImportSchema.parse(await readJson(c.req.raw));
    return c.json<SkillImportResponse>("folder" in input ? skills.importFolder(input.folder) : await skills.importGithub(input.github));
  });
  api.post("/skills/import-zip", async (c) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > 50 * 1024 * 1024) throw new HttpError(413, "skill_zip_too_big", "File zip lebih dari 50 MB.");
    return c.json<SkillImportResponse>(skills.importZip(Buffer.from(await c.req.arrayBuffer())));
  });

  /* -------------------------------------------------------------- web search */
  api.get("/websearch", (c) => {
    const provider = getSettings(db).webSearchProvider;
    return c.json<WebSearchStatus>({ provider, hasKey: !!provider && !!secrets.get(`websearch:${provider}`) });
  });
  api.put("/websearch/key", async (c) => {
    const { provider, key } = webSearchKeySchema.parse(await readJson(c.req.raw));
    secrets.set(`websearch:${provider}`, key);
    updateSettings(db, { webSearchProvider: provider });
    return c.json<WebSearchStatus>({ provider, hasKey: true });
  });
  api.delete("/websearch/key", (c) => {
    const provider = getSettings(db).webSearchProvider;
    if (provider) secrets.delete(`websearch:${provider}`);
    updateSettings(db, { webSearchProvider: null });
    return c.json<WebSearchStatus>({ provider: null, hasKey: false });
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

  // The browser comes back here from an MCP server's login page. Outside /api: it carries no session
  // token, so it only finishes a login this EZClaw started (matched by the OAuth state).
  app.get("/mcp/oauth/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const failed = c.req.query("error_description") ?? c.req.query("error");
    const page = (title: string, text: string) =>
      c.html(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.6"><h1 style="font-size:1.25rem">${esc(title)}</h1><p>${esc(text)}</p></body>`);
    if (failed) return page("Login MCP dibatalkan", `Server menjawab: ${failed}. Tutup tab ini dan coba lagi dari EZClaw.`);
    if (!code || !state) return page("Login MCP tidak lengkap", "Alamat ini tidak membawa kode login. Tutup tab ini dan mulai lagi dari Settings, bagian MCP.");
    try {
      const name = await mcp.finishAuth(state, code);
      return page("Login berhasil", `EZClaw sudah tersambung ke ${name}. Tab ini boleh ditutup.`);
    } catch (err) {
      return page("Login MCP gagal", err instanceof Error ? err.message : String(err));
    }
  });
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

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
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
