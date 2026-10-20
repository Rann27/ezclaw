import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  type CanonicalMessage,
  DEFAULT_LOOP,
  harnessProfileSchema,
  renderSegments,
  splitWrapperText,
  wrapBlock,
  type ApprovalMode,
  type HarnessProfile,
  type HarnessProfilePatch,
  type HarnessSegment,
} from "@ezclaw/core";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { harnessProfiles } from "../db/schema.js";
import { HttpError } from "../errors.js";
import { CODEX_BASE_INSTRUCTIONS } from "./codexBase.js";
import type { ShellKind } from "./shell.js";
import {
  CHATGPT_STYLE_CHAT_SEGMENTS,
  CLAUDE_STYLE_CHAT_SEGMENTS,
  CODEX_CONTEXT_SEGMENTS,
  COWORK_STYLE_SEGMENTS,
  EZCLAW_AGENT_SEGMENTS,
  EZCLAW_CHAT_SEGMENTS,
} from "./wrappers.js";

const AGENT_TOOLS = [
  "list_dir",
  "glob",
  "read_file",
  "search",
  "edit_file",
  "write_file",
  "shell",
  "start_process",
  "read_process",
  "stop_process",
  "view_image",
  "web_fetch",
  "web_search",
  "spawn_agent",
  "read_skill",
  "update_plan",
  "ask_user",
  "propose_memory",
];

const CHAT_LOOP = { ...DEFAULT_LOOP, limitSteps: true, maxSteps: 1 };

/** Settings every built-in shares unless it says otherwise. */
const PLAIN = { instructionsStyle: "ezclaw" as const, toolStyle: "ezclaw" as const, userTag: null };

const CODEX_TOOLS = ["exec_command", "apply_patch", "update_plan", "view_image"];

/** Codex's base text split per heading, plus the developer and context messages Codex adds. */
export function codexProfileSegments(baseInstructions: string): HarnessSegment[] {
  return [...splitWrapperText(baseInstructions).segments, ...CODEX_CONTEXT_SEGMENTS];
}

