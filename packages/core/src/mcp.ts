import { z } from "zod";

/* ----------------------------------------------------------------------- MCP */

/**
 * How a tool of an MCP server is treated. "auto" follows the server's trust and the tool's own
 * read-only hint; the others are the owner's choice for that one tool.
 */
export const MCP_TOOL_POLICIES = ["auto", "allow", "ask", "off"] as const;
export type McpToolPolicy = (typeof MCP_TOOL_POLICIES)[number];

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export type McpStatus = "off" | "connecting" | "connected" | "error" | "needs_auth";

export interface McpToolInfo {
  name: string;
  /** Name the model sees: mcp__server__tool. */
  modelName: string;
  title: string | null;
  description: string;
  /** The server marked it as not changing anything. */
  readOnlyHint: boolean;
  destructiveHint: boolean;
  policy: McpToolPolicy;
}

export interface McpPromptInfo {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
}

export interface McpServerDto {
  id: string;
  /** Short name; also the middle part of every tool name the model sees. */
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  cwd: string | null;
  url: string | null;
  /** Names of the environment variables set for a local server; values stay in the secret store. */
  envKeys: string[];
  /** Names of the extra HTTP headers; values stay in the secret store. */
  headerKeys: string[];
  /** Connected at start and offered to the model. Off: only skills that ask for it start it. */
  enabled: boolean;
  agent: boolean;
  chat: boolean;
  /** "allow": tools run without asking. "ask": follow the thread's mode (read-only tools never ask). */
  trust: "ask" | "allow";
  toolPolicies: Record<string, McpToolPolicy>;
  status: McpStatus;
  error: string | null;
  /** Set while the server waits for the owner to log in. */
  authUrl: string | null;
  /** The server holds an OAuth login. */
  loggedIn: boolean;
  serverName: string | null;
  serverVersion: string | null;
  instructions: string | null;
  tools: McpToolInfo[];
  prompts: McpPromptInfo[];
  resourceCount: number;
  /** Last lines the server wrote to stderr (local servers). */
  log: string[];
}

export interface McpListResponse {
  servers: McpServerDto[];
  /** Where OAuth logins come back to; shown so the owner can register it if a server asks. */
  callbackUrl: string;
}

const nameSchema = z
  .string()
  .trim()
  .min(1, "Nama kosong.")
  .max(40)
  .regex(/^[A-Za-z0-9][\w-]*$/, "Nama hanya boleh huruf, angka, garis bawah, dan tanda hubung.");

const kv = z.record(z.string().min(1).max(200), z.string().max(8000));

const baseFields = {
  name: nameSchema,
  enabled: z.boolean().optional(),
  agent: z.boolean().optional(),
  chat: z.boolean().optional(),
  trust: z.enum(["ask", "allow"]).optional(),
};

export const mcpServerCreateSchema = z.discriminatedUnion("transport", [
  z.object({
    ...baseFields,
    transport: z.literal("stdio"),
    command: z.string().trim().min(1, "Perintah kosong.").max(1000),
    args: z.array(z.string().max(4000)).max(100).default([]),
    cwd: z.string().trim().max(1000).nullable().optional(),
    env: kv.optional(),
  }),
  z.object({
    ...baseFields,
    transport: z.literal("http"),
    url: z.string().trim().url("URL tidak valid.").max(2000),
    headers: kv.optional(),
  }),
]);
export type McpServerCreate = z.infer<typeof mcpServerCreateSchema>;

export const mcpServerPatchSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  agent: z.boolean().optional(),
  chat: z.boolean().optional(),
  trust: z.enum(["ask", "allow"]).optional(),
  command: z.string().trim().min(1).max(1000).optional(),
  args: z.array(z.string().max(4000)).max(100).optional(),
  cwd: z.string().trim().max(1000).nullable().optional(),
  url: z.string().trim().url().max(2000).optional(),
  /** Replaces all values. Keys missing from it are removed. */
  env: kv.optional(),
  headers: kv.optional(),
  toolPolicies: z.record(z.string().max(200), z.enum(MCP_TOOL_POLICIES)).optional(),
});
export type McpServerPatch = z.infer<typeof mcpServerPatchSchema>;

/** Config text from another app (Claude Desktop, Cursor, VS Code JSON, or Codex TOML), or one of their files. */
export const mcpImportSchema = z.union([
  z.object({ text: z.string().min(2).max(200_000) }),
  z.object({ source: z.enum(["claude", "cursor", "codex"]) }),
]);

export interface McpImportResponse {
  added: string[];
  skipped: { name: string; reason: string }[];
}

export const mcpPromptGetSchema = z.object({ arguments: z.record(z.string(), z.string().max(20000)).default({}) });

export interface McpPromptResult {
  /** The prompt's messages flattened to text, ready to put in the composer. */
  text: string;
}

/* -------------------------------------------------------------------- skills */

export interface SkillDto {
  /** Stable id derived from the SKILL.md path. */
  id: string;
  name: string;
  description: string;
  /** "EZClaw", "workspace", or the configured folder. */
  source: string;
  dir: string;
  /** Skills in EZClaw's own folder can be edited and deleted here. */
  editable: boolean;
  enabled: boolean;
  /** Offered in Chat as well as Agent. */
  chat: boolean;
  /** MCP servers the skill needs; started when the skill is used. */
  mcp: string[];
  /** Server names in `mcp` that are not configured. */
  missingMcp: string[];
}

export interface SkillListResponse {
  skills: SkillDto[];
  /** EZClaw's skills folder, where new and imported skills go. */
  dir: string;
}

export const skillStatePatchSchema = z.object({ enabled: z.boolean().optional(), chat: z.boolean().optional() });

export const skillCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Nama skill: huruf kecil, angka, dan tanda hubung."),
  description: z.string().trim().min(1, "Deskripsi kosong.").max(400),
  body: z.string().max(200_000).default(""),
  mcp: z.array(nameSchema).max(10).default([]),
});

export const skillContentSchema = z.object({ content: z.string().min(1).max(200_000) });

export const skillImportSchema = z.union([
  z.object({ folder: z.string().trim().min(1).max(1000) }),
  z.object({ github: z.string().trim().url().max(500) }),
]);

export interface SkillImportResponse {
  added: string[];
  skipped: { name: string; reason: string }[];
}

/** Name of an MCP tool as the model sees it. Kept within the 64 characters providers allow. */
export function mcpModelName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
