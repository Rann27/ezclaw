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
import { CheckpointService } from "./checkpoints.js";
import { ImageService } from "./image.js";
import { MemoryService } from "./memory.js";
import { ProcessManager } from "../agent/processes.js";
import { McpService } from "../mcp/service.js";
import { SkillService } from "./skills.js";
import { RegistryService } from "./registry.js";

export interface Services {
  registry: RegistryService;
  runs: RunManager;
  chat: ChatService;
  assets: AssetService;
  image: ImageService;
  harness: HarnessService;
  rules: ApprovalRules;
  memory: MemoryService;
  checkpoints: CheckpointService;
  processes: ProcessManager;
  secrets: SecretStore;
  mcp: McpService;
  skills: SkillService;
}

/** `fetchImpl` is injectable so tests can point providers at a local mock server. */
export function createServices(opts: { db: Db; secrets: SecretStore; fetchImpl?: typeof fetch; assetsDir: string; imagePollMs?: number; skillsDir?: string; allowPrivateWeb?: boolean }): Services {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const registry = new RegistryService(opts.db, opts.secrets, fetchImpl);
  const rules = new ApprovalRules(opts.db);
  const harness = new HarnessService(opts.db, () => getSettings(opts.db).codexDir);
  const memory = new MemoryService(opts.db);
  const assets = new AssetService(opts.db, opts.assetsDir);
  const processes = new ProcessManager();
  const skillsDir = opts.skillsDir ?? join(opts.assetsDir, "..", "skills");
  const mcp = new McpService(opts.db, opts.secrets, fetchImpl);
  const skills = new SkillService(opts.db, skillsDir, () => getSettings(opts.db).skillDirs, () => mcp.list().map((s) => s.name), fetchImpl);
  const agentDeps: AgentDeps = {
    assets,
    processes,
    ...(opts.allowPrivateWeb ? { allowPrivateWeb: true } : {}),
    db: opts.db,
    registry,
    fetchImpl,
    rules,
    harness,
    memory,
    secrets: opts.secrets,
    skillsDir,
    mcp,
    skills,
    codexDir: () => getSettings(opts.db).codexDir,
  };
  const runs = new RunManager(opts.db, { ...agentDeps, ...(opts.imagePollMs ? { pollMs: opts.imagePollMs } : {}) });
  const chat = new ChatService(opts.db, registry, runs, harness, () => getSettings(opts.db).codexDir, memory, mcp, skills);
  const image = new ImageService(opts.db, registry, runs, assets);
  const checkpoints = new CheckpointService(opts.db, runs);
  return { registry, runs, chat, assets, image, harness, rules, memory, checkpoints, processes, secrets: opts.secrets, mcp, skills };
}