export const BUILTIN_PROFILES: HarnessProfile[] = [
  {
    id: "ezclaw-agent",
    name: "EZClaw Agent",
    description: "Wrapper bawaan EZClaw untuk bekerja di folder project: baca, cari, ubah file, jalankan perintah, riset web, dan usul memori.",
    builtin: true,
    mode: "agent",
    origin: "Ditulis untuk EZClaw",
    segments: EZCLAW_AGENT_SEGMENTS,
    wrap: "plain",
    fromCodex: false,
    tools: AGENT_TOOLS,
    loop: { ...DEFAULT_LOOP },
    projectInstructions: ["AGENTS.md", "EZCLAW.md", "CLAUDE.md"],
    memory: true,
    ...PLAIN,
  },
  {
    id: "cowork-style",
    name: "Gaya Cowork",
    description: "Wrapper bergaya Claude Cowork / Claude Code: rekan kerja yang merencanakan, memakai tools khusus file, mendelegasikan riset, dan melapor singkat. Disusun dengan tag seperti wrapper Antigravity.",
    builtin: true,
    mode: "agent",
    origin: "Ditulis EZClaw dengan gaya Claude Cowork, bukan salinan prompt Anthropic",
    segments: COWORK_STYLE_SEGMENTS,
    wrap: "tags",
    fromCodex: false,
    tools: AGENT_TOOLS,
    loop: { ...DEFAULT_LOOP },
    projectInstructions: ["CLAUDE.md", "AGENTS.md"],
    memory: true,
    ...PLAIN,
  },
  {
    id: "codex-hardcode",
    name: "Codex (hardcode)",
    description: "Wrapper Codex yang ditanam di EZClaw, disusun seperti request Codex: instruksi dasar sebagai system, izin sebagai pesan developer, AGENTS.md dan <environment_context> sebagai pesan user sebelum pesanmu, dan tools dengan deskripsi Codex.",
    builtin: true,
    mode: "agent",
    origin: "Teks dari katalog model Codex (OpenAI, Apache-2.0), struktur dari kode sumber Codex",
    segments: codexProfileSegments(CODEX_BASE_INSTRUCTIONS),
    wrap: "plain",
    fromCodex: false,
    tools: CODEX_TOOLS,
    loop: { ...DEFAULT_LOOP, toolOutputLimit: 40_000 },
    projectInstructions: ["AGENTS.md"],
    memory: false,
    instructionsStyle: "codex",
    toolStyle: "codex",
    userTag: null,
  },
  {
    id: "codex-ref",
    name: "Codex (dari instalasi)",
    description: "Sama dengan Codex (hardcode), tetapi teks dasarnya dibaca setiap kali dari models.json di instalasi Codex-mu, jadi ikut berubah saat Codex memperbarui katalognya.",
    builtin: true,
    mode: "agent",
    origin: "Dibaca dari models.json Codex di komputer ini",
    segments: [],
    wrap: "plain",
    fromCodex: true,
    tools: CODEX_TOOLS,
    loop: { ...DEFAULT_LOOP, toolOutputLimit: 40_000 },
    projectInstructions: ["AGENTS.md"],
    memory: false,
    instructionsStyle: "codex",
    toolStyle: "codex",
    userTag: null,
  },
  {
    id: "ezclaw-chat",
    name: "EZClaw Chat",
    description: "Wrapper ringan untuk chat: jawaban langsung, jujur soal ketidakpastian, memakai memori.",
    builtin: true,
    mode: "chat",
    origin: "Ditulis untuk EZClaw",
    segments: EZCLAW_CHAT_SEGMENTS,
    wrap: "plain",
    fromCodex: false,
    tools: [],
    loop: CHAT_LOOP,
    projectInstructions: [],
    memory: true,
    ...PLAIN,
  },
  {
    id: "chat-claude-style",
    name: "Chat gaya Claude",
    description: "Teliti, hangat, terus terang; prosa dulu, Markdown seperlunya. Disusun dengan tag.",
    builtin: true,
    mode: "chat",
    origin: "Ditulis EZClaw dengan gaya Claude, bukan salinan prompt Anthropic",
    segments: CLAUDE_STYLE_CHAT_SEGMENTS,
    wrap: "tags",
    fromCodex: false,
    tools: [],
    loop: CHAT_LOOP,
    projectInstructions: [],
    memory: true,
    ...PLAIN,
  },
  {
    id: "chat-chatgpt-style",
    name: "Chat gaya ChatGPT",
    description: "Ramah dan praktis; jawaban terstruktur dengan judul dan daftar, menawarkan langkah lanjut.",
    builtin: true,
    mode: "chat",
    origin: "Ditulis EZClaw dengan gaya ChatGPT, bukan salinan prompt OpenAI",
    segments: CHATGPT_STYLE_CHAT_SEGMENTS,
    wrap: "plain",
    fromCodex: false,
    tools: [],
    loop: CHAT_LOOP,
    projectInstructions: [],
    memory: true,
    ...PLAIN,
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
  if (!names.length || !workspaceRoot) return [];
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

/** Segments of a Codex-backed profile, read from models.json each time and split per heading. */
export function codexSegments(codexDir: string | null, modelId?: string): HarnessSegment[] {
  const catalog = readCodexCatalog(codexDir);
  if (!catalog.ok) throw new HttpError(400, "codex_unavailable", catalog.message);
  const entry = (modelId ? catalog.models.find((m) => m.slug === modelId) : undefined) ?? catalog.models[0]!;
  return codexProfileSegments(entry.instructions);
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
  /** Saved memories that apply to this thread. */
  memories?: string[];
  /** The list of available skills, already written out. */
  skills?: string;
}

const APPROVAL_TEXT: Record<ApprovalMode, string> = {
  ask: "ask first (the user approves every file change and command)",
  edit: "auto-edit (file changes inside the workspace run without asking; commands ask first)",
  full: "full auto (everything inside the workspace runs without asking, except risky actions)",
};

export interface RenderedPrompt {
  /** The system prompt (instructions). */
  text: string;
  /** Length of the leading part that stays the same between requests: the part a provider can cache. */
  stableChars: number;
  /** Developer messages sent right after the system prompt. */
  developer: string[];
  /** One user message placed just before the owner's latest message; empty when the profile has none. */
  context: string;
}

/** Codex's wording for the permission situation, from codex-rs/prompts/templates/permissions. */
function codexPermissions(approval: ApprovalMode): string {
  // EZClaw has no operating-system sandbox, so the honest mode is danger-full-access.
  const sandbox = "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.";
  const policy =
    approval === "full"
      ? "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected."
      : " `approval_policy` is `unless-trusted`: The harness will require user approval before running commands unless an explicit exec policy rule allows them.";
  return `${sandbox}\n${policy}`;
}

/** AGENTS.md as Codex sends it: a user message starting "# AGENTS.md instructions for <folder>". */
function codexInstructions(i: ProjectInstruction, workspace: string): string {
  const dir = i.label.includes("/") || i.label.includes("\\") ? join(workspace, dirname(i.label)) : workspace;
  return `# AGENTS.md instructions for ${dir}\n\n<INSTRUCTIONS>\n${i.text}\n</INSTRUCTIONS>`;
}

/**
 * Builds what the harness adds to a request. The system prompt is ordered for prompt caching: the
 * profile's stable segments, then project instruction files, skills, saved memories and the thread's
 * own additions, and only then the segments that change (date, folder, mode). Segments placed as
 * developer or context messages are returned separately; the caller puts them in the conversation.
 */
export function renderPrompt(profile: HarnessProfile, ctx: PromptContext, instructions: ProjectInstruction[]): RenderedPrompt {
  const segments = profile.fromCodex ? codexSegments(ctx.codexDir, ctx.modelId) : profile.segments;
  const vars = {
    date: ctx.date,
    os: ctx.os,
    shell: ctx.shell === "powershell" ? "PowerShell" : "bash",
    shellName: ctx.shell === "powershell" ? "powershell" : "bash",
    workspace: ctx.workspace,
    approval: APPROVAL_TEXT[ctx.approval],
    model: ctx.modelId,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    codexPermissions: codexPermissions(ctx.approval),
  };
  const tags = profile.wrap === "tags";
  const rendered = renderSegments(segments, profile.wrap, vars);
  const head: string[] = [rendered.stable];
  const contextParts: string[] = [];
  for (const i of instructions) {
    if (profile.instructionsStyle === "codex") contextParts.push(codexInstructions(i, ctx.workspace));
    else head.push(wrapBlock(tags ? "project_instructions" : `Project instructions (${i.label})`, tags ? `Source: ${i.label}\n\n${i.text}` : i.text, profile.wrap));
  }
  contextParts.push(...rendered.context);
  if (ctx.skills) head.push(wrapBlock(tags ? "skills" : "Skills", ctx.skills, profile.wrap));
  if (profile.memory && ctx.memories?.length) head.push(wrapBlock(tags ? "user_memory" : "Saved memory", ctx.memories.map((m) => `- ${m}`).join("\n"), profile.wrap));
  if (ctx.userPrompt.trim()) head.push(wrapBlock(tags ? "additional_instructions" : "Additional instructions from the user", ctx.userPrompt.trim(), profile.wrap));
  const stablePart = head.filter(Boolean).join("\n\n");
  return {
    text: [stablePart, rendered.dynamic].filter(Boolean).join("\n\n"),
    stableChars: stablePart.length,
    developer: rendered.developer,
    context: contextParts.join("\n\n"),
  };
}

/** The system prompt as text. Throws a readable error if a Codex profile has no source. */
export function renderSystemPrompt(profile: HarnessProfile, ctx: PromptContext, instructions: ProjectInstruction[]): string {
  return renderPrompt(profile, ctx, instructions).text;
}

/**
 * Puts the harness's extra messages into a conversation that is about to be sent: developer messages
 * first, then the context message just before the latest user message, and the owner's own messages
 * wrapped in the profile's tag. Nothing here is stored.
 */
export function withHarnessMessages(history: CanonicalMessage[], rendered: Pick<RenderedPrompt, "developer" | "context">, userTag: string | null): CanonicalMessage[] {
  const wrapped = userTag
    ? history.map((m) =>
        m.role === "user" && !isSummary(m)
          ? { ...m, parts: m.parts.map((p) => (p.type === "text" ? { ...p, text: `<${userTag}>\n${p.text}\n</${userTag}>` } : p)) }
          : m,
      )
    : history;
  const out: CanonicalMessage[] = [...rendered.developer.map((text): CanonicalMessage => ({ role: "developer", parts: [{ type: "text", text }] })), ...wrapped];
  if (rendered.context) {
    let at = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]!.role === "user") {
        at = i;
        break;
      }
    }
    const message: CanonicalMessage = { role: "user", parts: [{ type: "text", text: rendered.context }] };
    if (at >= 0) out.splice(at, 0, message);
    else out.push(message);
  }
  return out;
}

