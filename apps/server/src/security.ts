import { timingSafeEqual } from "node:crypto";
import { TOKEN_HEADER } from "@ezclaw/core";
import type { MiddlewareHandler } from "hono";
import { errorBody } from "./errors.js";

/**
 * Rejects any request whose Host is not our loopback address. Runs on every route,
 * including index.html, because that page carries the session token and a DNS-rebound
 * hostname would otherwise be able to read it.
 */
export function hostGuard(allowedHosts: string[]): MiddlewareHandler {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (!host || !allowed.has(host)) {
      return c.json(errorBody("host_not_allowed", "Host tidak diizinkan."), 403);
    }
    await next();
  };
}

/**
 * Guards /api: the API can later run shell commands, so a request must come from our own
 * page (Origin + Sec-Fetch-Site) and carry the per-launch session token.
 */
export function apiGuard(opts: { allowedOrigins: string[]; sessionToken: string }): MiddlewareHandler {
  const origins = new Set(opts.allowedOrigins);
  const expected = Buffer.from(opts.sessionToken);
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) {
      return c.json(errorBody("origin_not_allowed", "Request dari origin ini ditolak."), 403);
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json(errorBody("cross_site", "Request lintas situs ditolak."), 403);
    }
    const given = Buffer.from(c.req.header(TOKEN_HEADER) ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json(
        errorBody("invalid_session", "Sesi tidak valid. Muat ulang halaman, atau jalankan ulang EZClaw."),
        401,
      );
    }
    await next();
  };
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", "frame-ancestors 'none'");
};
