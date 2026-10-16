import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import type { ApprovalRequest } from "@ezclaw/core";
import { z } from "zod";
import type { ProcessManager } from "./processes.js";
import { dangerReason, defaultRulePattern, parseCommand } from "./shell.js";
import { readSkill, type Skill } from "./skills.js";
import { define, globToRegex, ToolArgError, type ToolEnv, type ToolImpl } from "./tools.js";
import type { SearchResult } from "./web.js";

/** What the newer tools need from the run around them. */
export interface ToolExtras {
  threadId: string;
  processes: ProcessManager;
  skills: Skill[];
  /** Saves an image file as an asset and shows it to the model with its next request. */
  attachImage(abs: string, display: string): { width: number | null; height: number | null };
  /** False when the model's profile does not accept image input. */
  modelSeesImages: boolean;
  /** Records a proposal for the owner to approve. */
  proposeMemory(text: string, scope: "global" | "workspace"): void;
  fetchPage(url: string, signal: AbortSignal): Promise<{ url: string; title: string; text: string }>;
  /** Null when no search service is configured; the string says how to set one up. */
  search: ((query: string, count: number, signal: AbortSignal) => Promise<SearchResult[]>) | string;
  /** Runs a read-only helper agent on a question and returns its final report. */
  subagent(task: string, signal: AbortSignal): Promise<string>;
}

function ext(env: ToolEnv): ToolExtras {
  if (!env.ext) throw new ToolArgError("Tool ini tidak tersedia di lingkungan ini.");
  return env.ext;
}

/* ------------------------------------------------------------------ glob */

const MAX_GLOB = 500;

export const globTool = define(
  "glob",
  "Find files by name pattern in the workspace, e.g. **/*.ts or src/**/test_*.py. Respects .gitignore. Returns paths, newest first.",
  z.object({
    pattern: z.string().min(1).describe("Glob pattern. ** matches any folders, * any characters in one name, {a,b} either."),
    path: z.string().optional().describe("Folder to search in, relative to the workspace. Defaults to the workspace root."),
  }),
  true,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    return {
      need: target.inside ? null : { request: { kind: "outside", title: "Cari file di luar workspace", path: target.display, reason: "Path ini berada di luar workspace." }, autoIn: ["full"] },
      async run() {
        if (!existsSync(target.abs) || !statSync(target.abs).isDirectory()) throw new ToolArgError(`Folder tidak ada: ${target.display}`);
        const re = globToRegex(args.pattern.replace(/^\.\//, ""));
        const hasSlash = args.pattern.includes("/");
        const hits: { rel: string; mtime: number }[] = [];
        let visited = 0;
        const walk = (dir: string) => {
          if (hits.length >= MAX_GLOB * 4 || visited > 50_000) return;
          let entries;
          try {
            entries = readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            visited++;
            const abs = join(dir, e.name);
            const relWs = relative(env.workspace.root, abs);
            if (target.inside && env.workspace.isIgnored(relWs, e.isDirectory())) continue;
            if (e.isDirectory()) walk(abs);
            else {
              const rel = relative(target.abs, abs).split(sep).join("/");
              if (re.test(hasSlash ? rel : e.name)) {
                let mtime = 0;
                try {
                  mtime = statSync(abs).mtimeMs;
                } catch {
                  // Size and time are a nicety.
                }
                hits.push({ rel: target.inside ? relWs.split(sep).join("/") : abs, mtime });
              }
            }
          }
        };
        walk(target.abs);
        if (!hits.length) return { output: `Tidak ada file yang cocok dengan ${args.pattern}.` };
        hits.sort((a, b) => b.mtime - a.mtime);
        const shown = hits.slice(0, MAX_GLOB).map((h) => h.rel);
        return { output: `${shown.join("\n")}${hits.length > MAX_GLOB ? `\n... ${hits.length - MAX_GLOB} file lagi. Persempit polanya.` : ""}` };
      },
    };
  },
);

/* ------------------------------------------------------------- view_image */

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export const viewImageTool = define(
  "view_image",
  "Look at an image file (png, jpg, webp, gif) from the workspace. The image is shown to you with your next step.",
  z.object({ path: z.string().describe("Image path, relative to the workspace.") }),
  true,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    return {
      need: target.inside ? null : { request: { kind: "outside", title: "Lihat gambar di luar workspace", path: target.display, reason: "Path ini berada di luar workspace." }, autoIn: ["full"] },
      async run() {
        const x = ext(env);
        if (!x.modelSeesImages) return { output: "Model ini tidak menerima input gambar, jadi gambar tidak bisa dilihat. Jelaskan ke pengguna, atau minta mereka memakai model dengan vision.", isError: true };
        if (!IMAGE_EXT.has(extname(target.abs).toLowerCase())) throw new ToolArgError(`${target.display} bukan file gambar yang didukung (png, jpg, webp, gif).`);
        if (!existsSync(target.abs)) throw new ToolArgError(`File tidak ada: ${target.display}`);
        const size = x.attachImage(target.abs, target.display);
        return { output: `Gambar ${target.display}${size.width ? ` (${size.width}x${size.height})` : ""} dilampirkan dan terlihat di langkah berikutnya.` };
      },
    };
  },
);

