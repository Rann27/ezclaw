import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import type { DirListResponse } from "@ezclaw/core";
import { HttpError } from "../errors.js";

const MAX_ENTRIES = 500;

/** Drive letters that exist on Windows; "/" elsewhere. */
export function listRoots(): string[] {
  if (process.platform !== "win32") return ["/"];
  const roots: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

function isHidden(name: string): boolean {
  return name.startsWith(".") || name === "$RECYCLE.BIN" || name === "System Volume Information" || name.startsWith("$");
}

/**
 * Folders inside `path`, for the folder picker. Only names of folders are returned, never files or
 * their contents. Without a path it returns the drives.
 */
export function listDirs(path: string | undefined): DirListResponse {
  const roots = listRoots();
  const home = homedir();
  if (!path) return { path: null, parent: null, entries: roots.map((r) => ({ name: r, path: r, hidden: false })), roots, home, truncated: false };
  if (!isAbsolute(path)) throw new HttpError(400, "path_not_absolute", "Path harus absolut.");

  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    throw new HttpError(404, "folder_not_found", `Folder tidak ditemukan: ${path}`);
  }
  if (!statSync(real).isDirectory()) throw new HttpError(400, "not_a_folder", `Bukan folder: ${path}`);

  let names: { name: string; dir: boolean }[];
  try {
    names = readdirSync(real, { withFileTypes: true }).map((d) => ({ name: d.name, dir: d.isDirectory() || (d.isSymbolicLink() && safeIsDir(join(real, d.name))) }));
  } catch {
    throw new HttpError(403, "folder_unreadable", `Folder ini tidak bisa dibuka (izin akses): ${real}`);
  }
  const dirs = names
    .filter((n) => n.dir)
    .map((n) => ({ name: n.name, path: join(real, n.name), hidden: isHidden(n.name) }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
  const isRoot = parse(real).root === real;
  return { path: real, parent: isRoot ? null : dirname(real), entries: dirs.slice(0, MAX_ENTRIES), roots, home, truncated: dirs.length > MAX_ENTRIES };
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Creates one new folder inside `parent` and returns its path. */
export function makeDir(parent: string, name: string): string {
  if (!isAbsolute(parent)) throw new HttpError(400, "path_not_absolute", "Path harus absolut.");
  let real: string;
  try {
    real = realpathSync.native(parent);
  } catch {
    throw new HttpError(404, "folder_not_found", `Folder tidak ditemukan: ${parent}`);
  }
  const target = join(real, name);
  if (existsSync(target)) throw new HttpError(409, "folder_exists", `Sudah ada: ${target}`);
  try {
    mkdirSync(target);
  } catch (err) {
    throw new HttpError(400, "mkdir_failed", `Folder tidak bisa dibuat: ${err instanceof Error ? err.message : String(err)}`);
  }
  return target;
}
