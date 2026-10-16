import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CheckpointListResponse,
  DirListResponse,
  EndpointDto,
  HarnessListResponse,
  HarnessPreviewResponse,
  HarnessProfile,
  MemoryDto,
  MemoryListResponse,
  ModelDto,
  ModelListResponse,
  RestoreResponse,
  RunEvent,
  SendMessageResponse,
  ThreadDetailDto,
} from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { makePng } from "./testing/mockImages.js";
import { startMockProvider, type MockProvider } from "./testing/mockProvider.js";

let mock: MockProvider;
let ctx: TestContext;
let ws: string;

beforeAll(async () => {
  mock = await startMockProvider();
});
afterAll(() => mock.close());
beforeEach(() => {
  ctx = createTestContext();
  mock.requests.length = 0;
  ws = join(ctx.tmp, "ws");
  mkdirSync(join(ws, "src", "deep"), { recursive: true });
  writeFileSync(join(ws, "hello.txt"), "halo dari file");
  writeFileSync(join(ws, "a.txt"), "foo\nbaris dua\n");
  writeFileSync(join(ws, "src", "deep", "x.txt"), "x");
  writeFileSync(join(ws, "src", "y.ts"), "y");
});
afterEach(async () => {
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

async function setup(modelId: string, threadBody: Record<string, unknown> = {}, opts: { vision?: boolean } = {}) {
  const endpoint = await ctx.json<EndpointDto>(
    "/api/endpoints",
    post({ name: "Mock", presetId: "custom", protocol: "openai-chat", baseUrl: `${mock.url}/v1`, auth: { type: "bearer" }, apiKey: "sk-test-agent-0001" }),
  );
  await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId }));
  let model = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.endpointId === endpoint.id && m.modelId === modelId) as ModelDto;
  model = await ctx.json<ModelDto>(`/api/models/${model.id}`, patch({ override: { tools: true, ...(opts.vision ? { inputModalities: ["text", "image"] } : {}) } }));
  const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "agent", workspace: ws, modelId: model.id, ...threadBody }));
  // Full auto still asks for risky actions; the tests below avoid them.
  await ctx.json(`/api/threads/${thread.id}`, patch({ approvalMode: "full", confirmFull: true }));
  return { endpoint, model, thread };
}

async function run(threadId: string, modelId: string, text = "kerjakan") {
  const res = await ctx.json<SendMessageResponse>(`/api/threads/${threadId}/messages`, post({ text, modelId }));
  const events = await collectRun(ctx, res.runId);
  const thread = await ctx.json<ThreadDetailDto>(`/api/threads/${threadId}`);
  const last = [...thread.messages].reverse().find((m) => m.role === "assistant")!;
  return { res, events, thread, finalText: last.parts.map((p) => (p.type === "text" ? p.text : "")).join("") };
}

const toolOutputs = (events: RunEvent[]) => events.flatMap((e) => (e.type === "tool_result" ? [e] : []));

/* ------------------------------------------------------------------ folders */

describe("folder picker", () => {
  it("lists folders only, says where up is, and creates a folder", async () => {
    const list = await ctx.json<DirListResponse>(`/api/fs/dirs?path=${encodeURIComponent(ws)}`);
    expect(list.entries.map((e) => e.name)).toEqual(["src"]);
    expect(list.parent).toBe(ctx.tmp.replace(/[\\/]$/, ""));
    expect(list.roots.length).toBeGreaterThan(0);

    const made = await ctx.json<{ path: string }>("/api/fs/mkdir", post({ parent: ws, name: "proyek-baru" }));
    expect(existsSync(made.path)).toBe(true);
    expect((await ctx.req("/api/fs/mkdir", post({ parent: ws, name: "proyek-baru" }))).status).toBe(409);
    expect((await ctx.req("/api/fs/mkdir", post({ parent: ws, name: "..\\keluar" }))).status).toBe(400);
  });

  it("without a path lists the drives, and refuses relative or missing paths", async () => {
    const roots = await ctx.json<DirListResponse>("/api/fs/dirs");
    expect(roots.path).toBeNull();
    expect(roots.entries.length).toBeGreaterThan(0);
    expect((await ctx.req("/api/fs/dirs?path=relatif")).status).toBe(400);
    expect((await ctx.req(`/api/fs/dirs?path=${encodeURIComponent(join(ws, "tidak-ada"))}`)).status).toBe(404);
  });

  it("an existing agent thread can move to another folder", async () => {
    const { thread } = await setup("agent-read");
    const other = join(ctx.tmp, "lain");
    mkdirSync(other);
    const after = await ctx.json<ThreadDetailDto>(`/api/threads/${thread.id}`, patch({ workspace: other }));
    expect(after.workspace?.toLowerCase()).toBe(other.toLowerCase());
  });
});

