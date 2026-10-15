import { existsSync, readFileSync } from "node:fs";
import type { ResolvedPath, Workspace } from "./workspace.js";

export class PatchError extends Error {}

export interface FileChange {
  kind: "add" | "update" | "delete";
  target: ResolvedPath;
  /** Rename destination, for updates that move the file. */
  moveTo?: ResolvedPath;
  oldContent: string | null;
  newContent: string | null;
}

interface Hunk {
  header: string | null;
  lines: { op: " " | "-" | "+"; text: string }[];
}

type Op =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | null; hunks: Hunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";

function parse(text: string): Op[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = lines.findIndex((l) => l.trim() === BEGIN);
  if (i < 0) throw new PatchError(`Patch harus diawali "${BEGIN}".`);
  i++;
  const ops: Op[] = [];

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === END) return ops;
    if (line.trim() === "") {
      i++;
      continue;
    }

    const add = /^\*\*\* Add File: (.+)$/.exec(line);
    if (add) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const l = lines[i]!;
        if (!l.startsWith("+")) throw new PatchError(`Baris file baru harus diawali "+" (di "${add[1]}"): ${l.slice(0, 60)}`);
        body.push(l.slice(1));
        i++;
      }
      ops.push({ kind: "add", path: add[1]!.trim(), lines: body });
      continue;
    }

    const del = /^\*\*\* Delete File: (.+)$/.exec(line);
    if (del) {
      ops.push({ kind: "delete", path: del[1]!.trim() });
      i++;
      continue;
    }

    const upd = /^\*\*\* Update File: (.+)$/.exec(line);
    if (upd) {
      i++;
      let moveTo: string | null = null;
      const mv = /^\*\*\* Move to: (.+)$/.exec(lines[i] ?? "");
      if (mv) {
        moveTo = mv[1]!.trim();
        i++;
      }
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < lines.length && !/^\*\*\* (Add|Delete|Update) File:/.test(lines[i]!) && lines[i]!.trim() !== END) {
        const l = lines[i]!;
        i++;
        if (l.startsWith("*** End of File")) continue;
        if (l.startsWith("@@")) {
          current = { header: l.slice(2).trim() || null, lines: [] };
          hunks.push(current);
          continue;
        }
        if (!current) {
          current = { header: null, lines: [] };
          hunks.push(current);
        }
        const op = l[0];
        if (op === " " || op === "-" || op === "+") current.lines.push({ op, text: l.slice(1) });
        else if (l === "") current.lines.push({ op: " ", text: "" });
        else throw new PatchError(`Baris patch tidak dikenal di "${upd[1]}": ${l.slice(0, 60)}`);
      }
      if (!hunks.length && !moveTo) throw new PatchError(`Update "${upd[1]}" tidak punya perubahan.`);
      ops.push({ kind: "update", path: upd[1]!.trim(), moveTo, hunks });
      continue;
    }

    throw new PatchError(`Baris tidak dikenal di luar blok file: ${line.slice(0, 60)}`);
  }
  throw new PatchError(`Patch harus diakhiri "${END}".`);
}

function findBlock(file: string[], block: string[], from: number): number {
  if (block.length === 0) return from;
  const matchAt = (start: number, norm: (s: string) => string) => block.every((b, k) => norm(file[start + k] ?? "\u0000") === norm(b));
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    for (let start = from; start + block.length <= file.length; start++) if (matchAt(start, norm)) return start;
  }
  return -1;
}

function applyHunks(path: string, original: string, hunks: Hunk[]): string {
  const crlf = original.includes("\r\n");
  const file = original.replace(/\r\n/g, "\n").split("\n");
  let cursor = 0;

  for (const hunk of hunks) {
    if (hunk.header) {
      const at = file.findIndex((l, idx) => idx >= cursor && l.includes(hunk.header!));
      if (at >= 0) cursor = at;
    }
    const oldBlock = hunk.lines.filter((l) => l.op !== "+").map((l) => l.text);
    const at = findBlock(file, oldBlock, cursor);
    if (at < 0) {
      const preview = oldBlock.slice(0, 3).join("\n");
      throw new PatchError(`Konteks patch tidak cocok dengan isi "${path}". Baca file lagi lalu buat patch dari isi terbaru. Blok yang dicari diawali:\n${preview}`);
    }
    // Context lines keep the file's own text (trailing spaces and all); only - and + lines change it.
    const newBlock: string[] = [];
    let offset = 0;
    for (const l of hunk.lines) {
      if (l.op === " ") newBlock.push(file[at + offset++] ?? l.text);
      else if (l.op === "-") offset++;
      else newBlock.push(l.text);
    }
    file.splice(at, oldBlock.length, ...newBlock);
    cursor = at + newBlock.length;
  }
  const joined = file.join("\n");
  return crlf ? joined.replace(/\n/g, "\r\n") : joined;
}

/** Works out what a patch would change without writing anything, so it can be shown and approved first. */
export function planPatch(text: string, workspace: Workspace): FileChange[] {
  const ops = parse(text);
  if (!ops.length) throw new PatchError("Patch kosong: tidak ada file yang diubah.");
  const changes: FileChange[] = [];
  const seen = new Set<string>();

  for (const op of ops) {
    const target = workspace.resolve(op.path);
    if (seen.has(target.abs)) throw new PatchError(`File "${op.path}" muncul lebih dari sekali dalam satu patch.`);
    seen.add(target.abs);

    if (op.kind === "add") {
      if (existsSync(target.abs)) throw new PatchError(`"${op.path}" sudah ada. Pakai Update File untuk mengubahnya.`);
      changes.push({ kind: "add", target, oldContent: null, newContent: op.lines.join("\n") + (op.lines.length ? "\n" : "") });
    } else if (op.kind === "delete") {
      if (!existsSync(target.abs)) throw new PatchError(`"${op.path}" tidak ada, tidak bisa dihapus.`);
      changes.push({ kind: "delete", target, oldContent: readFileSync(target.abs, "utf8"), newContent: null });
    } else {
      if (!existsSync(target.abs)) throw new PatchError(`"${op.path}" tidak ada, tidak bisa diubah.`);
      const oldContent = readFileSync(target.abs, "utf8");
      const newContent = applyHunks(op.path, oldContent, op.hunks);
      const moveTo = op.moveTo ? workspace.resolve(op.moveTo) : undefined;
      if (moveTo && existsSync(moveTo.abs) && moveTo.abs !== target.abs) throw new PatchError(`Tujuan pindah "${op.moveTo}" sudah ada.`);
      changes.push({ kind: "update", target, moveTo, oldContent, newContent });
    }
  }
  return changes;
}
