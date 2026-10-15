import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { DEFAULT_LOOP, harnessProfileSchema, type ApprovalMode, type HarnessProfile, type HarnessProfilePatch } from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { harnessProfiles } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { AGENT_PROMPT, CHAT_PROMPT } from "./prompts.js";
import type { ShellKind } from "./shell.js";

export const BUILTIN_PROFILES: HarnessProfile[] = [
  {
    id: "ezclaw-agent",
    name: "EZClaw Agent",
    description: "Prompt dan tools bawaan EZClaw untuk bekerja di folder project: baca, cari, ubah file, jalankan perintah.",
    builtin: true,
    mode: "agent",
    systemPrompt: AGENT_PROMPT,
    fromCodex: false,
    tools: ["list_dir", "read_file", "search", "edit_file", "write_file", "shell", "update_plan", "ask_user"],
    loop: { ...DEFAULT_LOOP },
    projectInstructions: ["AGENTS.md", "EZCLAW.md"],
  },
  {
    id: "codex-ref",
    name: "Codex-ref",
    description: "Memakai instruksi sistem dari instalasi Codex milikmu (models.json) dan tool bernama sama (exec_command, apply_patch, update_plan), untuk membandingkan hasil dengan EZClaw Agent pada task yang sama.",
    builtin: true,
    mode: "agent",
    systemPrompt: "",
    fromCodex: true,
    tools: ["exec_command", "apply_patch", "update_plan"],
    loop: { ...DEFAULT_LOOP, toolOutputLimit: 40_000 },
    projectInstructions: ["AGENTS.md"],
  },
  {
    id: "ezclaw-chat",
    name: "EZClaw Chat",
    description: "Instruksi ringan untuk chat: tanggal dan bahasa jawaban. Tanpa tools.",
    builtin: true,
    mode: "chat",
    systemPrompt: CHAT_PROMPT,
    fromCodex: false,
    tools: [],
    loop: { ...DEFAULT_LOOP, maxSteps: 1 },
    projectInstructions: [],
  },
];

const MAX_INSTRUCTION_FILE = 32 * 1024;
const MAX_INSTRUCTION_TOTAL = 64 * 1024;

export interface ProjectInstruction {
  /** Path relative to the workspace, or the absolute path for a parent folder. */
  label: string;
  text: string;
}

/**
 * Reads instruction files such as AGENTS.md from the workspace and its parent folders, up to the
 * repository root. Outermost first, so the workspace's own file comes last and has the final say.
 */
