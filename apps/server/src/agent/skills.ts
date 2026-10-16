import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  /** Folder that holds SKILL.md and any helper files. */
  dir: string;
  file: string;
  /** Where it was found, for the listing: "EZClaw", "workspace", or the configured folder. */
  source: string;
}

const MAX_SKILLS = 80;
const MAX_SKILL_BYTES = 200 * 1024;

/** Reads `name:` and `description:` from YAML front matter. Anything fancier is ignored. */
function frontMatter(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]!] = kv[2]!.replace(/^["']|["']$/g, "").trim();
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
      if (!into.has(name)) into.set(name, { name, description: (fm.description ?? "").slice(0, 400), dir, file, source });
    } catch {
      // An unreadable skill is skipped.
    }
  }
}

/**
 * Skills available to an agent: the workspace's own (.ezclaw/skills, .agents/skills, .claude/skills),
 * then EZClaw's skills folder, then the extra folders set in Settings.
 */
export function discoverSkills(workspace: string | null, ezclawDir: string, extraDirs: string[]): Skill[] {
  const found = new Map<string, Skill>();
  if (workspace) for (const sub of [".ezclaw/skills", ".agents/skills", ".claude/skills"]) scan(join(workspace, sub), "workspace", found);
  scan(ezclawDir, "EZClaw", found);
  for (const d of extraDirs) scan(d, d, found);
  return [...found.values()];
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
  const extra = files.length ? `\n\n---\nFile lain di folder skill (${skill.dir}):\n${files.map((f) => `- ${f}`).join("\n")}\nBaca dengan read_file memakai path absolut bila perlu.` : "";
  return `${text}${extra}`;
}
