import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { AgentLoopConfig, ApprovalMode, ApprovalRequest, PlanItem, ToolDef } from "@ezclaw/core";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { PatchError, planPatch, type FileChange } from "./patch.js";
import { dangerReason, defaultRulePattern, parseCommand, runShell, type ParsedCommand, type ShellKind } from "./shell.js";
import type { Workspace } from "./workspace.js";

export class ToolArgError extends Error {}

/** What must be true before a tool runs: who has to say yes, and in which modes nobody does. */
export interface ApprovalNeed {
  request: ApprovalRequest;
  /** Modes in which this runs without asking. */
  autoIn: ApprovalMode[];
  /** For shell commands: lets an "always allow" rule stand in for a decision. */
  parsed?: ParsedCommand;
  /** Ask in every mode, whatever rules say. */
  alwaysAsk?: boolean;
}

export interface ToolOutcome {
  output: string;
  isError?: boolean;
}

export interface Prepared {
  need: ApprovalNeed | null;
  run(): Promise<ToolOutcome>;
}

export interface ToolEnv {
  workspace: Workspace;
  config: AgentLoopConfig;
  shell: ShellKind;
  signal: AbortSignal;
  setPlan(items: PlanItem[]): void;
  ask(question: string, options?: string[]): Promise<string>;
}

export interface ToolImpl {
  name: string;
  def: ToolDef;
  /** True when the tool only reads, so several can run at once. */
  readOnly: boolean;
  prepare(args: unknown, env: ToolEnv): Prepared;
}

/* ----------------------------------------------------------------- helpers */

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

function parseArgs<S extends z.ZodType>(schema: S, args: unknown): z.infer<S> {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ToolArgError(`Argumen tidak valid (${where}${issue?.message ?? "format salah"}).`);
  }
  return parsed.data;
}

function define<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  readOnly: boolean,
  prepare: (args: z.infer<S>, env: ToolEnv) => Prepared,
): ToolImpl {
  return {
    name,
    readOnly,
    def: { name, description, parameters: jsonSchema(schema) },
    prepare: (args, env) => prepare(parseArgs(schema, args), env),
  };
}

const KB = 1024;
const MAX_READ_BYTES = 2 * 1024 * KB;
const MAX_READ_LINES = 2000;
const MAX_LIST_ENTRIES = 400;
const MAX_SEARCH_FILE_BYTES = 1024 * KB;

function humanSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / KB / KB).toFixed(1)} MB`;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function readText(abs: string, display: string): string {
  if (!existsSync(abs)) throw new ToolArgError(`File tidak ada: ${display}`);
  const st = statSync(abs);
  if (st.isDirectory()) throw new ToolArgError(`${display} adalah folder, bukan file. Pakai list_dir.`);
  if (st.size > MAX_READ_BYTES) throw new ToolArgError(`${display} terlalu besar (${humanSize(st.size)}). Pakai search atau shell untuk bagian tertentu.`);
  const buf = readFileSync(abs);
  if (looksBinary(buf)) throw new ToolArgError(`${display} adalah file biner.`);
  return buf.toString("utf8");
}

function diffPreview(display: string, before: string | null, after: string | null): string {
  const patch = createTwoFilesPatch(display, display, before ?? "", after ?? "", before === null ? "(baru)" : "", after === null ? "(dihapus)" : "", { context: 3 });
  const body = patch.split("\n").slice(2).join("\n").trimEnd();
  return body.length > 6000 ? `${body.slice(0, 6000)}\n... (diff dipotong)` : body;
}

function outsideReason(): string {
  return "Path ini berada di luar workspace.";
}

/* --------------------------------------------------------------- read-only */

const listDir = define(
  "list_dir",
  "List the files and folders in a directory of the workspace. Respects .gitignore. Use depth to see nested folders.",
  z.object({
    path: z.string().optional().describe("Directory to list, relative to the workspace. Defaults to the workspace root."),
    depth: z.number().int().min(1).max(4).optional().describe("How many levels to show. Default 1."),
  }),
  true,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    return {
      need: target.inside ? null : { request: { kind: "outside", title: `Lihat isi folder di luar workspace`, path: target.display, reason: outsideReason() }, autoIn: ["full"] },
      async run() {
        if (!existsSync(target.abs) || !statSync(target.abs).isDirectory()) throw new ToolArgError(`Folder tidak ada: ${target.display}`);
        const depth = args.depth ?? 1;
        const lines: string[] = [];
        let count = 0;
        let cut = false;
        const walk = (dir: string, level: number) => {
          let entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          for (const e of entries) {
            const abs = join(dir, e.name);
            if (target.inside && env.workspace.isIgnored(relative(env.workspace.root, abs), e.isDirectory())) continue;
            if (count >= MAX_LIST_ENTRIES) {
              cut = true;
              return;
            }
            count++;
            const pad = "  ".repeat(level);
            if (e.isDirectory()) {
              lines.push(`${pad}${e.name}/`);
              if (level + 1 < depth) walk(abs, level + 1);
            } else {
              let size = "";
              try {
                size = ` (${humanSize(statSync(abs).size)})`;
              } catch {
                // A file that vanished mid-listing is simply shown without a size.
              }
              lines.push(`${pad}${e.name}${size}`);
            }
          }
        };
        walk(target.abs, 0);
        const head = `${target.display === "." ? "(workspace)" : target.display}/`;
        const out = [head, ...lines];
        if (cut) out.push(`... daftar dipotong di ${MAX_LIST_ENTRIES} entri. Tentukan path yang lebih spesifik.`);
        if (!lines.length) out.push("(kosong)");
        return { output: out.join("\n") };
      },
    };
  },
);

const readFile = define(
  "read_file",
  "Read a text file from the workspace. Lines are returned with their line numbers (the numbers are not part of the file). Use start_line and end_line for large files.",
  z.object({
    path: z.string().describe("File path, relative to the workspace."),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  true,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    return {
      need: target.inside ? null : { request: { kind: "outside", title: "Baca file di luar workspace", path: target.display, reason: outsideReason() }, autoIn: ["full"] },
      async run() {
        const text = readText(target.abs, target.display);
        const all = text.split(/\r?\n/);
        if (all.at(-1) === "") all.pop();
        const start = args.start_line ?? 1;
        const end = Math.min(args.end_line ?? all.length, start + MAX_READ_LINES - 1, all.length);
        if (start > all.length && all.length > 0) throw new ToolArgError(`start_line ${start} melewati akhir file (${all.length} baris).`);
        const width = String(end).length;
        const body = all.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}\t${l}`);
        const note = end < all.length ? `\n... file berlanjut sampai baris ${all.length}. Panggil lagi dengan start_line ${end + 1}.` : "";
        return { output: `${target.display} (${all.length} baris, menampilkan ${start}-${end})\n${body.join("\n")}${note}` };
      },
    };
  },
);

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const close = glob.indexOf("}", i);
      if (close > i) {
        re += `(?:${glob
          .slice(i + 1, close)
          .split(",")
          .map((p) => p.replace(/[.+^$()|[\]\\]/g, "\\$&"))
          .join("|")})`;
        i = close;
      } else re += "\\{";
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const search = define(
  "search",
  "Search file contents in the workspace with a regular expression (like ripgrep). Respects .gitignore and skips binary files. Returns path:line: text.",
  z.object({
    pattern: z.string().min(1).describe("Regular expression to look for."),
    path: z.string().optional().describe("Directory or file to search in. Defaults to the workspace root."),
    glob: z.string().optional().describe("Only search files whose path matches this glob, e.g. **/*.ts"),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(500).optional().describe("Default 100."),
  }),
  true,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    return {
      need: target.inside ? null : { request: { kind: "outside", title: "Cari di luar workspace", path: target.display, reason: outsideReason() }, autoIn: ["full"] },
      async run() {
        let regex: RegExp;
        try {
          regex = new RegExp(args.pattern, args.ignore_case ? "i" : "");
        } catch (err) {
          throw new ToolArgError(`Regex tidak valid: ${err instanceof Error ? err.message : String(err)}`);
        }
        const glob = args.glob ? globToRegex(args.glob) : null;
        const globHasSlash = args.glob?.includes("/") ?? false;
        const max = args.max_results ?? 100;
        const hits: string[] = [];
        let files = 0;
        let capped = false;

        const visit = (abs: string) => {
          if (hits.length >= max || files > 20000) {
            capped = true;
            return;
          }
          const rel = relative(env.workspace.root, abs).split(sep).join("/");
          let st;
          try {
            st = statSync(abs);
          } catch {
            return;
          }
          if (st.isDirectory()) {
            if (target.inside && abs !== target.abs && env.workspace.isIgnored(rel, true)) return;
            for (const name of readdirSync(abs)) visit(join(abs, name));
            return;
          }
          if (target.inside && abs !== target.abs && env.workspace.isIgnored(rel, false)) return;
          if (glob && !glob.test(globHasSlash ? rel : basename(abs))) return;
          if (st.size > MAX_SEARCH_FILE_BYTES) return;
          let buf: Buffer;
          try {
            buf = readFileSync(abs);
          } catch {
            return;
          }
          if (looksBinary(buf)) return;
          files++;
          const lines = buf.toString("utf8").split(/\r?\n/);
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (regex.test(lines[i]!)) {
              const text = lines[i]!.length > 300 ? `${lines[i]!.slice(0, 300)}...` : lines[i]!;
              hits.push(`${target.inside ? rel : abs}:${i + 1}: ${text}`);
            }
          }
        };
        if (!existsSync(target.abs)) throw new ToolArgError(`Path tidak ada: ${target.display}`);
        visit(target.abs);
        if (!hits.length) return { output: `Tidak ada hasil untuk /${args.pattern}/ di ${files} file.` };
        const tail = capped || hits.length >= max ? `\n... dibatasi ${max} hasil. Persempit pencarian dengan path atau glob.` : "";
        return { output: `${hits.join("\n")}${tail}` };
      },
    };
  },
);

