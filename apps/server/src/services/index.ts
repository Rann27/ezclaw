import { ApprovalRules } from "../agent/approvals.js";
import type { AgentDeps } from "../agent/loop.js";
import { HarnessService } from "../agent/harness.js";
import type { Db } from "../db/client.js";
import { join } from "node:path";
import { RunManager } from "../runs.js";
import type { SecretStore } from "../secrets.js";
import { getSettings } from "../settings.js";
import { AssetService } from "./assets.js";
import { ChatService } from "./chat.js";
import { ImageService } from "./image.js";
import { RegistryService } from "./registry.js";

export interface Services {
  registry: RegistryService;
  runs: RunManager;
  chat: ChatService;
  assets: AssetService;
  image: ImageService;
  harness: HarnessService;
  rules: ApprovalRules;
  secrets: SecretStore;
}

/** `fetchImpl` is injectable so tests can point providers at a local mock server. */
export function createServices(opts: { db: Db; secrets: SecretStore; fetchImpl?: typeof fetch; assetsDir: string; imagePollMs?: number }): Services {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const registry = new RegistryService(opts.db, opts.secrets, fetchImpl);
  const rules = new ApprovalRules(opts.db);
  const harness = new HarnessService(opts.db);
  const agentDeps: AgentDeps = { db: opts.db, registry, fetchImpl, rules, harness, codexDir: () => getSettings(opts.db).codexDir };
  const assets = new AssetService(opts.db, opts.assetsDir);
  const runs = new RunManager(opts.db, { ...agentDeps, assets, ...(opts.imagePollMs ? { pollMs: opts.imagePollMs } : {}) });
  const chat = new ChatService(opts.db, registry, runs, harness, () => getSettings(opts.db).codexDir);
  const image = new ImageService(opts.db, registry, runs, assets);
  return { registry, runs, chat, assets, image, harness, rules, secrets: opts.secrets };
}
