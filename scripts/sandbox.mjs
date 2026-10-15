// Runs the built server against a throwaway data folder and the file secret store, so trying the
// app (or testing it in a browser) never touches the real ~/.ezclaw or the OS credential manager.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.EZCLAW_DATA_DIR || join(root, ".sandbox");
mkdirSync(dataDir, { recursive: true });

process.env.EZCLAW_DATA_DIR = dataDir;
process.env.EZCLAW_SECRET_STORE = "file";
process.env.EZCLAW_PORT ||= "8788";
console.log(`[sandbox] Data di ${dataDir}`);

await import(pathToFileURL(join(root, "apps/server/dist/index.js")).href);