/* ------------------------------------------------------------------ wrappers */

describe("segmented wrappers", () => {
  it("built-in wrappers come in segments, with the changing facts marked dynamic", async () => {
    const { profiles } = await ctx.json<HarnessListResponse>("/api/harness");
    const ids = profiles.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["ezclaw-agent", "cowork-style", "codex-ref", "ezclaw-chat", "chat-claude-style", "chat-chatgpt-style"]));
    const agent = profiles.find((p) => p.id === "ezclaw-agent")!;
    expect(agent.segments.length).toBeGreaterThan(5);
    expect(agent.segments.find((s) => s.dynamic)?.id).toBe("environment");
    expect(profiles.find((p) => p.id === "cowork-style")!.wrap).toBe("tags");
    expect(profiles.find((p) => p.id === "cowork-style")!.origin).toContain("bukan salinan");
  });

  it("preview puts the stable part first and the date last", async () => {
    const preview = await ctx.json<HarnessPreviewResponse>("/api/harness/cowork-style/preview");
    expect(preview.text.startsWith("<identity>")).toBe(true);
    expect(preview.text.trimEnd().endsWith("</environment>")).toBe(true);
    expect(preview.stableChars).toBeLessThan(preview.text.length);
    expect(preview.text.slice(0, preview.stableChars)).not.toContain("Date:");
    expect(preview.approxTokens).toBeGreaterThan(100);
  });

  it("imports Antigravity-style tags as one segment per tag, editable and switchable", async () => {
    const text = "Catatan pembuka\n\n<identity>\nYou are X.\n</identity>\n\n<communication_style>\n- Be brief.\n</communication_style>";
    const p = await ctx.json<HarnessProfile>("/api/harness/import", post({ name: "Impor", mode: "agent", text }));
    expect(p.wrap).toBe("tags");
    expect(p.segments.map((s) => s.title)).toEqual(["pembuka", "identity", "communication_style"]);
    expect(p.segments[2]!.purpose).toContain("menulis");

    const segments = p.segments.map((s) => (s.title === "pembuka" ? { ...s, enabled: false } : s));
    await ctx.json(`/api/harness/${p.id}`, patch({ segments }));
    const preview = await ctx.json<HarnessPreviewResponse>(`/api/harness/${p.id}/preview`);
    expect(preview.text).not.toContain("Catatan pembuka");
    expect(preview.text).toContain("<identity>\nYou are X.\n</identity>");
  });

  it("imports Markdown per top-level heading and keeps the headings in the text", async () => {
    const p = await ctx.json<HarnessProfile>("/api/harness/import", post({ name: "MD", mode: "chat", text: "Intro.\n\n# Personality\nKind.\n\n# Rules\n- one\n```\n# not a heading\n```" }));
    expect(p.wrap).toBe("plain");
    expect(p.segments.map((s) => s.title)).toEqual(["Pembuka", "Personality", "Rules"]);
    expect(p.segments[2]!.content).toContain("# not a heading");
  });

  it("reads Codex's wrapper per heading from models.json, and a copy becomes editable segments", async () => {
    const codex = join(ctx.tmp, "codex");
    mkdirSync(codex);
    writeFileSync(join(codex, "models.json"), JSON.stringify({ models: [{ slug: "gpt-x", base_instructions: "You are Codex.\n\n# Personality\nCalm.\n\n# Rules for getting work done\nTest it." }] }));
    writeFileSync(join(codex, "auth.json"), '{"secret":"jangan"}');
    await ctx.json("/api/settings", put({ codexDir: codex }));
    const codexProfile = (await ctx.json<HarnessListResponse>("/api/harness")).profiles.find((p) => p.id === "codex-ref")!;
    expect(codexProfile.segments.map((s) => s.title)).toEqual(["Pembuka", "Personality", "Rules for getting work done", "permissions instructions", "environment_context"]);

    const copy = await ctx.json<HarnessProfile>("/api/harness/codex-ref/duplicate", post({}));
    expect(copy.fromCodex).toBe(false);
    expect(copy.origin).toContain("Disalin dari Codex");
    const preview = await ctx.json<HarnessPreviewResponse>(`/api/harness/${copy.id}/preview`);
    expect(preview.text).toContain("# Rules for getting work done\nTest it.");
    expect(preview.text).not.toContain("jangan");
  });

  it("rejects duplicate segment ids and refuses to edit a built-in", async () => {
    const p = await ctx.json<HarnessProfile>("/api/harness/ezclaw-agent/duplicate", post({}));
    const dup = [...p.segments, p.segments[0]!];
    expect((await ctx.req(`/api/harness/${p.id}`, patch({ segments: dup }))).status).toBe(400);
    expect((await ctx.req("/api/harness/ezclaw-agent", patch({ name: "x" }))).status).toBe(400);
  });
});