const SUMMARY_MARK = "Ringkasan percakapan sebelumnya";
function isSummary(m: CanonicalMessage): boolean {
  return m.parts.some((p) => p.type === "text" && p.text.startsWith(SUMMARY_MARK));
}

/** Profiles saved before segments existed kept one `systemPrompt` text; split it on read. */
function migrate(data: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(data.segments)) return data;
  const legacy = typeof data.systemPrompt === "string" ? data.systemPrompt : "";
  const split = legacy.trim() ? splitWrapperText(legacy) : { wrap: "plain" as const, segments: [] };
  const { systemPrompt: _legacy, ...rest } = data;
  return { ...rest, segments: split.segments, wrap: split.wrap, origin: rest.origin ?? "Profil lama, dipecah otomatis" };
}

export class HarnessService {
  constructor(
    private readonly db: Db,
    private readonly codexDir: () => string | null = () => null,
  ) {}

  /** Built-in profiles first. The Codex profile shows the segments of the current install, or none if it cannot be read. */
  list(): HarnessProfile[] {
    const custom = this.db
      .select()
      .from(harnessProfiles)
      .all()
      .flatMap((row) => {
        const parsed = harnessProfileSchema.safeParse(migrate(row.data as Record<string, unknown>));
        return parsed.success ? [{ ...parsed.data, id: row.id, name: row.name, builtin: false }] : [];
      });
    return [...BUILTIN_PROFILES, ...custom].map((p) => {
      if (!p.fromCodex) return p;
      try {
        return { ...p, segments: codexSegments(this.codexDir()) };
      } catch {
        return p;
      }
    });
  }

