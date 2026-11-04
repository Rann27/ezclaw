import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface Skill {
  /** Stable id derived from the SKILL.md path. */
  id: string;
  name: string;
  description: string;
  /** Folder that holds SKILL.md and any helper files. */
  dir: string;
  file: string;
  /** Where it was found, for the listing: "EZClaw", "workspace", or the configured folder. */
  source: string;
  /** MCP servers the skill needs (front matter `mcp:`); started when the skill is used. */
  mcp: string[];
}

/** Per-skill switches; a skill without one is on for Agent and off for Chat. */
export interface SkillState {
  enabled: boolean;
  chat: boolean;
}

const MAX_SKILLS = 200;
const MAX_SKILL_BYTES = 200 * 1024;

export function skillId(file: string): string {
  return createHash("sha1").update(resolve(file).toLowerCase()).digest("hex").slice(0, 16);
}

/** Reads `name:`, `description:` and `mcp:` from YAML front matter. Anything fancier is ignored. */
export function frontMatter(text: string): { name?: string; description?: string; mcp: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: { name?: string; description?: string; mcp: string[] } = { mcp: [] };
  if (!m) return out;
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^(name|description|mcp|mcp_servers|mcp-servers):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const value = kv[2]!.trim();
    if (kv[1] === "name" || kv[1] === "description") {
      out[kv[1]] = value.replace(/^["']|["']$/g, "").trim();
      continue;
    }
    if (value) {
      out.mcp.push(
        ...value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean),
      );
    } else {
      // A YAML list on the following lines.
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1]!)) out.mcp.push(lines[++i]!.replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, "").trim());
    }
  }
  return out;
}

function scan(root: string, source: string, into: Map<string, Skill>) {
  if (!existsSync(root)) return;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const n of names) {
    if (into.size >= MAX_SKILLS) return;
    const dir = join(root, n);
    const file = join(dir, "SKILL.md");
    try {
      if (!statSync(dir).isDirectory() || !existsSync(file) || statSync(file).size > MAX_SKILL_BYTES) continue;
      const fm = frontMatter(readFileSync(file, "utf8"));
      const name = (fm.name || n).slice(0, 80);
      // The first folder that defines a name wins, so a workspace skill overrides a global one of the same name.
      if (!into.has(name.toLowerCase())) into.set(name.toLowerCase(), { id: skillId(file), name, description: (fm.description ?? "").slice(0, 400), dir, file, source, mcp: fm.mcp.slice(0, 10) });
    } catch {
      // An unreadable skill is skipped.
    }
  }
}

/**
 * Skills on this computer: the workspace's own (.ezclaw/skills, .agents/skills, .claude/skills),
 * then EZClaw's skills folder, then the extra folders set in Settings.
 */
export function discoverSkills(workspace: string | null, ezclawDir: string, extraDirs: string[]): Skill[] {
  const found = new Map<string, Skill>();
  if (workspace) for (const sub of [".ezclaw/skills", ".agents/skills", ".claude/skills"]) scan(join(workspace, sub), "workspace", found);
  scan(ezclawDir, "EZClaw", found);
  for (const d of extraDirs) scan(d, d, found);
  return [...found.values()];
}

/** The skills a run may use: on, and for Chat also switched on for Chat. */
export function usableSkills(all: Skill[], states: Map<string, SkillState>, mode: "agent" | "chat"): Skill[] {
  return all.filter((s) => {
    const st = states.get(s.id) ?? { enabled: true, chat: false };
    return st.enabled && (mode === "agent" || st.chat);
  });
}

export function skillListing(skills: Skill[]): string {
  if (!skills.length) return "";
  return [
    "Skills are folders of instructions for specialised tasks. When a skill fits the task, call read_skill with its name and follow it before starting.",
    "",
    ...skills.map((s) => `- ${s.name}: ${s.description || "(tanpa deskripsi)"}`),
  ].join("\n");
}

export function readSkill(skill: Skill): string {
  const text = readFileSync(skill.file, "utf8");
  let files: string[] = [];
  try {
    files = readdirSync(skill.dir, { recursive: true })
      .map(String)
      .filter((f) => f !== "SKILL.md")
      .slice(0, 50);
  } catch {
    // The listing is a convenience.
  }
  const extra = files.length ? `\n\n---\nFile lain di folder skill (${skill.dir}):\n${files.map((f) => `- ${f}`).join("\n")}\nBaca dengan read_skill memakai name dan file bila perlu.` : "";
  return `${text}${extra}`;
}

/** A helper file of a skill, by its path inside the skill's folder. Chat has no read_file, so this is how it reaches them. */
export function readSkillFile(skill: Skill, file: string): string {
  const abs = resolve(skill.dir, file);
  const rel = relative(skill.dir, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`"${file}" ada di luar folder skill ${skill.name}.`);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`Skill ${skill.name} tidak punya file "${file}".`);
  if (statSync(abs).size > MAX_SKILL_BYTES) throw new Error(`File "${file}" terlalu besar untuk dibaca.`);
  return readFileSync(abs, "utf8");
}

/** Every `/name` in a message that names a skill, in order. `and/or` and `/usr/bin` are not such words. */
export function slashSkills(text: string, skills: Skill[]): Skill[] {
  const found = new Set<Skill>();
  for (const m of text.matchAll(/(?:^|\s)\/([A-Za-z0-9][\w-]*)(?=$|[\s.,;:!?)\]])/g)) {
    const skill = skills.find((s) => s.name.toLowerCase() === m[1]!.toLowerCase());
    if (skill) found.add(skill);
  }
  return [...found];
}
