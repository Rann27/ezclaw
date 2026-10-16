import { spawn, type ChildProcess } from "node:child_process";
import { cleanEnv, killTree, spawnArgs, type ShellKind } from "./shell.js";

const MAX_BUFFER = 400_000;
const MAX_PER_THREAD = 6;

interface Proc {
  id: string;
  threadId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  /** Everything printed so far (trimmed from the front once it is large). */
  output: string;
  /** Characters dropped from the front because the buffer was full. */
  dropped: number;
  /** How much of `output` (counting dropped) the agent has already read. */
  readUpTo: number;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
}

export interface ProcessView {
  id: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  /** Output printed since the agent last read it. */
  output: string;
  startedSeconds: number;
}

/**
 * Long-running commands an agent starts and checks on later (dev servers, watchers, slow builds).
 * They outlive a single run but not the EZClaw server: everything is stopped on shutdown.
 */
export class ProcessManager {
  private readonly procs = new Map<string, Proc>();
  private counter = 0;

  start(threadId: string, command: string, cwd: string, shell: ShellKind): ProcessView {
    const running = [...this.procs.values()].filter((p) => p.threadId === threadId && p.running);
    if (running.length >= MAX_PER_THREAD) throw new Error(`Sudah ada ${running.length} proses berjalan di thread ini. Hentikan salah satu dengan stop_process dulu.`);
    const { file, args } = spawnArgs(shell, command);
    const child = spawn(file, args, { cwd, env: cleanEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    const id = `p${++this.counter}`;
    const proc: Proc = { id, threadId, command, cwd, child, output: "", dropped: 0, readUpTo: 0, exitCode: null, running: true, startedAt: Date.now() };
    const onData = (chunk: Buffer) => {
      proc.output += chunk.toString("utf8");
      if (proc.output.length > MAX_BUFFER) {
        const cut = proc.output.length - MAX_BUFFER;
        proc.output = proc.output.slice(cut);
        proc.dropped += cut;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      onData(Buffer.from(`Gagal menjalankan: ${err.message}\n`));
      proc.running = false;
    });
    child.on("close", (code) => {
      proc.running = false;
      proc.exitCode = code;
    });
    this.procs.set(id, proc);
    return this.view(proc, false);
  }

  private find(threadId: string, id: string): Proc {
    const p = this.procs.get(id);
    if (!p || p.threadId !== threadId) throw new Error(`Proses ${id} tidak ada di thread ini.`);
    return p;
  }

  private view(p: Proc, consume: boolean): ProcessView {
    const start = Math.max(0, p.readUpTo - p.dropped);
    const fresh = p.output.slice(start);
    const skipped = p.readUpTo < p.dropped ? `[${p.dropped - p.readUpTo} karakter lama terlewat]\n` : "";
    if (consume) p.readUpTo = p.dropped + p.output.length;
    return { id: p.id, command: p.command, running: p.running, exitCode: p.exitCode, output: skipped + fresh, startedSeconds: Math.round((Date.now() - p.startedAt) / 1000) };
  }

  /** New output since the last read. Waits up to `waitMs` for something to arrive or for the process to end. */
  async read(threadId: string, id: string, waitMs: number): Promise<ProcessView> {
    const p = this.find(threadId, id);
    const until = Date.now() + Math.min(waitMs, 30_000);
    const seen = p.dropped + p.output.length;
    while (Date.now() < until && p.running && p.dropped + p.output.length === seen) await new Promise((r) => setTimeout(r, 200));
    return this.view(p, true);
  }

  stop(threadId: string, id: string): ProcessView {
    const p = this.find(threadId, id);
    if (p.running) killTree(p.child.pid);
    p.running = false;
    return this.view(p, true);
  }

  list(threadId: string): ProcessView[] {
    return [...this.procs.values()].filter((p) => p.threadId === threadId).map((p) => ({ ...this.view(p, false), output: "" }));
  }

  stopAll() {
    for (const p of this.procs.values()) if (p.running) killTree(p.child.pid);
  }
}