/* ---------------------------------------------------------------- editing */

function writeNeed(env: ToolEnv, target: { inside: boolean; display: string }, title: string, kind: "write" | "edit", diff: string): ApprovalNeed {
  const request: ApprovalRequest = { kind: target.inside ? kind : "outside", title, path: target.display, diff };
  if (!target.inside) request.reason = outsideReason();
  return target.inside ? { request, autoIn: ["edit", "full"] } : { request, autoIn: [], alwaysAsk: true };
}

const writeFile = define(
  "write_file",
  "Create a file, or replace a file completely, with the given content. Parent folders are created. To change part of an existing file, prefer edit_file.",
  z.object({ path: z.string().describe("File path, relative to the workspace."), content: z.string() }),
  false,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    const exists = existsSync(target.abs);
    const before = exists ? (() => { try { return readText(target.abs, target.display); } catch { return null; } })() : null;
    return {
      need: writeNeed(env, target, exists ? `Timpa ${target.display}` : `Buat ${target.display}`, "write", diffPreview(target.display, before, args.content)),
      async run() {
        mkdirSync(dirname(target.abs), { recursive: true });
        writeFileSync(target.abs, args.content);
        const lines = args.content === "" ? 0 : args.content.split("\n").length;
        return { output: `${exists ? "Menimpa" : "Membuat"} ${target.display} (${lines} baris).` };
      },
    };
  },
);