/* ------------------------------------------------------- background processes */

function processNeed(command: string, cwdDisplay: string, inside: boolean) {
  const parsed = parseCommand(command);
  const danger = dangerReason(command);
  const request: ApprovalRequest = { kind: "shell", title: "Jalankan proses di latar belakang", command, cwd: cwdDisplay, rulePattern: parsed.hasControl ? undefined : defaultRulePattern(parsed) };
  let alwaysAsk = false;
  if (!inside) {
    request.kind = "outside";
    request.reason = "Folder kerja berada di luar workspace.";
    alwaysAsk = true;
  } else if (danger) {
    request.reason = `Perintah berisiko: ${danger}`;
    alwaysAsk = true;
  }
  return { request, autoIn: ["full" as const], parsed, alwaysAsk };
}

export const startProcessTool = define(
  "start_process",
  "Start a long-running command in the background (dev server, watcher, slow build) and return at once with its id. Check its output later with read_process; stop it with stop_process.",
  z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Folder to run in, relative to the workspace."),
  }),
  false,
  (args, env) => {
    const cwd = env.workspace.resolve(args.cwd);
    return {
      need: processNeed(args.command, cwd.display, cwd.inside),
      async run() {
        const x = ext(env);
        const p = x.processes.start(x.threadId, args.command, cwd.abs, env.shell);
        const first = await x.processes.read(x.threadId, p.id, 2000);
        return { output: `Proses ${p.id} dimulai${first.running ? " dan masih berjalan" : `, lalu berhenti dengan kode ${first.exitCode}`}.\nOutput awal:\n${first.output.trimEnd() || "(belum ada)"}` };
      },
    };
  },
);

export const readProcessTool = define(
  "read_process",
  "Read the output a background process printed since you last read it, and whether it is still running. Waits up to wait_ms for new output.",
  z.object({ id: z.string().min(1), wait_ms: z.number().int().min(0).max(30_000).optional().describe("Default 1000.") }),
  true,
  (args, env) => ({
    need: null,
    async run() {
      const x = ext(env);
      const v = await x.processes.read(x.threadId, args.id, args.wait_ms ?? 1000);
      return { output: `${v.id} ${v.running ? `berjalan (${v.startedSeconds} detik)` : `selesai, kode ${v.exitCode ?? "?"}`}\n${v.output.trimEnd() || "(tidak ada output baru)"}` };
    },
  }),
);

export const stopProcessTool = define(
  "stop_process",
  "Stop a background process started with start_process.",
  z.object({ id: z.string().min(1) }),
  false,
  (args, env) => ({
    need: null,
    async run() {
      const x = ext(env);
      const v = x.processes.stop(x.threadId, args.id);
      return { output: `Proses ${v.id} dihentikan.\n${v.output.trimEnd()}` };
    },
  }),
);

/* -------------------------------------------------------------------- web */

