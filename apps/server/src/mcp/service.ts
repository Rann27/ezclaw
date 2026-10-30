import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  mcpModelName,
  type McpImportResponse,
  type McpPromptInfo,
  type McpServerCreate,
  type McpServerDto,
  type McpServerPatch,
  type McpStatus,
  type McpToolInfo,
  type McpToolPolicy,
} from "@ezclaw/core";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.js";
import { mcpServers } from "../db/schema.js";
import { HttpError } from "../errors.js";
import type { SecretStore } from "../secrets.js";
import { McpOAuthProvider } from "./oauth.js";

type Row = typeof mcpServers.$inferSelect;

export interface McpRawTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  content: { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string; mimeType?: string } }[];
  structuredContent?: unknown;
  isError?: boolean;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 10 * 60_000;
const LOG_LINES = 60;

/** One server's live connection and what it offers. */
class Connection {
  status: McpStatus = "off";
  error: string | null = null;
  authUrl: string | null = null;
  authState: string | null = null;
  client: Client | null = null;
  transport: Transport | null = null;
  /** The HTTP transport that started a login; it finishes the code exchange. */
  authTransport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  tools: McpRawTool[] = [];
  prompts: McpPromptInfo[] = [];
  resourceCount = 0;
  hasResources = false;
  serverName: string | null = null;
  serverVersion: string | null = null;
  instructions: string | null = null;
  log: string[] = [];
  connecting: Promise<void> | null = null;

  addLog(text: string) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.log.push(line.slice(0, 500));
      if (this.log.length > LOG_LINES) this.log.shift();
    }
  }
}

export function effectivePolicy(row: Pick<Row, "trust" | "toolPolicies">, tool: Pick<McpRawTool, "name" | "annotations">): "allow" | "ask" | "off" {
  const p = row.toolPolicies[tool.name] ?? "auto";
  if (p !== "auto") return p;
  // A server the owner trusts, or a tool that only reads, runs without asking.
  return row.trust === "allow" || tool.annotations?.readOnlyHint === true ? "allow" : "ask";
}

/**
 * The MCP servers the owner added: their settings, their secrets, and a live client for each one
 * that is connected. Local servers are child processes; remote ones are reached over HTTP.
 */
export class McpService {
  private readonly conns = new Map<string, Connection>();
  private callbackBase = "http://127.0.0.1:8787";

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Origin the OAuth login returns to; set once the server knows its address. */
  setCallbackBase(origin: string) {
    this.callbackBase = origin.replace(/\/$/, "");
  }

  get callbackUrl(): string {
    return `${this.callbackBase}/mcp/oauth/callback`;
  }

  /* ----------------------------------------------------------- settings */

  private rows(): Row[] {
    return this.db.select().from(mcpServers).all().sort((a, b) => a.name.localeCompare(b.name));
  }

