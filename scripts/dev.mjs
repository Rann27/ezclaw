// Starts the API server and the Vite dev server with one shared session token.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const apiPort = process.env.EZCLAW_PORT || "8787";
const webPort = process.env.EZCLAW_WEB_PORT || "5173";
const env = {
  ...process.env,
  EZCLAW_SESSION_TOKEN: randomBytes(32).toString("base64url"),
  EZCLAW_PORT: apiPort,
  EZCLAW_API_PORT: apiPort,
  EZCLAW_WEB_PORT: webPort,
  EZCLAW_DEV_ORIGIN: `http://localhost:${webPort},http://127.0.0.1:${webPort}`,
};

const children = [
  spawn("pnpm", ["--filter", "@ezclaw/server", "dev"], { env, stdio: "inherit", shell: true }),
  spawn("pnpm", ["--filter", "@ezclaw/web", "dev"], { env, stdio: "inherit", shell: true }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`[dev] Satu proses berhenti (kode ${code ?? "?"}), menghentikan yang lain.`);
      stop(code ?? 1);
    }
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