export const webFetchTool = define(
  "web_fetch",
  "Fetch a public web page and return its text (scripts and layout removed). Use for documentation or a page the user mentioned. Local and private network addresses are refused.",
  z.object({
    url: z.string().min(1),
    max_chars: z.number().int().min(1000).max(200_000).optional().describe("Default 30000."),
  }),
  true,
  (args, env) => {
    const request: ApprovalRequest = { kind: "web", title: "Ambil halaman web", command: args.url, reason: "Alamat ini dikirim ke internet." };
    return {
      need: { request, autoIn: ["full"] },
      async run() {
        const page = await ext(env).fetchPage(args.url, env.signal);
        const max = args.max_chars ?? 30_000;
        const text = page.text.length > max ? `${page.text.slice(0, max)}\n... [${page.text.length - max} karakter lagi; panggil dengan max_chars lebih besar bila perlu]` : page.text;
        return { output: `${page.title ? `# ${page.title}\n` : ""}${page.url}\n\n${text || "(halaman tidak berisi teks)"}` };
      },
    };
  },
);

export const webSearchTool = define(
  "web_search",
  "Search the web. Returns titles, URLs and snippets. Follow up with web_fetch to read a result.",
  z.object({ query: z.string().min(1).max(400), count: z.number().int().min(1).max(10).optional().describe("Default 5.") }),
  true,
  (args, env) => {
    const request: ApprovalRequest = { kind: "web", title: "Cari di web", command: args.query, reason: "Kata kunci ini dikirim ke layanan pencarian." };
    return {
      need: { request, autoIn: ["edit", "full"] },
      async run() {
        const x = ext(env);
        if (typeof x.search === "string") return { output: x.search, isError: true };
        const results = await x.search(args.query, args.count ?? 5, env.signal);
        if (!results.length) return { output: `Tidak ada hasil untuk "${args.query}".` };
        return { output: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").slice(0, 400)}`).join("\n\n") };
      },
    };
  },
);

/* ------------------------------------------------------- subagent and skills */

export const spawnAgentTool = define(
  "spawn_agent",
  "Delegate a read-only investigation to a helper agent with its own context (it can list, glob, search, read files, and fetch or search the web, but not change anything). Give it a complete, self-contained task; it returns a written report.",
  z.object({ task: z.string().min(10).max(8000).describe("What to find out, and what the report should contain.") }),
  true,
  (args, env) => ({
    need: null,
    async run() {
      const report = await ext(env).subagent(args.task, env.signal);
      return { output: `Laporan subagent:\n${report}` };
    },
  }),
);

export const readSkillTool = define(
  "read_skill",
  "Read the instructions of a skill listed in the system prompt, before doing a task it covers.",
  z.object({ name: z.string().min(1) }),
  true,
  (args, env) => ({
    need: null,
    async run() {
      const x = ext(env);
      const skill = x.skills.find((s) => s.name.toLowerCase() === args.name.toLowerCase());
      if (!skill) return { output: `Skill "${args.name}" tidak ada. Yang tersedia: ${x.skills.map((s) => s.name).join(", ") || "(tidak ada)"}.`, isError: true };
      return { output: readSkill(skill) };
    },
  }),
);

/* ----------------------------------------------------------------- memory */

export const proposeMemoryTool = define(
  "propose_memory",
  "Propose one short fact to remember in later sessions: a preference the user stated or a lasting project convention. The user approves or rejects it; nothing is saved until then. Never propose secrets.",
  z.object({
    text: z.string().min(3).max(500),
    scope: z.enum(["global", "workspace"]).optional().describe("workspace: only for this folder (default). global: for every thread."),
  }),
  false,
  (args, env) => ({
    need: null,
    async run() {
      if (/(api[_-]?key|password|secret|token)\s*[:=]/i.test(args.text) || /\b(sk|tvly|ghp|xox[bp])-[A-Za-z0-9_-]{8,}/.test(args.text)) {
        return { output: "Usulan ditolak: tampak berisi kredensial. Jangan simpan rahasia sebagai memori.", isError: true };
      }
      ext(env).proposeMemory(args.text.trim(), args.scope ?? "workspace");
      return { output: "Usulan memori dicatat. Pengguna akan memutuskan apakah disimpan." };
    },
  }),
);

export const EXTRA_TOOLS: ToolImpl[] = [globTool, viewImageTool, startProcessTool, readProcessTool, stopProcessTool, webFetchTool, webSearchTool, spawnAgentTool, readSkillTool, proposeMemoryTool];

/** Tools a helper agent may use: nothing that changes files, runs commands, or waits on the owner. */
export const SUBAGENT_TOOLS = ["list_dir", "glob", "read_file", "search", "web_fetch", "web_search", "read_skill"];
