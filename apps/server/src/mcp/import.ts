import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { HttpError } from "../errors.js";
import type { ImportedServer } from "./service.js";

type Json = Record<string, unknown>;

const asRecord = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const stringMap = (v: unknown): Record<string, string> => {
  const r = asRecord(v);
  if (!r) return {};
  return Object.fromEntries(Object.entries(r).filter((e): e is [string, string] => typeof e[1] === "string"));
};

function fromEntry(name: string, v: unknown): ImportedServer | null {
  const e = asRecord(v);
  if (!e) return null;
  const url = typeof e.url === "string" ? e.url : typeof e.serverUrl === "string" ? e.serverUrl : undefined;
  const command = typeof e.command === "string" ? e.command : undefined;
  const headers = { ...stringMap(e.headers), ...stringMap(e.http_headers) };
  // Codex: a bearer token read from an environment variable.
  if (typeof e.bearer_token_env_var === "string" && process.env[e.bearer_token_env_var]) headers.Authorization = `Bearer ${process.env[e.bearer_token_env_var]}`;
  return {
    name,
    ...(command ? { command, args: strings(e.args), env: stringMap(e.env), cwd: typeof e.cwd === "string" ? e.cwd : null } : {}),
    ...(!command && url ? { url, headers } : {}),
  };
}

/**
 * Reads MCP server definitions out of another app's config: Claude Desktop and Cursor
 * (`mcpServers`), VS Code (`servers`), a bare map of servers, or Codex's TOML (`mcp_servers`).
 */
export function parseMcpConfig(text: string): ImportedServer[] {
  const trimmed = text.trim();
  let root: Json | null = null;
  if (trimmed.startsWith("{")) {
    try {
      root = asRecord(JSON.parse(trimmed));
    } catch {
      throw new HttpError(400, "mcp_import_parse", "Teks ini bukan JSON yang valid.");
    }
  } else {
    try {
      root = asRecord(parseToml(trimmed));
    } catch {
      throw new HttpError(400, "mcp_import_parse", "Teks ini bukan JSON atau TOML yang valid.");
    }
  }
  if (!root) return [];
  const map = asRecord(root.mcpServers) ?? asRecord(root.servers) ?? asRecord(root.mcp_servers) ?? asRecord(asRecord(root.mcp)?.servers) ?? root;
  return Object.entries(map)
    .map(([name, v]) => fromEntry(name, v))
    .filter((s): s is ImportedServer => !!s && (!!s.command || !!s.url));
}

/** Where other apps keep their MCP config on this computer. */
export function configPath(source: "claude" | "cursor" | "codex", codexDir: string | null): string {
  if (source === "claude") {
    const base = process.env.APPDATA ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config"));
    return join(base, "Claude", "claude_desktop_config.json");
  }
  if (source === "cursor") return join(homedir(), ".cursor", "mcp.json");
  return join(codexDir ?? join(homedir(), ".codex"), "config.toml");
}

export function readConfigFile(source: "claude" | "cursor" | "codex", codexDir: string | null): string {
  const path = configPath(source, codexDir);
  if (!existsSync(path)) throw new HttpError(404, "mcp_import_missing", `File config tidak ditemukan: ${path}`);
  return readFileSync(path, "utf8");
}