  row(id: string): Row {
    const r = this.db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!r) throw new HttpError(404, "mcp_not_found", "MCP server tidak ditemukan.");
    return r;
  }

  byName(name: string): Row | null {
    return this.rows().find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  private conn(id: string): Connection {
    let c = this.conns.get(id);
    if (!c) {
      c = new Connection();
      this.conns.set(id, c);
    }
    return c;
  }

  private secretMap(id: string, kind: "env" | "headers"): Record<string, string> {
    const raw = this.secrets.get(`mcp:${id}:${kind}`);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, string>;
    } catch {
      return {};
    }
  }

  private setSecretMap(id: string, kind: "env" | "headers", map: Record<string, string> | undefined): string[] {
    const keys = Object.keys(map ?? {});
    if (keys.length) this.secrets.set(`mcp:${id}:${kind}`, JSON.stringify(map));
    else this.secrets.delete(`mcp:${id}:${kind}`);
    return keys;
  }

  list(): McpServerDto[] {
    return this.rows().map((r) => this.dto(r));
  }

  dto(r: Row): McpServerDto {
    const c = this.conn(r.id);
    const tools: McpToolInfo[] = c.tools.map((t) => ({
      name: t.name,
      modelName: mcpModelName(r.name, t.name),
      title: t.title ?? t.annotations?.title ?? null,
      description: (t.description ?? "").slice(0, 600),
      readOnlyHint: t.annotations?.readOnlyHint === true,
      destructiveHint: t.annotations?.destructiveHint === true,
      policy: r.toolPolicies[t.name] ?? "auto",
    }));
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: r.args,
      cwd: r.cwd,
      url: r.url,
      envKeys: r.envKeys,
      headerKeys: r.headerKeys,
      enabled: r.enabled,
      agent: r.agent,
      chat: r.chat,
      trust: r.trust,
      toolPolicies: r.toolPolicies,
      status: c.status,
      error: c.error,
      authUrl: c.status === "needs_auth" ? c.authUrl : null,
      loggedIn: r.transport === "http" && !!this.secrets.get(`mcp:${r.id}:oauth`) && this.oauth(r).hasTokens(),
      serverName: c.serverName,
      serverVersion: c.serverVersion,
      instructions: c.instructions,
      tools,
      prompts: c.prompts,
      resourceCount: c.resourceCount,
      log: c.log,
    };
  }

  create(input: McpServerCreate): McpServerDto {
    if (this.byName(input.name)) throw new HttpError(409, "mcp_exists", `Sudah ada MCP server bernama "${input.name}".`);
    const id = randomUUID();
    const envKeys = input.transport === "stdio" ? this.setSecretMap(id, "env", input.env) : [];
    const headerKeys = input.transport === "http" ? this.setSecretMap(id, "headers", input.headers) : [];
    this.db
      .insert(mcpServers)
      .values({
        id,
        name: input.name,
        transport: input.transport,
        command: input.transport === "stdio" ? input.command : null,
        args: input.transport === "stdio" ? input.args : [],
        cwd: input.transport === "stdio" ? (input.cwd ?? null) : null,
        url: input.transport === "http" ? input.url : null,
        envKeys,
        headerKeys,
        enabled: input.enabled ?? true,
        agent: input.agent ?? true,
        chat: input.chat ?? false,
        trust: input.trust ?? "ask",
        toolPolicies: {},
        createdAt: new Date(),
      })
      .run();
    const row = this.row(id);
    if (row.enabled) void this.connect(id).catch(() => {});
    return this.dto(row);
  }

  async update(id: string, patch: McpServerPatch): Promise<McpServerDto> {
    const r = this.row(id);
    if (patch.name && patch.name !== r.name && this.byName(patch.name)) throw new HttpError(409, "mcp_exists", `Sudah ada MCP server bernama "${patch.name}".`);
    const set: Partial<Row> = {};
    for (const k of ["name", "enabled", "agent", "chat", "trust", "toolPolicies"] as const) {
      if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
    }
    if (r.transport === "stdio") {
      if (patch.command !== undefined) set.command = patch.command;
      if (patch.args !== undefined) set.args = patch.args;
      if (patch.cwd !== undefined) set.cwd = patch.cwd;
      if (patch.env !== undefined) set.envKeys = this.setSecretMap(id, "env", patch.env);
    } else {
      if (patch.url !== undefined) set.url = patch.url;
      if (patch.headers !== undefined) set.headerKeys = this.setSecretMap(id, "headers", patch.headers);
    }
    if (Object.keys(set).length) this.db.update(mcpServers).set(set).where(eq(mcpServers.id, id)).run();
    const next = this.row(id);

    // Anything about how to reach the server means a fresh connection.
    const reconnect = ["command", "args", "cwd", "env", "url", "headers"].some((k) => (patch as Record<string, unknown>)[k] !== undefined);
    if (patch.enabled === false) await this.disconnect(id);
    else if (next.enabled && (reconnect || patch.enabled === true || this.conn(id).status === "off")) {
      await this.disconnect(id);
      await this.connect(id).catch(() => {});
    }
    return this.dto(this.row(id));
  }

  async remove(id: string): Promise<void> {
    this.row(id);
    await this.disconnect(id);
    for (const k of ["env", "headers", "oauth"]) this.secrets.delete(`mcp:${id}:${k}`);
    this.db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
    this.conns.delete(id);
  }

  /** The owner's "allow always" on one tool. */
  setToolPolicy(id: string, tool: string, policy: McpToolPolicy) {
    const r = this.row(id);
    this.db
      .update(mcpServers)
      .set({ toolPolicies: { ...r.toolPolicies, [tool]: policy } })
      .where(eq(mcpServers.id, id))
      .run();
  }

  async logout(id: string): Promise<McpServerDto> {
    const r = this.row(id);
    this.oauth(r).clear();
    await this.disconnect(id);
    if (r.enabled) await this.connect(id).catch(() => {});
    return this.dto(this.row(id));
  }

  /* --------------------------------------------------------- connection */

  private oauth(r: Row): McpOAuthProvider {
    return new McpOAuthProvider(r.id, this.secrets, this.callbackUrl, (url, state) => {
      const c = this.conn(r.id);
      c.authUrl = url;
      c.authState = state;
    });
  }

  /** Connects every enabled server. Failures stay on each server's status. */
  async startAll(): Promise<void> {
    await Promise.allSettled(this.rows().filter((r) => r.enabled).map((r) => this.connect(r.id)));
  }

  /** Connects if not connected yet; returns once connected or failed. */
  async ensure(id: string): Promise<Connection> {
    const c = this.conn(id);
    if (c.status === "connected" && c.client) return c;
    if (c.connecting) await c.connecting.catch(() => {});
    else if (c.status !== "needs_auth") await this.connect(id).catch(() => {});
    return c;
  }

  connect(id: string): Promise<void> {
    const c = this.conn(id);
    if (c.connecting) return c.connecting;
    c.connecting = this.doConnect(id).finally(() => {
      c.connecting = null;
    });
    return c.connecting;
  }

  private buildStdio(r: Row, c: Connection): StdioClientTransport {
    const t = new StdioClientTransport({
      command: r.command ?? "",
      args: r.args,
      // Only the basic variables are inherited, so EZClaw's own settings and keys never reach the server.
      env: { ...getDefaultEnvironment(), ...this.secretMap(r.id, "env") },
      ...(r.cwd ? { cwd: r.cwd } : {}),
      stderr: "pipe",
    });
    t.stderr?.on("data", (chunk: Buffer) => c.addLog(chunk.toString("utf8")));
    return t;
  }

  private async doConnect(id: string): Promise<void> {
    const r = this.row(id);
    const c = this.conn(id);
    await this.closeClient(c);
    c.status = "connecting";
    c.error = null;
    c.authUrl = null;

    const attempt = async (transport: Transport) => {
      const client = new Client({ name: "EZClaw", version: "0.1.0" }, { capabilities: {} });
      client.onerror = (err) => c.addLog(`[error] ${err.message}`);
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      return client;
    };

    try {
      let client: Client;
      if (r.transport === "stdio") {
        const t = this.buildStdio(r, c);
        c.transport = t;
        client = await attempt(t);
      } else {
        const url = new URL(r.url ?? "");
        const headers = this.secretMap(r.id, "headers");
        const authProvider = this.oauth(r);
        const opts = { authProvider, requestInit: { headers }, fetch: this.fetchImpl };
        const streamable = new StreamableHTTPClientTransport(url, opts);
        c.transport = streamable;
        c.authTransport = streamable;
        try {
          client = await attempt(streamable);
        } catch (err) {
          if (err instanceof UnauthorizedError || c.authUrl) throw err;
          // Older servers speak the HTTP+SSE transport instead.
          const sse = new SSEClientTransport(url, { authProvider, requestInit: { headers }, fetch: this.fetchImpl, eventSourceInit: { fetch: (u, init) => this.fetchImpl(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }) } });
          c.transport = sse;
          c.authTransport = sse;
          try {
            client = await attempt(sse);
          } catch {
            throw err;
          }
        }
      }
      c.client = client;
      const info = client.getServerVersion();
      c.serverName = info?.name ?? null;
      c.serverVersion = info?.version ?? null;
      c.instructions = client.getInstructions()?.slice(0, 4000) ?? null;
      client.onclose = () => {
        if (c.client === client) {
          c.client = null;
          if (c.status === "connected") {
            c.status = "error";
            c.error = "Koneksi ke server terputus. Akan disambung lagi saat dipakai.";
          }
        }
      };
      await this.refresh(c);
      const caps = client.getServerCapabilities();
      if (caps?.tools?.listChanged) client.setNotificationHandler(ToolListChangedNotificationSchema, () => void this.refresh(c));
      if (caps?.prompts?.listChanged) client.setNotificationHandler(PromptListChangedNotificationSchema, () => void this.refresh(c));
      if (caps?.resources?.listChanged) client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void this.refresh(c));
      c.status = "connected";
      c.authUrl = null;
    } catch (err) {
      await this.closeClient(c, true);
      if (err instanceof UnauthorizedError || c.authUrl) {
        c.status = "needs_auth";
        c.error = c.authUrl ? "Server ini meminta login. Klik Login untuk membuka halaman masuknya." : "Server ini meminta login, tetapi tidak memberi halaman login.";
      } else {
        c.status = "error";
        c.error = describe(err, r);
      }
      throw err;
    }
  }

  /** Lists tools, prompts and resources again. */
  private async refresh(c: Connection) {
    const client = c.client;
    if (!client) return;
    const caps = client.getServerCapabilities() ?? {};
    const tools: McpRawTool[] = [];
    if (caps.tools) {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools as McpRawTool[]));
        cursor = page.nextCursor;
      } while (cursor && tools.length < 1000);
    }
    c.tools = tools;
    c.prompts = [];
    if (caps.prompts) {
      try {
        const p = await client.listPrompts();
        c.prompts = p.prompts.map((x) => ({
          name: x.name,
          description: (x.description ?? "").slice(0, 400),
          arguments: (x.arguments ?? []).map((a) => ({ name: a.name, description: a.description ?? "", required: a.required === true })),
        }));
      } catch {
        // A server may claim prompts and still fail to list them.
      }
    }
    c.hasResources = !!caps.resources;
    c.resourceCount = 0;
    if (caps.resources) {
      try {
        c.resourceCount = (await client.listResources()).resources.length;
      } catch {
        c.resourceCount = 0;
      }
    }
  }

  private async closeClient(c: Connection, keepAuth = false) {
    const client = c.client;
    c.client = null;
    const transport = c.transport;
    c.transport = null;
    if (!keepAuth) c.authTransport = null;
    try {
      if (client) await client.close();
      else if (transport) await transport.close();
    } catch {
      // Already closed.
    }
  }

  async disconnect(id: string) {
    const c = this.conn(id);
    await this.closeClient(c);
    c.status = "off";
    c.error = null;
    c.authUrl = null;
    c.tools = [];
    c.prompts = [];
    c.resourceCount = 0;
  }

  async stopAll() {
    await Promise.allSettled([...this.conns.keys()].map((id) => this.disconnect(id)));
  }

  /** The browser came back from a login page. Returns the server's name for the page shown. */
  async finishAuth(state: string, code: string): Promise<string> {
    const entry = [...this.conns.entries()].find(([, c]) => c.authState && c.authState === state);
    if (!entry) throw new HttpError(400, "mcp_auth_state", "Login ini tidak dikenali atau sudah kedaluwarsa. Mulai lagi dari Settings, bagian MCP.");
    const [id, c] = entry;
    const r = this.row(id);
    const transport = c.authTransport;
    if (!transport) throw new HttpError(400, "mcp_auth_state", "Login ini sudah tidak aktif. Mulai lagi dari Settings, bagian MCP.");
    await transport.finishAuth(code);
    c.authState = null;
    await this.connect(id).catch(() => {});
    return r.name;
  }

  /* ---------------------------------------------------------- using it */

  /** Servers whose tools the model gets: on for the mode, plus any a skill asked for. */
  activeRows(mode: "agent" | "chat", extra: Set<string> = new Set()): Row[] {
    return this.rows().filter((r) => (r.enabled && (mode === "agent" ? r.agent : r.chat)) || extra.has(r.name.toLowerCase()));
  }

  async toolsOf(r: Row): Promise<McpRawTool[]> {
    const c = await this.ensure(r.id);
    return c.status === "connected" ? c.tools : [];
  }

  connection(id: string): Connection | undefined {
    return this.conns.get(id);
  }

  async callTool(id: string, name: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    const c = await this.ensure(id);
    if (!c.client) throw new Error(c.error ?? "MCP server tidak tersambung.");
    return (await c.client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> }, undefined, { signal, timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true })) as McpCallResult;
  }

  async listResources(id: string): Promise<{ uri: string; name: string; description?: string; mimeType?: string }[]> {
    const c = await this.ensure(id);
    if (!c.client || !c.hasResources) return [];
    return (await c.client.listResources()).resources;
  }

  async readResource(id: string, uri: string, signal: AbortSignal) {
    const c = await this.ensure(id);
    if (!c.client) throw new Error(c.error ?? "MCP server tidak tersambung.");
    return (await c.client.readResource({ uri }, { signal })).contents;
  }

  async getPrompt(id: string, name: string, args: Record<string, string>): Promise<string> {
    const c = await this.ensure(id);
    if (!c.client) throw new HttpError(409, "mcp_offline", c.error ?? "MCP server tidak tersambung.");
    const res = await c.client.getPrompt({ name, arguments: args });
    return res.messages
      .map((m) => {
        const content = m.content as { type: string; text?: string; resource?: { text?: string } };
        return content.type === "text" ? (content.text ?? "") : content.type === "resource" ? (content.resource?.text ?? "") : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  /* ------------------------------------------------------------- import */

  importServers(entries: ImportedServer[]): McpImportResponse {
    const added: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const e of entries) {
      const name = e.name.replace(/[^\w-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40) || "server";
      if (this.byName(name)) {
        skipped.push({ name, reason: "Nama ini sudah dipakai." });
        continue;
      }
      try {
        if (e.command) this.create({ name, transport: "stdio", command: e.command, args: e.args ?? [], cwd: e.cwd ?? null, env: e.env ?? {}, enabled: false });
        else if (e.url) this.create({ name, transport: "http", url: e.url, headers: e.headers ?? {}, enabled: false });
        else {
          skipped.push({ name, reason: "Tidak ada command atau url." });
          continue;
        }
        added.push(name);
      } catch (err) {
        skipped.push({ name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { added, skipped };
  }
}

export interface ImportedServer {
  name: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function describe(err: unknown, r: Row): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT/.test(msg) && r.transport === "stdio") return `Perintah "${r.command}" tidak ditemukan. Pastikan programnya terpasang (misalnya Node.js untuk npx, atau uv untuk uvx).`;
  if (/timed out|timeout/i.test(msg)) return "Server tidak menjawab dalam 30 detik. Lihat log di bawah untuk pesan dari server.";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND/i.test(msg)) return `Tidak bisa menghubungi ${r.url}. Periksa alamat dan koneksi internet.`;
  if (/closed/i.test(msg) && r.transport === "stdio") return "Server berhenti sebelum siap. Lihat log di bawah untuk pesan dari server.";
  return msg.slice(0, 500);
}