export function loadProjectInstructions(workspaceRoot: string, names: string[]): ProjectInstruction[] {
  if (!names.length) return [];
  const folders: string[] = [];
  let dir = workspaceRoot;
  for (let depth = 0; depth < 8; depth++) {
    folders.push(dir);
    if (existsSync(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const found: ProjectInstruction[] = [];
  let total = 0;
  for (const folder of folders.reverse()) {
    for (const name of names) {
      const file = join(folder, name);
      try {
        if (!existsSync(file) || !statSync(file).isFile()) continue;
        const text = readFileSync(file, "utf8").slice(0, MAX_INSTRUCTION_FILE).trim();
        if (!text || total + text.length > MAX_INSTRUCTION_TOTAL) continue;
        total += text.length;
        found.push({ label: folder === workspaceRoot ? name : relative(workspaceRoot, file).split(sep).join("/"), text });
      } catch {
        // An unreadable instruction file is skipped; the run does not depend on it.
      }
    }
  }
  return found;
}

export interface CodexCatalog {
  ok: boolean;
  message: string;
  models: { slug: string; instructions: string }[];
}

/** Reads only `models.json` from a Codex folder. Nothing else in that folder is opened. */
export function readCodexCatalog(dir: string | null): CodexCatalog {
  if (!dir) return { ok: false, message: "Folder Codex belum diatur. Isi di Settings, bagian Harness.", models: [] };
  const file = join(dir, "models.json");
  if (!existsSync(file)) return { ok: false, message: `models.json tidak ada di ${dir}.`, models: [] };
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as { models?: { slug?: string; base_instructions?: string; model_messages?: { instructions_template?: string } }[] };
    const models = (json.models ?? []).flatMap((m) => {
      const instructions = m.base_instructions || m.model_messages?.instructions_template || "";
      return m.slug && instructions ? [{ slug: m.slug, instructions }] : [];
    });
    if (!models.length) return { ok: false, message: "models.json tidak berisi instruksi model.", models: [] };
    return { ok: true, message: `${models.length} model dengan instruksi ditemukan.`, models };
  } catch (err) {
    return { ok: false, message: `models.json tidak bisa dibaca: ${err instanceof Error ? err.message : String(err)}`, models: [] };
  }
}

export interface PromptContext {
  date: string;
  os: string;
  shell: ShellKind;
  workspace: string;
  approval: ApprovalMode;
  modelId: string;
  /** The thread's own system prompt, added on top. */
  userPrompt: string;
  codexDir: string | null;
}

const APPROVAL_TEXT: Record<ApprovalMode, string> = {
  ask: "ask first (the user approves every file change and command)",
  edit: "auto-edit (file changes inside the workspace run without asking; commands ask first)",
  full: "full auto (everything inside the workspace runs without asking, except risky actions)",
};

function fill(template: string, ctx: PromptContext): string {
  return template
    .replaceAll("{{date}}", ctx.date)
    .replaceAll("{{os}}", ctx.os)
    .replaceAll("{{shell}}", ctx.shell === "powershell" ? "PowerShell" : "bash")
    .replaceAll("{{workspace}}", ctx.workspace)
    .replaceAll("{{approval}}", APPROVAL_TEXT[ctx.approval]);
}

/** Builds the system prompt for a profile. Throws a readable error if a Codex profile has no source. */
export function renderSystemPrompt(profile: HarnessProfile, ctx: PromptContext, instructions: ProjectInstruction[]): string {
  let base: string;
  if (profile.fromCodex) {
    const catalog = readCodexCatalog(ctx.codexDir);
    if (!catalog.ok) throw new HttpError(400, "codex_unavailable", catalog.message);
    const entry = catalog.models.find((m) => m.slug === ctx.modelId) ?? catalog.models[0]!;
    base = `${entry.instructions}\n\n# Environment\n- Date: ${ctx.date}\n- Operating system: ${ctx.os}\n- Command shell: ${ctx.shell === "powershell" ? "PowerShell" : "bash"}\n- Current working directory: ${ctx.workspace}`;
  } else {
    base = fill(profile.systemPrompt, ctx);
  }

  const parts = [base.trim()];
  for (const i of instructions) parts.push(`# Project instructions (${i.label})\n${i.text}`);
  if (ctx.userPrompt.trim()) parts.push(`# Additional instructions from the user\n${ctx.userPrompt.trim()}`);
  return parts.join("\n\n");
}

export class HarnessService {
  constructor(private readonly db: Db) {}

  list(): HarnessProfile[] {
    const custom = this.db
      .select()
      .from(harnessProfiles)
      .all()
      .flatMap((row) => {
        const parsed = harnessProfileSchema.safeParse(row.data);
        return parsed.success ? [{ ...parsed.data, id: row.id, name: row.name, builtin: false }] : [];
      });
    return [...BUILTIN_PROFILES, ...custom];
  }

  get(id: string): HarnessProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  require(id: string): HarnessProfile {
    const profile = this.get(id);
    if (!profile) throw new HttpError(404, "harness_not_found", `Profil harness "${id}" tidak ditemukan.`);
    return profile;
  }

  duplicate(id: string, name?: string): HarnessProfile {
    const source = this.require(id);
    const copy: HarnessProfile = { ...source, id: randomUUID(), name: (name ?? `${source.name} (salinan)`).slice(0, 60), builtin: false };
    this.db.insert(harnessProfiles).values({ id: copy.id, name: copy.name, data: copy as unknown as Record<string, unknown>, createdAt: new Date() }).run();
    return copy;
  }

  update(id: string, patch: HarnessProfilePatch): HarnessProfile {
    const current = this.require(id);
    if (current.builtin) throw new HttpError(400, "harness_builtin", "Profil bawaan tidak bisa diubah. Duplikasi dulu, lalu ubah salinannya.");
    const next = harnessProfileSchema.parse({ ...current, ...patch, loop: { ...current.loop, ...patch.loop } });
    this.db.update(harnessProfiles).set({ name: next.name, data: next as unknown as Record<string, unknown> }).where(eq(harnessProfiles.id, id)).run();
    return next;
  }

  remove(id: string) {
    const current = this.require(id);
    if (current.builtin) throw new HttpError(400, "harness_builtin", "Profil bawaan tidak bisa dihapus.");
    this.db.delete(harnessProfiles).where(eq(harnessProfiles.id, id)).run();
  }
}
