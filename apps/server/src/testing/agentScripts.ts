/**
 * Scripted agent behaviour for the mock provider. The model name picks a script, and the number
 * of assistant turns since the last real user message picks the step, so a script can call a
 * tool first and answer once the result is back, on any of the three wire formats.
 */

export type Action = { tool: string; args: unknown; /** Send these bytes as the arguments instead of JSON.stringify(args). */ rawArgs?: string } | { text: string };

export interface ScriptContext {
  step: number;
  /** The last tool result the model has seen in this run, if any. */
  lastResult: string | null;
  /** The last real user message. */
  userText: string;
  /** The system prompt as sent. */
  system: string;
  /** Images anywhere in the request. */
  images: number;
}

type Script = (ctx: ScriptContext) => Action[];

const done = (text: string): Action[] => [{ text }];

export const SCRIPTS: Record<string, Script> = {
  "agent-read": ({ step, lastResult }) => (step === 0 ? [{ tool: "read_file", args: { path: "hello.txt" } }] : done(`Isi file: ${lastResult ?? "?"}`)),
  "agent-edit": ({ step }) => (step === 0 ? [{ tool: "edit_file", args: { path: "a.txt", old_string: "foo", new_string: "bar" } }] : done("Perubahan selesai.")),
  "agent-write": ({ step }) => (step === 0 ? [{ tool: "write_file", args: { path: "baru/catatan.txt", content: "halo dunia\n" } }] : done("File dibuat.")),
  "agent-write-outside": ({ step }) => (step === 0 ? [{ tool: "write_file", args: { path: "../keluar.txt", content: "bocor" } }] : done("Selesai.")),
  "agent-shell": ({ step }) => (step === 0 ? [{ tool: "shell", args: { command: "echo halo-dari-shell" } }] : done("Perintah dijalankan.")),
  // Long command and an output with no spaces: checks that the timeline wraps instead of scrolling sideways.
  "agent-longline": ({ step }) =>
    step === 0
      ? [{ tool: "shell", args: { command: 'Write-Output ("_x000D__x000A_</S><S_S=Error>" * 30); Write-Output "G:/VeinoLN/[00] Queued/New Priority/[To First Prioritized - Oct]/[1ST Priority]/Classmate o Produce Shite/1/Produce Shite 1 EN/Illustrations/very-long-file-name-without-any-spaces-at-all.png"' } }]
      : done("Selesai. " + "panjang_tanpa_spasi_".repeat(20)),
  "agent-shell-chain": ({ step }) => (step === 0 ? [{ tool: "shell", args: { command: "echo satu; echo dua" } }] : done("Selesai.")),
  "agent-danger": ({ step }) => (step === 0 ? [{ tool: "shell", args: { command: "Remove-Item -Recurse -Force ./sampah" } }] : done("Selesai.")),
  "agent-plan": ({ step }) =>
    step === 0
      ? [
          { tool: "update_plan", args: { plan: [{ step: "Baca", status: "in_progress" }, { step: "Ubah", status: "pending" }] } },
          { tool: "list_dir", args: { path: "." } },
        ]
      : done("Plan dibuat dan folder dilihat."),
  "agent-ask": ({ step, lastResult }) =>
    step === 0 ? [{ tool: "ask_user", args: { question: "Pakai database apa?", options: ["SQLite", "Postgres"] } }] : done(`Dipilih: ${lastResult ?? "?"}`),
  "agent-outside": ({ step, lastResult }) => (step === 0 ? [{ tool: "read_file", args: { path: "../di-luar.txt" } }] : done(`Hasil: ${lastResult?.slice(0, 60) ?? "?"}`)),
  "agent-bad-args": ({ step, lastResult }) =>
    step === 0 ? [{ tool: "read_file", args: {}, rawArgs: '{"path": "hello.txt"' }] : done(`Galat diterima: ${lastResult?.slice(0, 80) ?? "?"}`),
  "agent-unknown-tool": ({ step, lastResult }) => (step === 0 ? [{ tool: "fly_to_moon", args: {} }] : done(`Respons: ${lastResult?.slice(0, 60) ?? "?"}`)),
  "agent-loop": () => [{ tool: "list_dir", args: { path: ".", depth: 1 } }],
  "agent-patch": ({ step }) =>
    step === 0
      ? [{ tool: "apply_patch", args: { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-foo\n+bar\n*** Add File: b.txt\n+baru\n*** End Patch" } }]
      : done("Patch diterapkan."),
  "agent-glob": ({ step, lastResult }) => (step === 0 ? [{ tool: "glob", args: { pattern: "**/*.txt" } }] : done(`Hasil glob: ${lastResult ?? "?"}`)),
  "agent-fetch": ({ step, lastResult, userText }) => (step === 0 ? [{ tool: "web_fetch", args: { url: userText.trim() } }] : done(`Halaman: ${lastResult?.slice(0, 400) ?? "?"}`)),
  "agent-search": ({ step, lastResult }) => (step === 0 ? [{ tool: "web_search", args: { query: "ezclaw" } }] : done(`Cari: ${lastResult ?? "?"}`)),
  "agent-memory": ({ step }) => (step === 0 ? [{ tool: "propose_memory", args: { text: "Proyek ini memakai pnpm, bukan npm." } }] : done("Sudah diusulkan.")),
  "agent-image": ({ step, lastResult, images }) => (step === 0 ? [{ tool: "view_image", args: { path: "pic.png" } }] : done(`Gambar di request: ${images}. ${lastResult ?? ""}`)),
  "agent-skill": ({ step, lastResult }) => (step === 0 ? [{ tool: "read_skill", args: { name: "catatan-rilis" } }] : done(`Skill: ${lastResult?.slice(0, 200) ?? "?"}`)),
  "agent-two-files": ({ step }) =>
    step === 0
      ? [
          { tool: "write_file", args: { path: "baru.txt", content: "dibuat agent\n" } },
          { tool: "edit_file", args: { path: "a.txt", old_string: "foo", new_string: "bar" } },
        ]
      : done("Dua file diubah."),
  "agent-process": ({ step, lastResult }) => {
    const id = /Proses (p\d+)/.exec(lastResult ?? "")?.[1] ?? /^(p\d+)/.exec(lastResult ?? "")?.[1] ?? "p1";
    if (step === 0) return [{ tool: "start_process", args: { command: "node -e \"console.log('siap'); setInterval(() => console.log('detak'), 200)\"" } }];
    if (step === 1) return [{ tool: "read_process", args: { id, wait_ms: 800 } }];
    if (step === 2) return [{ tool: "stop_process", args: { id } }];
    return done(`Proses selesai: ${lastResult?.slice(0, 80) ?? "?"}`);
  },
  "agent-subagent": ({ step, lastResult, system }) => {
    if (system.includes("research helper")) return step === 0 ? [{ tool: "read_file", args: { path: "hello.txt" } }] : done(`Laporan: ${lastResult ?? "?"}`);
    return step === 0 ? [{ tool: "spawn_agent", args: { task: "Baca hello.txt dan laporkan isinya." } }] : done(`Induk menerima: ${lastResult ?? "?"}`);
  },
  "agent-codex": ({ step }) => (step === 0 ? [{ tool: "exec_command", args: { cmd: "echo dari-codex-ref", workdir: "." } }] : done("Selesai lewat exec_command.")),
};

export function isAgentModel(model: string): boolean {
  return model in SCRIPTS;
}

export function runScript(model: string, ctx: ScriptContext): Action[] {
  return (SCRIPTS[model] ?? (() => done("ok")))(ctx);
}

/* ---------------------------------------------------- reading the request */

type Json = Record<string, unknown>;
const rec = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((b) => (b.type === "text" || b.type === "input_text" || b.type === "output_text" ? String(b.text ?? "") : ""))
    .join("");
}

const TOOL_IMAGES = "Gambar yang dilampirkan tool";

function countImages(body: unknown): number {
  return (JSON.stringify(body).match(/data:image\//g) ?? []).length + (JSON.stringify(body).match(/"type":"base64"/g) ?? []).length;
}

export function contextFromChat(body: Json): ScriptContext {
  const messages = arr(body.messages);
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && !textOfContent(m.content).startsWith(TOOL_IMAGES)) lastUser = i;
  });
  const sys = messages.find((m) => m.role === "system" || m.role === "developer");
  const after = messages.slice(lastUser + 1);
  const results = after.filter((m) => m.role === "tool");
  return {
    step: after.filter((m) => m.role === "assistant").length,
    lastResult: results.length ? textOfContent(results.at(-1)!.content) : null,
    userText: lastUser >= 0 ? textOfContent(messages[lastUser]!.content) : "",
    system: sys ? textOfContent(sys.content) : "",
    images: countImages(body),
  };
}

export function contextFromResponses(body: Json): ScriptContext {
  const input = typeof body.input === "string" ? [{ role: "user", content: body.input } as Json] : arr(body.input);
  let lastUser = -1;
  input.forEach((m, i) => {
    if (m.role === "user" && !textOfContent(m.content).startsWith(TOOL_IMAGES)) lastUser = i;
  });
  const after = input.slice(lastUser + 1);
  const outputs = after.filter((m) => m.type === "function_call_output");
  return {
    step: countTurns(after),
    lastResult: outputs.length ? String(outputs.at(-1)!.output ?? "") : null,
    userText: lastUser >= 0 ? textOfContent(input[lastUser]!.content) : "",
    system: typeof body.instructions === "string" ? body.instructions : "",
    images: countImages(body),
  };
}

/** Responses has no assistant "turn" marker for tool-only turns, so a run of calls followed by outputs counts as one. */
function countTurns(items: Json[]): number {
  let turns = 0;
  let inCalls = false;
  for (const i of items) {
    if (i.type === "function_call") {
      if (!inCalls) turns++;
      inCalls = true;
    } else inCalls = false;
  }
  return turns;
}

export function contextFromAnthropic(body: Json): ScriptContext {
  const messages = arr(body.messages);
  const isReal = (m: Json) => m.role === "user" && arr(m.content).some((b) => b.type === "text");
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (isReal(m)) lastUser = i;
  });
  const after = messages.slice(lastUser + 1);
  const resultBlocks = after.filter((m) => m.role === "user").flatMap((m) => arr(m.content)).filter((b) => b.type === "tool_result");
  return {
    step: after.filter((m) => m.role === "assistant").length,
    lastResult: resultBlocks.length ? textOfContent(resultBlocks.at(-1)!.content) : null,
    userText: lastUser >= 0 ? textOfContent(messages[lastUser]!.content) : "",
    system: typeof body.system === "string" ? body.system : textOfContent(body.system),
    images: countImages(body),
  };
}
