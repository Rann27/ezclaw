import { spawn, spawnSync } from "node:child_process";

export type ShellKind = "powershell" | "bash";

export function defaultShell(): ShellKind {
  return process.platform === "win32" ? "powershell" : "bash";
}

export interface ParsedCommand {
  /** The command split into words, quotes removed. */
  words: string[];
  /** True when the text can do more than run one program: pipes, redirects, chaining, substitution. */
  hasControl: boolean;
}

/**
 * Splits a command line into words the way a shell would, and notes whether anything in it
 * could run a second command. Only a command without control syntax is safe to match against
 * an "always allow" rule, so `npm run build; curl evil` never matches `npm run build`.
 */
export function parseCommand(command: string): ParsedCommand {
  const words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: "'" | '"' | null = null;
  let hasControl = false;

  const push = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else {
        if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "(") || c === "$" && command[i + 1] === "{")) hasControl = true;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (c === "\n" || c === "\r") hasControl = true;
      push();
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === ">" || c === "<" || c === "`" || c === "(" || c === ")" || c === "{" || c === "}") {
      hasControl = true;
      push();
      continue;
    }
    if (c === "$" && (command[i + 1] === "(" || command[i + 1] === "{")) hasControl = true;
    word += c;
    hasWord = true;
  }
  if (quote) hasControl = true; // unbalanced quote: not something to trust
  push();
  return { words, hasControl };
}

/** True when the command's leading words equal a stored rule. Never true for commands with control syntax. */
export function matchesRule(command: ParsedCommand, pattern: string[]): boolean {
  if (command.hasControl || pattern.length === 0 || command.words.length < pattern.length) return false;
  return pattern.every((p, i) => (i === 0 ? command.words[0]!.toLowerCase() === p.toLowerCase() : command.words[i] === p));
}

/** The words an "always allow" would remember: the program and its leading subcommands, not its arguments. */
export function defaultRulePattern(command: ParsedCommand): string[] {
  const out: string[] = [];
  for (const w of command.words) {
    if (out.length === 3) break;
    const looksLikeArgument = w.startsWith("-") || /[\\/.:=,@]/.test(w) && out.length > 0 || /^\d/.test(w);
    if (out.length > 0 && looksLikeArgument) break;
    out.push(w);
  }
  return out.length ? out : command.words.slice(0, 1);
}

const DANGEROUS: { test: RegExp; reason: string }[] = [
  { test: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: "Menghapus file secara rekursif atau paksa (rm -r/-f)." },
  { test: /\bRemove-Item\b[^|;]*-Recurse/i, reason: "Menghapus folder beserta isinya (Remove-Item -Recurse)." },
  { test: /\b(del|erase)\b[^|;]*\/[sq]\b/i, reason: "Menghapus file secara rekursif (del /s)." },
  { test: /\b(rd|rmdir)\b[^|;]*\/s\b/i, reason: "Menghapus folder beserta isinya (rmdir /s)." },
  { test: /\bformat(-volume)?\b\s+[a-z]:/i, reason: "Memformat drive." },
  { test: /\b(mkfs|fdisk|diskpart)\b/i, reason: "Mengubah partisi atau sistem file." },
  { test: /\bdd\s+[^|;]*\bof=/i, reason: "Menulis langsung ke perangkat atau file dengan dd." },
  { test: /\b(shutdown|Stop-Computer|Restart-Computer|reboot|halt)\b/i, reason: "Mematikan atau memulai ulang komputer." },
  { test: /\bgit\s+push\b[^|;]*(--force|-f\b|--force-with-lease)/i, reason: "Push paksa ke remote git." },
  { test: /\bgit\s+reset\s+--hard\b/i, reason: "Membuang perubahan lokal (git reset --hard)." },
  { test: /\bgit\s+clean\b[^|;]*-[a-z]*f/i, reason: "Menghapus file untracked (git clean -f)." },
  { test: /\bgit\s+(checkout|restore)\b[^|;]*(--\s|\s\.\s*$)/i, reason: "Membuang perubahan file (git checkout/restore)." },
  { test: /\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^|;]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|powershell|pwsh)/i, reason: "Mengunduh lalu langsung menjalankan skrip." },
  { test: /\b(iex|Invoke-Expression)\b/i, reason: "Menjalankan teks sebagai perintah (Invoke-Expression)." },
  { test: /\breg(\.exe)?\s+(delete|add|import)\b/i, reason: "Mengubah registry Windows." },
  { test: /\bchmod\s+-R\b|\bchown\s+-R\b/i, reason: "Mengubah izin file secara rekursif." },
  { test: /\bSet-ExecutionPolicy\b|\bnetsh\b|\bsc(\.exe)?\s+(delete|config)\b/i, reason: "Mengubah pengaturan sistem." },
  { test: /(^|[\s;|&])(sudo|runas)\b/i, reason: "Menjalankan dengan hak administrator." },
];

/** Why a command deserves a decision even when the owner chose automatic mode, or null. */
export function dangerReason(command: string): string | null {
  for (const d of DANGEROUS) if (d.test.test(command)) return d.reason;
  return null;
}

/* ------------------------------------------------------------------- running */

export interface ShellRun {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
  stopped: boolean;
  /** Bytes dropped from the middle of very long output. */
  droppedBytes: number;
}

const KEEP_HEAD = 120_000;
const KEEP_TAIL = 120_000;

export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    // The agent runs with the owner's environment, minus EZClaw's own session secrets.
    if (!k.toUpperCase().startsWith("EZCLAW_")) env[k] = v;
  }
  return env;
}

export function spawnArgs(shell: ShellKind, command: string): { file: string; args: string[] } {
  if (shell === "powershell") {
    // PowerShell reports 1 for any failed native command; this passes the real exit code through.
    const script = `$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${command}
$ezOk = $?; if (-not $ezOk) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`;
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded] };
  }
  return { file: "bash", args: ["-lc", command] };
}

/** Stops a process and everything it started. */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    // Waits for taskkill, so the process no longer holds its folder when this returns.
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10_000 });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function runShell(opts: { command: string; cwd: string; shell: ShellKind; timeoutMs: number; signal: AbortSignal }): Promise<ShellRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const { file, args } = spawnArgs(opts.shell, opts.command);
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: cleanEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const head: Buffer[] = [];
    let headSize = 0;
    let tail: Buffer[] = [];
    let tailSize = 0;
    let total = 0;
    let timedOut = false;
    let stopped = false;
    let settled = false;

    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (headSize < KEEP_HEAD) {
        const take = Math.min(chunk.length, KEEP_HEAD - headSize);
        head.push(chunk.subarray(0, take));
        headSize += take;
        chunk = chunk.subarray(take);
      }
      if (chunk.length) {
        tail.push(chunk);
        tailSize += chunk.length;
        while (tailSize - (tail[0]?.length ?? 0) >= KEEP_TAIL) tailSize -= tail.shift()!.length;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const kill = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      stopped = true;
      kill();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      const keptTail = Buffer.concat(tail);
      const keptHead = Buffer.concat(head);
      const dropped = Math.max(0, total - keptHead.length - keptTail.length);
      const output = dropped > 0 ? `${keptHead.toString("utf8")}\n... [${dropped} byte dilewati] ...\n${keptTail.toString("utf8")}` : Buffer.concat([keptHead, keptTail]).toString("utf8");
      resolve({ exitCode, output, durationMs: Date.now() - started, timedOut, stopped, droppedBytes: dropped });
    };

    child.on("error", (err) => {
      onData(Buffer.from(`Gagal menjalankan shell (${file}): ${err.message}`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
