import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db/client.js";
import { createSecretStore } from "./secrets.js";
import { createServices } from "./services/index.js";

// src/index.ts in dev and dist/index.js after build both sit one level below apps/server.
const appRoot = fileURLToPath(new URL("..", import.meta.url));

function main() {
  const config = loadConfig(appRoot);
  const { db, sqlite, file } = openDatabase({
    file: join(config.dataDir, "ezclaw.db"),
    migrationsDir: config.migrationsDir,
  });
  const secrets = createSecretStore(config.dataDir, config.secretStore);
  const services = createServices({ db, secrets, assetsDir: join(config.dataDir, "assets") });
  services.chat.recover();
  const app = createApp({ config, db, dbPath: file, startedAt: new Date(), services });

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    if (config.isDev) {
      console.log(`[server] API siap di http://${config.host}:${info.port} (buka UI dev di http://localhost:5173)`);
    } else {
      console.log(`EZClaw berjalan di http://${config.host}:${info.port}`);
    }
    console.log(`[server] Data: ${config.dataDir}`);
    const status = secrets.status();
    console.log(`[server] Penyimpanan key: ${status.backend}${status.secure ? "" : " (lebih lemah, lihat Settings)"}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${config.port} sudah dipakai proses lain. Hentikan proses itu, atau set EZCLAW_PORT ke port lain.`);
    } else {
      console.error(err);
    }
    sqlite.close();
    process.exit(1);
  });

  const shutdown = () => {
    server.close();
    void services.runs.stopAll().finally(() => {
      sqlite.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Konfigurasi tidak valid: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