/* ------------------------------------------------------------------ memory */

describe("memory", () => {
  it("a proposal waits for approval; only approved memories reach the prompt", async () => {
    const { model, thread } = await setup("agent-memory");
    const { events } = await run(thread.id, model.id);
    const proposed = events.find((e) => e.type === "memory_proposed") as Extract<RunEvent, { type: "memory_proposed" }>;
    expect(proposed).toMatchObject({ text: "Proyek ini memakai pnpm, bukan npm.", scope: "workspace" });

    let list = await ctx.json<MemoryListResponse>("/api/memories");
    expect(list.memories[0]).toMatchObject({ status: "proposed", source: "agent", threadId: thread.id });

    const systemOf = () => String((mock.requests[0]!.body!.messages as { role: string; content: string }[])[0]!.content);
    mock.requests.length = 0;
    await run(thread.id, model.id, "lagi");
    expect(systemOf()).not.toContain("memakai pnpm");

    await ctx.json(`/api/memories/${proposed.memoryId}`, patch({ status: "active" }));
    mock.requests.length = 0;
    await run(thread.id, model.id, "sekali lagi");
    expect(systemOf()).toContain("memakai pnpm");

    list = await ctx.json<MemoryListResponse>("/api/memories");
    expect(list.memories.filter((m) => m.status === "active")).toHaveLength(1);
  });

  it("workspace memories stay in their folder; global ones also reach chat", async () => {
    const g = await ctx.json<MemoryDto>("/api/memories", post({ text: "Panggil aku Ran.", scope: "global" }));
    await ctx.json<MemoryDto>("/api/memories", post({ text: "Folder lain saja.", scope: "workspace", workspace: join(ctx.tmp, "lain") }));
    expect(g).toMatchObject({ status: "active", source: "user" });

    const { model, thread } = await setup("agent-read");
    await run(thread.id, model.id);
    const sent = JSON.stringify(mock.requests[0]!.body);
    expect(sent).toContain("Panggil aku Ran.");
    expect(sent).not.toContain("Folder lain saja.");

    const chat = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: model.id, harness: { on: true, profileId: "ezclaw-chat", tools: [] } }));
    mock.requests.length = 0;
    await collectRun(ctx, (await ctx.json<SendMessageResponse>(`/api/threads/${chat.id}/messages`, post({ text: "hai", modelId: model.id }))).runId);
    expect(JSON.stringify(mock.requests[0]!.body)).toContain("Panggil aku Ran.");

    await ctx.req(`/api/memories/${g.id}`, { method: "DELETE" });
    expect((await ctx.json<MemoryListResponse>("/api/memories")).memories).toHaveLength(1);
  });

  it("refuses a proposal that looks like a credential", async () => {
    const res = await ctx.req("/api/memories", post({ text: "", scope: "global" }));
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ undo */

describe("undo a run", () => {
  it("records files before the first change and puts them back; created files are removed", async () => {
    const { model, thread } = await setup("agent-two-files");
    const { res, events } = await run(thread.id, model.id);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toContain("bar");
    expect(existsSync(join(ws, "baru.txt"))).toBe(true);
    expect(events.some((e) => e.type === "checkpoint")).toBe(true);

    const { checkpoints } = await ctx.json<CheckpointListResponse>(`/api/threads/${thread.id}/checkpoints`);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.runMessageId).toBe(res.userMessageId);
    expect(checkpoints[0]!.prompt).toBe("kerjakan");
    expect(checkpoints[0]!.files.map((f) => [f.path.endsWith("baru.txt") ? "baru" : "a", f.created]).sort()).toEqual([
      ["a", false],
      ["baru", true],
    ]);

    const restored = await ctx.json<RestoreResponse>(`/api/threads/${thread.id}/checkpoints/${res.userMessageId}/restore`, post({}));
    expect(restored.restored).toHaveLength(2);
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("foo\nbaris dua\n");
    expect(existsSync(join(ws, "baru.txt"))).toBe(false);

    // A second restore finds nothing left to put back.
    expect((await ctx.req(`/api/threads/${thread.id}/checkpoints/${res.userMessageId}/restore`, post({}))).status).toBe(404);
  });
});

/* ------------------------------------------------------------------ tools */

describe("new tools", () => {
  it("glob finds files by pattern", async () => {
    const { model, thread } = await setup("agent-glob");
    const { finalText } = await run(thread.id, model.id);
    expect(finalText).toContain("src/deep/x.txt");
    expect(finalText).toContain("hello.txt");
    expect(finalText).not.toContain("y.ts");
  });

  it("web_fetch returns the page as text, following a redirect", async () => {
    const { model, thread } = await setup("agent-fetch");
    const { finalText } = await run(thread.id, model.id, `${mock.url}/redirect`);
    expect(finalText).toContain("# Dokumen Uji");
    expect(finalText).toContain("Panduan & Contoh");
    expect(finalText).toContain("- satu");
    expect(finalText).not.toContain("alert(1)");
    expect(finalText).not.toContain("menu");
  });

  it("web_search says how to set it up when no service is configured", async () => {
    const { model, thread } = await setup("agent-search");
    const { events } = await run(thread.id, model.id);
    expect(toolOutputs(events)[0]).toMatchObject({ ok: false });
    expect(toolOutputs(events)[0]!.output).toContain("Pencarian web belum diatur");
  });

  it("view_image shows the picture to a model that has vision, and refuses one that does not", async () => {
    writeFileSync(join(ws, "pic.png"), makePng(4));
    const blind = await setup("agent-image");
    const r1 = await run(blind.thread.id, blind.model.id);
    expect(toolOutputs(r1.events)[0]!.output).toContain("tidak menerima input gambar");

    const seeing = await setup("agent-image", {}, { vision: true });
    mock.requests.length = 0;
    const r2 = await run(seeing.thread.id, seeing.model.id);
    expect(r2.finalText).toContain("Gambar di request: 1");
    const second = mock.requests.filter((q) => q.path === "/v1/chat/completions").at(-1)!;
    const msgs = second.body!.messages as { role: string; content: unknown }[];
    expect(msgs.at(-1)!.role).toBe("user");
    expect(JSON.stringify(msgs.at(-1)!.content)).toContain("data:image/png;base64,");
  });

  it("start_process, read_process and stop_process manage a long-running command", async () => {
    const { model, thread } = await setup("agent-process");
    const { events, finalText } = await run(thread.id, model.id);
    const outs = toolOutputs(events).map((e) => e.output);
    expect(outs[0]).toContain("siap");
    expect(outs[1]).toMatch(/p1 berjalan/);
    expect(outs[2]).toContain("dihentikan");
    expect(finalText).toContain("Proses selesai");
  }, 30_000);

  it("spawn_agent runs a read-only helper and returns its report", async () => {
    const { model, thread } = await setup("agent-subagent");
    const { finalText, events } = await run(thread.id, model.id);
    expect(finalText).toContain("Induk menerima: Laporan subagent:");
    expect(finalText).toContain("halo dari file");
    expect(events.some((e) => e.type === "note" && e.text.startsWith("Subagent: read_file"))).toBe(true);
    // The helper's own conversation never lands in the thread.
    const thread2 = await ctx.json<ThreadDetailDto>(`/api/threads/${thread.id}`);
    expect(thread2.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
  });

  it("read_skill lists skills in the prompt and returns the one asked for", async () => {
    const skill = join(ws, ".ezclaw", "skills", "catatan-rilis");
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), "---\nname: catatan-rilis\ndescription: Menulis catatan rilis.\n---\n\nLangkah: kumpulkan commit.");
    writeFileSync(join(skill, "template.md"), "x");
    const { model, thread } = await setup("agent-skill");
    const { finalText } = await run(thread.id, model.id);
    expect(JSON.stringify(mock.requests[0]!.body)).toContain("catatan-rilis: Menulis catatan rilis.");
    expect(finalText).toContain("Langkah: kumpulkan commit.");
  });
});