  get(id: string): HarnessProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  require(id: string): HarnessProfile {
    const profile = this.get(id);
    if (!profile) throw new HttpError(404, "harness_not_found", `Profil harness "${id}" tidak ditemukan.`);
    return profile;
  }

  private insert(profile: HarnessProfile): HarnessProfile {
    this.db.insert(harnessProfiles).values({ id: profile.id, name: profile.name, data: profile as unknown as Record<string, unknown>, createdAt: new Date() }).run();
    return profile;
  }

  duplicate(id: string, name?: string): HarnessProfile {
    const source = this.require(id);
    if (source.fromCodex && source.segments.length === 0) {
      throw new HttpError(400, "codex_unavailable", "Wrapper Codex belum bisa dibaca. Atur folder Codex di Settings, bagian Harness, lalu duplikasi lagi.");
    }
    // A copy of the Codex profile keeps today's text as its own, editable segments.
    return this.insert({
      ...source,
      id: randomUUID(),
      name: (name ?? `${source.name} (salinan)`).slice(0, 60),
      builtin: false,
      fromCodex: false,
      origin: source.fromCodex ? "Disalin dari Codex, bisa diubah" : source.origin,
    });
  }

  /** A new editable profile made from any wrapper text, split into segments by its tags or headings. */
  importText(name: string, mode: "chat" | "agent", text: string): HarnessProfile {
    const { wrap, segments } = splitWrapperText(text);
    const base = BUILTIN_PROFILES.find((p) => p.id === (mode === "agent" ? "ezclaw-agent" : "ezclaw-chat"))!;
    return this.insert({
      ...base,
      id: randomUUID(),
      name: name.slice(0, 60),
      description: `Diimpor dari teks, ${segments.length} segmen.`,
      builtin: false,
      origin: "Diimpor dari teks",
      segments,
      wrap,
      fromCodex: false,
    });
  }

  update(id: string, patch: HarnessProfilePatch): HarnessProfile {
    const current = this.require(id);
    if (current.builtin) throw new HttpError(400, "harness_builtin", "Profil bawaan tidak bisa diubah. Duplikasi dulu, lalu ubah salinannya.");
    const ids = new Set<string>();
    for (const s of patch.segments ?? []) {
      if (ids.has(s.id)) throw new HttpError(400, "segment_duplicate", `ID segmen "${s.id}" dipakai dua kali.`);
      ids.add(s.id);
    }
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
