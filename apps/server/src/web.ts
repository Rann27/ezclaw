import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { extname, join, resolve, sep } from "node:path";
import { TOKEN_PLACEHOLDER } from "@ezclaw/core";
import type { Handler } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the built web app. Files with an extension come from the dist folder; every
 * other GET is the SPA entry, with the session token written into its <meta>.
 */
export function webHandler(opts: { distDir: string; sessionToken: string }): Handler {
  const distDir = resolve(opts.distDir);
  const indexPath = join(distDir, "index.html");

  return async (c) => {
    if (!existsSync(indexPath)) {
      return c.text(
        "Web UI belum di-build.\nUntuk development: jalankan `pnpm dev` lalu buka http://localhost:5173.\nUntuk pemakaian biasa: jalankan `pnpm build` lalu `pnpm start`.",
        503,
      );
    }

    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text("URL tidak valid.", 400);
    }

    if (extname(pathname)) {
      const file = resolve(distDir, `.${pathname}`);
      if (!file.startsWith(distDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
        return c.text("Tidak ditemukan.", 404);
      }
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
      return c.body(body, 200, { "Content-Type": type, "Cache-Control": cache });
    }

    // Read per request: the file is small, and a rebuild is then picked up without a restart.
    const indexHtml = readFileSync(indexPath, "utf8").replace(TOKEN_PLACEHOLDER, opts.sessionToken);
    return c.html(indexHtml, 200, { "Cache-Control": "no-store" });
  };
}