/* ------------------------------------------------------------------ request layout */

describe("Codex layout and message tags", () => {
  it("Codex (hardcode) sends base text as system, permissions as developer, AGENTS.md and environment_context before the user's message", async () => {
    writeFileSync(join(ws, "AGENTS.md"), "Selalu pakai pnpm.");
    const { model, thread } = await setup("agent-read", { harness: { on: true, profileId: "codex-hardcode", tools: [] } });
    await run(thread.id, model.id, "baca file");
    const body = mock.requests.find((r) => r.path === "/v1/chat/completions" && r.body?.tools)!.body!;
    const msgs = body.messages as { role: string; content: string }[];
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content.startsWith("You are Codex, an agent based on GPT-5.")).toBe(true);
    expect(msgs[1]!.role).toBe("system"); // the developer message, sent with this model's system role
    expect(msgs[1]!.content).toContain("<permissions instructions>");
    // setup() puts the thread in full auto, which Codex calls approval policy "never".
    expect(msgs[1]!.content).toContain("Approval policy is currently never.");
    const ctxMsg = msgs[2]!;
    expect(ctxMsg.role).toBe("user");
    expect(ctxMsg.content).toContain(`# AGENTS.md instructions for ${ws}`);
    expect(ctxMsg.content).toContain("<INSTRUCTIONS>\nSelalu pakai pnpm.\n</INSTRUCTIONS>");
    expect(ctxMsg.content).toContain(`<cwd>${ws}</cwd>`);
    expect(ctxMsg.content).toMatch(/<current_date>\d{4}-\d{2}-\d{2}<\/current_date>/);
    expect(msgs[3]).toMatchObject({ role: "user", content: "baca file" });

    const tools = body.tools as { function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }[];
    const exec = tools.find((t) => t.function.name === "exec_command")!.function;
    expect(exec.description.startsWith("Runs a command in a PTY")).toBe(true);
    expect(Object.keys(exec.parameters.properties)).toEqual(expect.arrayContaining(["cmd", "workdir", "yield_time_ms", "max_output_tokens", "sandbox_permissions"]));
    expect(tools.find((t) => t.function.name === "update_plan")!.function.description.startsWith("Updates the task plan.")).toBe(true);
  });

  it("exec_command answers in Codex's output format", async () => {
    const { model, thread } = await setup("agent-codex", { harness: { on: true, profileId: "codex-hardcode", tools: [] } });
    const { events } = await run(thread.id, model.id);
    const out = toolOutputs(events)[0]!.output;
    expect(out).toMatch(/^Chunk ID: [0-9a-f]+\nWall time: \d+\.\d{4} seconds\nProcess exited with code 0\nOriginal token count: \d+\nOutput:\n/);
    expect(out).toContain("dari-codex-ref");
  });

  it("a userTag wraps the owner's messages, and context segments land just before the latest one", async () => {
    const base = await ctx.json<HarnessProfile>("/api/harness/ezclaw-agent/duplicate", post({}));
    const segments = [...base.segments, { id: "konteks", title: "konteks", purpose: "", enabled: true, content: "<ctx>{{workspace}}</ctx>", dynamic: true, placement: "context" }];
    await ctx.json(`/api/harness/${base.id}`, patch({ userTag: "USER_REQUEST", segments }));
    const { model, thread } = await setup("agent-read", { harness: { on: true, profileId: base.id, tools: [] } });
    await run(thread.id, model.id, "pertama");
    mock.requests.length = 0;
    await run(thread.id, model.id, "kedua");
    const msgs = mock.requests[0]!.body!.messages as { role: string; content: string }[];
    const users = msgs.filter((m) => m.role === "user").map((m) => m.content);
    expect(users).toEqual(["<USER_REQUEST>\npertama\n</USER_REQUEST>", `<ctx>${ws}</ctx>`, "<USER_REQUEST>\nkedua\n</USER_REQUEST>"]);

    const preview = await ctx.json<HarnessPreviewResponse>(`/api/harness/${base.id}/preview`);
    expect(preview.userMessage).toBe("<USER_REQUEST>\n…\n</USER_REQUEST>");
    expect(preview.context).toContain("<ctx>");
    expect(preview.text).not.toContain("<ctx>");
    expect(preview.tools.map((t) => t.name)).toContain("read_file");
  });
});
