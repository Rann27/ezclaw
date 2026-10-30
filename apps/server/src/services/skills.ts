import type { SkillDto, SkillImportResponse, SkillListResponse } from "@ezclaw/core";
import { eq } from "drizzle-orm";
import { unzipSync } from "fflate";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { discoverSkills, frontMatter, skillId, type Skill, type SkillState } from "../agent/skills.js";
import type { Db } from "../db/client.js";
import { skillStates } from "../db/schema.js";
import { HttpError } from "../errors.js";

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

/**
 * Skills as the owner manages them: which are on, which also work in Chat, and the ones in
 * EZClaw's own folder, which can be written, created, imported and deleted from the app.
 */
export class SkillService {
  constructor(
    private readonly db: Db,
    readonly dir: string,
    private readonly extraDirs: () => string[],
    private readonly mcpNames: () => string[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  states(): Map<string, SkillState> {
    return new Map(this.db.select().from(skillStates).all().map((r) => [r.id, { enabled: r.enabled, chat: r.chat }]));
  }

  discover(workspace: string | null): Skill[] {
    return discoverSkills(workspace, this.dir, this.extraDirs());
  }

  private editable(s: Skill): boolean {
    return resolve(s.dir).toLowerCase().startsWith(resolve(this.dir).toLowerCase() + sep);
  }

  list(workspace: string | null): SkillListResponse {
    const states = this.states();
    const known = new Set(this.mcpNames().map((n) => n.toLowerCase()));
    const skills: SkillDto[] = this.discover(workspace).map((s) => {
      const st = states.get(s.id) ?? { enabled: true, chat: false };
      return {
        id: s.id,
        name: s.name,
        description: s.description,
        source: s.source,
        dir: s.dir,
        editable: this.editable(s),
        enabled: st.enabled,
        chat: st.chat,
        mcp: s.mcp,
        missingMcp: s.mcp.filter((m) => !known.has(m.toLowerCase())),
      };
    });
    return { skills, dir: this.dir };
  }

  find(id: string, workspace: string | null = null): Skill {
    const s = this.discover(workspace).find((x) => x.id === id);
    if (!s) throw new HttpError(404, "skill_not_found", "Skill tidak ditemukan.");
    return s;
  }

  setState(id: string, patch: { enabled?: boolean; chat?: boolean }, workspace: string | null = null) {
    const s = this.find(id, workspace);
    const cur = this.states().get(id) ?? { enabled: true, chat: false };
    const next = { enabled: patch.enabled ?? cur.enabled, chat: patch.chat ?? cur.chat };
    this.db
      .insert(skillStates)
      .values({ id, path: s.file, ...next })
      .onConflictDoUpdate({ target: skillStates.id, set: next })
      .run();
  }

  read(id: string, workspace: string | null = null): { content: string; file: string; editable: boolean } {
    const s = this.find(id, workspace);
    return { content: readFileSync(s.file, "utf8"), file: s.file, editable: this.editable(s) };
  }

  write(id: string, content: string) {
    const s = this.find(id);
    if (!this.editable(s)) throw new HttpError(403, "skill_readonly", "Skill ini ada di luar folder skills EZClaw, jadi ubah langsung di foldernya.");
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(content)) throw new HttpError(400, "skill_front_matter", "SKILL.md harus diawali front matter --- berisi name dan description.");
    writeFileSync(s.file, content, "utf8");
  }

  create(input: { name: string; description: string; body: string; mcp: string[] }): SkillDto {
    const dir = join(this.dir, input.name);
    if (existsSync(dir)) throw new HttpError(409, "skill_exists", `Sudah ada folder skill "${input.name}".`);
    mkdirSync(dir, { recursive: true });
    const fm = ["---", `name: ${input.name}`, `description: ${input.description.replace(/\r?\n/g, " ")}`, ...(input.mcp.length ? [`mcp: [${input.mcp.join(", ")}]`] : []), "---", ""].join("\n");
    const body = input.body.trim() || `# ${input.name}\n\nTulis langkah-langkah yang harus diikuti agent di sini.\n`;
    writeFileSync(join(dir, "SKILL.md"), `${fm}\n${body}\n`, "utf8");
    const created = this.list(null).skills.find((s) => s.id === skillId(join(dir, "SKILL.md")));
    if (!created) throw new HttpError(500, "skill_create", "Skill dibuat, tetapi tidak terbaca.");
    return created;
  }

  remove(id: string) {
    const s = this.find(id);
    if (!this.editable(s)) throw new HttpError(403, "skill_readonly", "Hanya skill di folder skills EZClaw yang bisa dihapus dari sini.");
    rmSync(s.dir, { recursive: true, force: true });
    this.db.delete(skillStates).where(eq(skillStates.id, id)).run();
  }

  /* -------------------------------------------------------------- import */

  /** Copies every skill folder (one holding SKILL.md) found under `root` into EZClaw's folder. */
  private importTree(root: string): SkillImportResponse {
    const added: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const found: string[] = [];
    const walk = (d: string, depth: number) => {
      if (depth > 6 || found.length > 100) return;
      if (existsSync(join(d, "SKILL.md"))) {
        found.push(d);
        return;
      }
      let entries: string[] = [];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const e of entries) {
        if (e === "node_modules" || e.startsWith(".git")) continue;
        const p = join(d, e);
        try {
          if (statSync(p).isDirectory()) walk(p, depth + 1);
        } catch {
          // Skip unreadable folders.
        }
      }
    };
    walk(root, 0);
    if (!found.length) throw new HttpError(400, "skill_import_empty", "Tidak ada folder berisi SKILL.md di sana.");
    mkdirSync(this.dir, { recursive: true });
    for (const src of found) {
      const fm = frontMatter(readFileSync(join(src, "SKILL.md"), "utf8"));
      const name = (fm.name || basename(src)).replace(/[^\w.-]/g, "-").slice(0, 64);
      const dest = join(this.dir, name);
      if (existsSync(dest)) {
        skipped.push({ name, reason: "Sudah ada skill dengan nama ini." });
        continue;
      }
      cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(p) });
      added.push(name);
    }
    return { added, skipped };
  }

  importFolder(folder: string): SkillImportResponse {
    const root = resolve(folder);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new HttpError(400, "skill_import_folder", `Folder tidak ditemukan: ${root}`);
    if (root.toLowerCase().startsWith(resolve(this.dir).toLowerCase())) throw new HttpError(400, "skill_import_folder", "Folder ini sudah di dalam folder skills EZClaw.");
    return this.importTree(root);
  }

  importZip(bytes: Buffer): SkillImportResponse {
    if (bytes.length > MAX_ZIP_BYTES) throw new HttpError(413, "skill_zip_too_big", "File zip lebih dari 50 MB.");
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(new Uint8Array(bytes));
    } catch {
      throw new HttpError(400, "skill_zip_invalid", "File ini bukan zip yang valid.");
    }
    const tmp = mkdtempSync(join(tmpdir(), "ezclaw-skill-"));
    try {
      let total = 0;
      for (const [name, data] of Object.entries(files)) {
        if (name.endsWith("/")) continue;
        total += data.length;
        if (total > MAX_UNZIPPED_BYTES) throw new HttpError(413, "skill_zip_too_big", "Isi zip terlalu besar.");
        const dest = resolve(tmp, name);
        // No entry may land outside the temporary folder.
        if (!dest.startsWith(resolve(tmp) + sep)) continue;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, data);
      }
      return this.importTree(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** A GitHub repository, or a folder inside one (…/tree/branch/path). */
  async importGithub(url: string, signal?: AbortSignal): Promise<SkillImportResponse> {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(url.trim());
    if (!m) throw new HttpError(400, "skill_github_url", "Alamat harus berbentuk https://github.com/pemilik/repo, atau .../tree/branch/folder.");
    const [, owner, repo, ref, sub] = m;
    const zipUrl = `https://codeload.github.com/${owner}/${repo}/zip/${ref ? `refs/heads/${ref}` : "HEAD"}`;
    const res = await this.fetchImpl(zipUrl, { signal: signal ?? AbortSignal.timeout(60_000), redirect: "follow" });
    if (!res.ok) throw new HttpError(400, "skill_github_fetch", `GitHub menjawab ${res.status}. Periksa alamat repo dan branch (repo privat tidak didukung).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!sub) return this.importZip(bytes);
    // Keep only the requested folder.
    const files = unzipSync(new Uint8Array(bytes));
    const top = Object.keys(files)[0]?.split("/")[0] ?? "";
    const prefix = `${top}/${sub.replace(/\/$/, "")}/`;
    const picked = Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [relative(top, k).split(sep).join("/"), v]));
    if (!Object.keys(picked).length) throw new HttpError(400, "skill_github_path", `Folder "${sub}" tidak ada di repo itu.`);
    const { zipSync } = await import("fflate");
    return this.importZip(Buffer.from(zipSync(picked)));
  }
}
