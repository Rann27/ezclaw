import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  sessionToken: string;
  /** Exact Origin values a browser may send to /api. */
  allowedOrigins: string[];
  /** Exact Host header values accepted on every route (DNS rebinding guard). */
  allowedHosts: string[];
  webDistDir: string;
  migrationsDir: string;
  /** "auto" tries the OS keyring first; "file" skips it. */
  secretStore: "auto" | "file";
  version: string;
  isDev: boolean;
}

export const DEFAULT_PORT = 8787;
const MIN_TOKEN_LENGTH = 32;
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/;

export class ConfigError extends Error {}

/**
 * @param appRoot the apps/server directory, used to locate migrations, the web build and package.json.
 */
export function loadConfig(appRoot: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = parsePort(env.EZCLAW_PORT);

  const devOrigins = (env.EZCLAW_DEV_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const origin of devOrigins) {
    if (!LOOPBACK_ORIGIN.test(origin)) {
      throw new ConfigError(`EZCLAW_DEV_ORIGIN hanya boleh berisi origin loopback (http://localhost:PORT atau http://127.0.0.1:PORT), bukan "${origin}".`);
    }
  }

  const token = env.EZCLAW_SESSION_TOKEN || randomBytes(32).toString("base64url");
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`EZCLAW_SESSION_TOKEN minimal ${MIN_TOKEN_LENGTH} karakter.`);
  }

  return {
    host: "127.0.0.1",
    port,
    dataDir: resolve(env.EZCLAW_DATA_DIR || join(homedir(), ".ezclaw")),
    sessionToken: token,
    allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...devOrigins],
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
    webDistDir: resolve(env.EZCLAW_WEB_DIST || join(appRoot, "../web/dist")),
    migrationsDir: join(appRoot, "drizzle"),
    secretStore: parseSecretStore(env.EZCLAW_SECRET_STORE),
    version: readVersion(appRoot),
    isDev: devOrigins.length > 0,
  };
}

function parseSecretStore(raw: string | undefined): "auto" | "file" {
  if (!raw || raw === "auto") return "auto";
  if (raw === "file") return "file";
  throw new ConfigError(`EZCLAW_SECRET_STORE hanya boleh "auto" atau "file", bukan "${raw}".`);
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`EZCLAW_PORT tidak valid: "${raw}".`);
  }
  return port;
}

function readVersion(appRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
