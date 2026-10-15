import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

export interface ResolvedPath {
  abs: string;
  /** Path to show: relative to the workspace when inside it, absolute otherwise. */
  display: string;
  inside: boolean;
}

/** Resolves as much of a path as exists (following symlinks), then appends the rest unchanged. */
function realpathBestEffort(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

const DEFAULT_IGNORES = [".git/", "node_modules/", ".DS_Store", "Thumbs.db"];

/**
 * The folder an agent works in. Every path a tool receives goes through `resolve`, which
 * decides whether it is inside, so a `..` or a symlink cannot quietly leave the workspace.
 */
export class Workspace {
  readonly root: string;
  private ig: Ignore | null = null;

  constructor(root: string) {
    this.root = realpathBestEffort(root);
  }

  static validate(path: string): { ok: true; root: string } | { ok: false; message: string } {
    if (!path || !isAbsolute(path)) return { ok: false, message: "Path workspace harus absolut, misalnya F:\\proyek\\app." };
    let root: string;
    try {
      root = realpathSync.native(path);
    } catch {
      return { ok: false, message: `Folder tidak ditemukan: ${path}` };
    }
    if (!statSync(root).isDirectory()) return { ok: false, message: `Bukan folder: ${path}` };
    return { ok: true, root };
  }

  resolve(p: string | undefined): ResolvedPath {
    const abs = resolve(this.root, p && p.length ? p : ".");
    const real = realpathBestEffort(abs);
    const rel = relative(this.root, real);
    const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    return { abs: real, display: inside ? rel.split(sep).join("/") || "." : real, inside };
  }

  /** Whether `.gitignore` (plus a few defaults) says to skip this workspace-relative path. */
  isIgnored(relPath: string, isDir: boolean): boolean {
    if (!this.ig) {
      this.ig = ignore().add(DEFAULT_IGNORES);
      const gitignore = join(this.root, ".gitignore");
      if (existsSync(gitignore)) {
        try {
          this.ig.add(readFileSync(gitignore, "utf8"));
        } catch {
          // An unreadable .gitignore just means fewer exclusions.
        }
      }
    }
    const clean = relPath.split(sep).join("/");
    if (!clean || clean === ".") return false;
    return this.ig.ignores(isDir ? `${clean}/` : clean);
  }
}