const editFile = define(
  "edit_file",
  "Replace exact text in an existing file. old_string must match the file exactly (including whitespace) and appear once, unless replace_all is true. Do not include the line numbers that read_file prints.",
  z.object({
    path: z.string().describe("File path, relative to the workspace."),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  false,
  (args, env) => {
    const target = env.workspace.resolve(args.path);
    const before = readText(target.abs, target.display);
    const crlf = before.includes("\r\n");
    const oldText = crlf ? args.old_string.replace(/\r?\n/g, "\r\n") : args.old_string;
    const newText = crlf ? args.new_string.replace(/\r?\n/g, "\r\n") : args.new_string;
    if (oldText === newText) throw new ToolArgError("old_string dan new_string sama, tidak ada yang berubah.");

    const count = before.split(oldText).length - 1;
    if (count === 0) throw new ToolArgError(`old_string tidak ditemukan di ${target.display}. Baca file lagi dan salin teksnya persis, tanpa nomor baris.`);
    if (count > 1 && !args.replace_all) {
      throw new ToolArgError(`old_string ditemukan ${count} kali di ${target.display}. Tambahkan baris di sekitarnya agar unik, atau set replace_all.`);
    }
    const after = args.replace_all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText);

    return {
      need: writeNeed(env, target, `Ubah ${target.display}`, "edit", diffPreview(target.display, before, after)),
      async run() {
        writeFileSync(target.abs, after);
        return { output: `Mengubah ${target.display} (${args.replace_all ? `${count} penggantian` : "1 penggantian"}).` };
      },
    };
  },
);

const applyPatch = define(
  "apply_patch",
  [
    "Edit files with a patch. Format:",
    "*** Begin Patch",
    "*** Add File: path   (every following line starts with +)",
    "*** Delete File: path",
    "*** Update File: path   (optionally followed by *** Move to: newpath)",
    "@@ optional line that locates the change",
    " context line (starts with a space)",
    "-line to remove",
    "+line to add",
    "*** End Patch",
    "Paths are relative to the workspace. Context lines must match the file exactly.",
  ].join("\n"),
  z.object({ input: z.string().describe("The whole patch text, from *** Begin Patch to *** End Patch.") }),
  false,
  (args, env) => {
    let changes: FileChange[];
    try {
      changes = planPatch(args.input, env.workspace);
    } catch (err) {
      if (err instanceof PatchError) throw new ToolArgError(err.message);
      throw err;
    }
    const outside = changes.find((c) => !c.target.inside || (c.moveTo && !c.moveTo.inside));
    const diff = changes
      .map((c) => `${c.kind === "add" ? "+++ baru" : c.kind === "delete" ? "--- hapus" : "~~~ ubah"} ${c.target.display}${c.moveTo ? ` -> ${c.moveTo.display}` : ""}\n${diffPreview(c.target.display, c.oldContent, c.newContent)}`)
      .join("\n\n");
    const names = changes.map((c) => c.target.display).join(", ");
    const request: ApprovalRequest = { kind: outside ? "outside" : "edit", title: `Terapkan patch: ${names.length > 80 ? `${changes.length} file` : names}`, diff };
    if (outside) request.reason = outsideReason();
    return {
      need: outside ? { request, autoIn: [], alwaysAsk: true } : { request, autoIn: ["edit", "full"] },
      async run() {
        for (const c of changes) {
          if (c.kind === "delete") unlinkSync(c.target.abs);
          else {
            const dest = c.moveTo ?? c.target;
            mkdirSync(dirname(dest.abs), { recursive: true });
            writeFileSync(dest.abs, c.newContent ?? "");
            if (c.moveTo && c.moveTo.abs !== c.target.abs) unlinkSync(c.target.abs);
          }
        }
        return { output: `Patch diterapkan: ${changes.map((c) => `${c.kind === "add" ? "baru" : c.kind === "delete" ? "hapus" : "ubah"} ${c.target.display}`).join(", ")}.` };
      },
    };
  },
);

/* ------------------------------------------------------------------ shell */

function shellTool(name: string, fields: { command: string; cwd: string; timeout: string }, description: string): ToolImpl {
  const schema = z.object({
    [fields.command]: z.string().min(1).describe("The command line to run."),
    [fields.cwd]: z.string().optional().describe("Directory to run in, relative to the workspace. Defaults to the workspace root."),
    [fields.timeout]: z.number().int().min(1000).max(600_000).optional().describe("Give up after this many milliseconds."),
  });
  return define(name, description, schema, false, (args, env) => {
    const a = args as Record<string, unknown>;
    const command = String(a[fields.command]);
    const cwd = env.workspace.resolve(a[fields.cwd] as string | undefined);
    const parsed = parseCommand(command);
    const danger = dangerReason(command);
    const rulePattern = parsed.hasControl ? undefined : defaultRulePattern(parsed);

    const request: ApprovalRequest = { kind: "shell", title: "Jalankan perintah", command, cwd: cwd.display, rulePattern };
    let alwaysAsk = false;
    if (!cwd.inside) {
      request.kind = "outside";
      request.reason = "Folder kerja berada di luar workspace.";
      alwaysAsk = true;
    } else if (danger) {
      request.reason = `Perintah berisiko: ${danger}`;
      alwaysAsk = true;
    }

    return {
      need: { request, autoIn: ["full"], parsed, alwaysAsk },
      async run() {
        const timeoutMs = Math.min((a[fields.timeout] as number | undefined) ?? env.config.shellTimeoutMs, 600_000);
        const result = await runShell({ command, cwd: cwd.abs, shell: env.shell, timeoutMs, signal: env.signal });
        const secs = (result.durationMs / 1000).toFixed(1);
        const status = result.timedOut
          ? `Timed out setelah ${Math.round(timeoutMs / 1000)} detik, proses dihentikan.`
          : result.stopped
            ? "Dihentikan oleh pengguna."
            : `Process exited with code ${result.exitCode ?? "tidak diketahui"}`;
        const tokens = Math.ceil(result.output.length / 4);
        const output = `${status}\nWall time: ${secs} seconds\nOriginal token count: ${tokens}\nOutput:\n${result.output.trimEnd() || "(tidak ada output)"}`;
        return { output, isError: result.timedOut || result.stopped || result.exitCode !== 0 };
      },
    };
  });
}

const SHELL_DESC = (shell: string) =>
  `Run a command in the workspace using ${shell}. Each call starts a fresh shell, so state (cd, variables) does not carry over. Output is shown with the exit code. Prefer the dedicated file tools for reading and editing files.`;

/* --------------------------------------------------------- plan and asking */

const updatePlan = define(
  "update_plan",
  "Write or update your step-by-step plan for a multi-step task. Keep at most one step in_progress, and mark steps completed as you finish them. Skip this for trivial tasks.",
  z.object({
    explanation: z.string().optional(),
    plan: z.array(z.object({ step: z.string().min(1), status: z.enum(["pending", "in_progress", "completed"]) })).min(1).max(20),
  }),
  false,
  (args, env) => ({
    need: null,
    async run() {
      if (args.plan.filter((p) => p.status === "in_progress").length > 1) {
        throw new ToolArgError("Hanya satu langkah yang boleh in_progress dalam satu waktu.");
      }
      env.setPlan(args.plan.map((p) => ({ text: p.step, status: p.status })));
      return { output: "Plan diperbarui." };
    },
  }),
);

const askUser = define(
  "ask_user",
  "Ask the user a question and wait for the answer. Use only when you are blocked by a choice that only the user can make and cannot be settled by looking at the workspace.",
  z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(6).optional().describe("Suggested answers the user can pick from.") }),
  false,
  (args, env) => ({
    need: null,
    async run() {
      const answer = await env.ask(args.question, args.options);
      return { output: `Jawaban pengguna: ${answer}` };
    },
  }),
);

/* ---------------------------------------------------------------- registry */

export function allTools(shell: ShellKind): ToolImpl[] {
  const shellName = shell === "powershell" ? "PowerShell" : "bash";
  return [
    listDir,
    readFile,
    search,
    writeFile,
    editFile,
    applyPatch,
    shellTool("shell", { command: "command", cwd: "cwd", timeout: "timeout_ms" }, SHELL_DESC(shellName)),
    shellTool("exec_command", { command: "cmd", cwd: "workdir", timeout: "yield_time_ms" }, SHELL_DESC(shellName)),
    updatePlan,
    askUser,
  ];
}

export const TOOL_NAMES = ["list_dir", "read_file", "search", "write_file", "edit_file", "apply_patch", "shell", "exec_command", "update_plan", "ask_user"] as const;

export function selectTools(names: string[], shell: ShellKind): ToolImpl[] {
  const all = new Map(allTools(shell).map((t) => [t.name, t]));
  return names.flatMap((n) => {
    const t = all.get(n);
    return t ? [t] : [];
  });
}

/** Head and tail of long output, with the middle replaced by a marker. */
export function clipOutput(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const dropped = text.length - head - tail;
  return { text: `${text.slice(0, head)}\n... [${dropped} karakter dilewati] ...\n${text.slice(text.length - tail)}`, truncated: true };
}
