import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EndpointDto, HarnessProfile, MessageDto, ModelDto, ModelListResponse, RequestLogResponse, RunEvent, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
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
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, "hello.txt"), "halo dari file");
  writeFileSync(join(ws, "a.txt"), "foo\nbaris dua\n");
});
afterEach(async () => {
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

type Wire = "openai-chat" | "openai-responses" | "anthropic";

const BASE: Record<Wire, string> = {
  "openai-chat": "/v1",
  "openai-responses": "/v1",
  anthropic: "/anthropic",
};

async function setup(modelId: string, wire: Wire = "openai-chat", threadBody: Record<string, unknown> = {}) {
  const endpoint = await ctx.json<EndpointDto>(
    "/api/endpoints",
    post({
      name: "Mock",
      presetId: "custom",
      protocol: wire,
      baseUrl: `${mock.url}${BASE[wire]}`,
      auth: wire === "anthropic" ? { type: "header", headerName: "x-api-key" } : { type: "bearer" },
      apiKey: "sk-test-agent-0001",
    }),
  );
  await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId }));
  const { models } = await ctx.json<ModelListResponse>("/api/models");
  const model = models.find((m) => m.endpointId === endpoint.id && m.modelId === modelId) as ModelDto;
  const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "agent", workspace: ws, modelId: model.id, ...threadBody }));
  return { endpoint, model, thread };
}

const send = (threadId: string, modelId: string, text = "kerjakan") => ctx.json<SendMessageResponse>(`/api/threads/${threadId}/messages`, post({ text, modelId }));
const getThread = (id: string) => ctx.json<ThreadDetailDto>(`/api/threads/${id}`);
const setMode = (id: string, approvalMode: "ask" | "edit" | "full") => ctx.json<ThreadDetailDto>(`/api/threads/${id}`, patch({ approvalMode, confirmFull: approvalMode === "full" }));

async function waitFor(runId: string, predicate: (e: RunEvent) => boolean, timeoutMs = 5000): Promise<RunEvent> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const found = ctx.services.runs.snapshot(runId, 0)?.events.find(predicate);
    if (found) return found;
    if (Date.now() > until) throw new Error(`timeout waiting for event; saw ${JSON.stringify(ctx.services.runs.snapshot(runId, 0)?.events.map((e) => e.type))}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const textOf = (m: MessageDto) => m.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join("");
const types = (events: RunEvent[]) => events.map((e) => e.type);
const approve = (runId: string, approvalId: string, decision: "allow" | "allow_always" | "deny", reason?: string) =>
  ctx.req(`/api/runs/${runId}/approvals/${approvalId}`, post({ decision, ...(reason ? { reason } : {}) }));

describe.each<Wire>(["openai-chat", "openai-responses", "anthropic"])("agent loop over %s", (wire) => {
  it("reads a file on its own, feeds the result back, and answers", async () => {
    const { model, thread } = await setup("agent-read", wire);
    const sent = await send(thread.id, model.id, "baca hello.txt");
    expect(sent.assistantMessageId).toBeNull();
    const events = await collectRun(ctx, sent.runId);

    expect(types(events)).toEqual(expect.arrayContaining(["start", "step_start", "step_end", "tool_call", "tool_start", "tool_result", "done"]));
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result).toMatchObject({ name: "read_file", ok: true });
    expect(result.output).toContain("halo dari file");
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
    expect(events.filter((e) => e.type === "step_start")).toHaveLength(2);

    const saved = await getThread(thread.id);
    expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(saved.messages[1]?.parts.some((p) => p.type === "tool_call" && p.name === "read_file")).toBe(true);
    expect(saved.messages[2]?.parts[0]).toMatchObject({ type: "tool_result", name: "read_file" });
    expect(textOf(saved.messages[3]!)).toContain("Isi file:");
    expect(textOf(saved.messages[3]!)).toContain("halo dari file");
  });

  it("sends the tools, system prompt, and the previous step's own turn on the second request", async () => {
    const { model, thread } = await setup("agent-read", wire);
    await collectRun(ctx, (await send(thread.id, model.id, "baca")).runId);
    const calls = mock.requests.filter((r) => /\/(chat\/completions|responses|messages)$/.test(r.path) && r.body?.tools);
    expect(calls).toHaveLength(2);
    const first = calls[0]!.body!;
    const toolNames = (first.tools as { name?: string; function?: { name: string } }[]).map((t) => t.name ?? t.function?.name);
    expect(toolNames).toEqual(["list_dir", "read_file", "search", "edit_file", "write_file", "shell", "update_plan", "ask_user"]);
    const system = wire === "anthropic" ? first.system : wire === "openai-responses" ? first.instructions : (first.messages as { role: string; content: string }[])[0]?.content;
    expect(String(system)).toContain("You are EZClaw Agent");
    expect(String(system)).toContain(ws);

    // The provider's own turn (reasoning included) is replayed unchanged.
    const second = JSON.stringify(calls[1]!.body);
    if (wire === "openai-responses") expect(second).toContain('"rs_1"');
    if (wire === "anthropic") expect(second).toContain("sig-agent");
    if (wire === "openai-chat") {
      expect(second).toContain("tool_call_id");
      expect(second).not.toContain("reasoning_content"); // this endpoint's rules say the model does not want it back
    }
  });

  it("asks before editing, applies the edit once allowed, and tells the model when it is refused", async () => {
    const { model, thread } = await setup("agent-edit", wire);
    const run1 = await send(thread.id, model.id, "ubah foo jadi bar");
    const request = (await waitFor(run1.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(request.request).toMatchObject({ kind: "edit", path: "a.txt" });
    expect(request.request.diff).toContain("-foo");
    expect(request.request.diff).toContain("+bar");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("foo\nbaris dua\n");

    expect((await approve(run1.runId, request.approvalId, "allow")).status).toBe(204);
    const events1 = await collectRun(ctx, run1.runId);
    expect(events1.at(-1)).toMatchObject({ type: "done", status: "complete" });
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("bar\nbaris dua\n");

    // Refused: the file stays, the model is told why, and the run still finishes.
    writeFileSync(join(ws, "a.txt"), "foo\nbaris dua\n");
    const run2 = await send(thread.id, model.id, "coba lagi");
    const request2 = (await waitFor(run2.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    await approve(run2.runId, request2.approvalId, "deny", "jangan sekarang");
    const events2 = await collectRun(ctx, run2.runId);
    const denied = events2.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(denied).toMatchObject({ ok: false, denied: true });
    expect(denied.output).toContain("jangan sekarang");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("foo\nbaris dua\n");
    expect(events2.at(-1)).toMatchObject({ type: "done", status: "complete" });
  });
});

describe("permissions", () => {
  it("edit mode changes files inside the workspace without asking, but never asks less for commands", async () => {
    const { model, thread } = await setup("agent-edit");
    await setMode(thread.id, "edit");
    const events = await collectRun(ctx, (await send(thread.id, model.id)).runId);
    expect(types(events)).not.toContain("approval");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("bar\nbaris dua\n");

    const shell = await setup("agent-shell");
    await setMode(shell.thread.id, "edit");
    const run = await send(shell.thread.id, shell.model.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(approval.request).toMatchObject({ kind: "shell", command: "echo halo-dari-shell" });
    await approve(run.runId, approval.approvalId, "deny");
    await collectRun(ctx, run.runId);
  });

  it("runs a command once allowed and reports its output and exit code", async () => {
    const { model, thread } = await setup("agent-shell");
    const run = await send(thread.id, model.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    await approve(run.runId, approval.approvalId, "allow");
    const events = await collectRun(ctx, run.runId);
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.ok).toBe(true);
    expect(result.output).toContain("exited with code 0");
    expect(result.output).toContain("halo-dari-shell");
  });

  it("remembers 'allow always' as a command prefix, and never lets it cover chained commands", async () => {
    const first = await setup("agent-shell");
    const run1 = await send(first.thread.id, first.model.id);
    const a1 = (await waitFor(run1.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(a1.request.rulePattern).toEqual(["echo", "halo-dari-shell"]);
    await approve(run1.runId, a1.approvalId, "allow_always");
    await collectRun(ctx, run1.runId);
    expect(await ctx.json(`/api/threads/${first.thread.id}/rules`)).toEqual({ rules: [{ id: expect.any(String), pattern: ["echo", "halo-dari-shell"] }] });

    // Same command again: no question.
    const run2 = await send(first.thread.id, first.model.id);
    const events2 = await collectRun(ctx, run2.runId);
    expect(types(events2)).not.toContain("approval");
    expect(events2.find((e) => e.type === "tool_result")).toMatchObject({ ok: true });

    // A chained command that starts with an allowed prefix still has to ask.
    const chain = await setup("agent-shell-chain");
    ctx.services.rules.add(chain.thread.workspace!, ["echo"]);
    const run3 = await send(chain.thread.id, chain.model.id);
    const a3 = (await waitFor(run3.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(a3.request.rulePattern).toBeUndefined();
    await approve(run3.runId, a3.approvalId, "deny");
    await collectRun(ctx, run3.runId);
  });

  it("full mode needs explicit confirmation, runs ordinary commands without asking, and still stops for risky ones", async () => {
    const { model, thread } = await setup("agent-shell");
    const unconfirmed = await ctx.req(`/api/threads/${thread.id}`, patch({ approvalMode: "full" }));
    expect(unconfirmed.status).toBe(400);
    await setMode(thread.id, "full");
    const events = await collectRun(ctx, (await send(thread.id, model.id)).runId);
    expect(types(events)).not.toContain("approval");

    const risky = await setup("agent-danger");
    await setMode(risky.thread.id, "full");
    mkdirSync(join(ws, "sampah"), { recursive: true });
    const run = await send(risky.thread.id, risky.model.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(approval.request.reason).toContain("berisiko");
    await approve(run.runId, approval.approvalId, "deny");
    await collectRun(ctx, run.runId);
    expect(existsSync(join(ws, "sampah"))).toBe(true);
  });

  it("asks before reading outside the workspace, and a refusal keeps the file private", async () => {
    writeFileSync(join(ctx.tmp, "di-luar.txt"), "rahasia");
    const { model, thread } = await setup("agent-outside");
    const run = await send(thread.id, model.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(approval.request.kind).toBe("outside");
    await approve(run.runId, approval.approvalId, "deny");
    const events = await collectRun(ctx, run.runId);
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.output).not.toContain("rahasia");
  });

  it("writes inside the workspace on its own in full mode, but always asks to write outside it", async () => {
    const inside = await setup("agent-write");
    await setMode(inside.thread.id, "full");
    const events = await collectRun(ctx, (await send(inside.thread.id, inside.model.id)).runId);
    expect(types(events)).not.toContain("approval");
    expect(readFileSync(join(ws, "baru/catatan.txt"), "utf8")).toBe("halo dunia\n");

    const outside = await setup("agent-write-outside");
    await setMode(outside.thread.id, "full");
    const run = await send(outside.thread.id, outside.model.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(approval.request).toMatchObject({ kind: "outside", reason: expect.stringContaining("luar workspace") });
    await approve(run.runId, approval.approvalId, "deny");
    await collectRun(ctx, run.runId);
    expect(existsSync(join(ctx.tmp, "keluar.txt"))).toBe(false);
  });

  it("stopping while waiting for permission ends the run and still records a result for the pending call", async () => {
    const { model, thread } = await setup("agent-edit");
    const run = await send(thread.id, model.id);
    await waitFor(run.runId, (e) => e.type === "approval");
    expect((await ctx.req(`/api/runs/${run.runId}/stop`, { method: "POST" })).status).toBe(202);
    const events = await collectRun(ctx, run.runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "stopped" });
    const saved = await getThread(thread.id);
    expect(saved.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(saved.messages[2]?.parts[0]).toMatchObject({ type: "tool_result", isError: true });
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("foo\nbaris dua\n");

    // The next message works: the dangling call was repaired when the history was rebuilt.
    const next = await send(thread.id, model.id, "lanjut");
    await waitFor(next.runId, (e) => e.type === "approval");
    await ctx.req(`/api/runs/${next.runId}/stop`, { method: "POST" });
    expect((await collectRun(ctx, next.runId)).at(-1)).toMatchObject({ type: "done", status: "stopped" });
    // The first call kept an explicit result, so the transcript stays valid for a strict provider.
    const requests = mock.requests.filter((r) => r.path.endsWith("/chat/completions") && r.body?.tools);
    const repaired = (requests.at(-1)!.body!.messages as { role: string; content?: string }[]).find((m) => m.role === "tool");
    expect(repaired?.content).toContain("Dihentikan");
  });
});

describe("tools", () => {
  it("runs independent read-only calls together and keeps the plan", async () => {
    const { model, thread } = await setup("agent-plan");
    const events = await collectRun(ctx, (await send(thread.id, model.id)).runId);
    expect(events.filter((e) => e.type === "tool_result")).toHaveLength(2);
    expect(events.find((e) => e.type === "plan")).toMatchObject({ items: [{ text: "Baca", status: "in_progress" }, { text: "Ubah", status: "pending" }] });
    expect((await getThread(thread.id)).plan).toHaveLength(2);
  });

  it("pauses on ask_user until the owner answers, then continues with the answer", async () => {
    const { model, thread } = await setup("agent-ask");
    const run = await send(thread.id, model.id);
    const ask = (await waitFor(run.runId, (e) => e.type === "ask")) as Extract<RunEvent, { type: "ask" }>;
    expect(ask).toMatchObject({ question: "Pakai database apa?", options: ["SQLite", "Postgres"] });
    expect((await ctx.req(`/api/runs/${run.runId}/asks/${ask.askId}`, post({ answer: "SQLite" }))).status).toBe(204);
    const events = await collectRun(ctx, run.runId);
    expect(events.at(-1)).toMatchObject({ status: "complete" });
    expect(textOf((await getThread(thread.id)).messages.at(-1)!)).toContain("Dipilih: Jawaban pengguna: SQLite");
    expect((await ctx.req(`/api/runs/${run.runId}/asks/${ask.askId}`, post({ answer: "x" }))).status).toBe(404);
  });

  it("reports malformed arguments and unknown tools back to the model instead of failing the run", async () => {
    const bad = await setup("agent-bad-args");
    const e1 = await collectRun(ctx, (await send(bad.thread.id, bad.model.id)).runId);
    const r1 = e1.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(r1).toMatchObject({ ok: false });
    expect(r1.output).toContain("bukan JSON");
    expect(e1.at(-1)).toMatchObject({ status: "complete" });

    const unknown = await setup("agent-unknown-tool");
    const e2 = await collectRun(ctx, (await send(unknown.thread.id, unknown.model.id)).runId);
    const r2 = e2.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(r2.output).toContain('"fly_to_moon" tidak tersedia');
    expect(r2.output).toContain("read_file");
  });

  it("stops after the step limit instead of looping forever", async () => {
    const copy = await ctx.json<HarnessProfile>("/api/harness/ezclaw-agent/duplicate", { method: "POST" });
    await ctx.json(`/api/harness/${copy.id}`, patch({ loop: { maxSteps: 3 } }));
    const { model, thread } = await setup("agent-loop", "openai-chat", { harness: { on: true, profileId: copy.id, tools: [] } });
    const events = await collectRun(ctx, (await send(thread.id, model.id)).runId);
    expect(events.filter((e) => e.type === "step_start")).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete", stopReason: "max_steps" });
  });

  it("applies a multi-file patch atomically", async () => {
    const { model, thread } = await setup("agent-patch", "openai-chat", { harness: { on: false, profileId: "ezclaw-agent", tools: ["apply_patch"] } });
    await setMode(thread.id, "edit");
    const events = await collectRun(ctx, (await send(thread.id, model.id)).runId);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ ok: true });
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("bar\nbaris dua\n");
    expect(readFileSync(join(ws, "b.txt"), "utf8")).toBe("baru\n");
  });
});

describe("harness", () => {
  const sentTools = () => mock.requests.filter((r) => r.path.endsWith("/chat/completions") && r.body).map((r) => r.body!);

  it("off: sends only the owner's own prompt and the tools they chose", async () => {
    const { model, thread } = await setup("agent-read", "openai-chat", { harness: { on: false, profileId: "ezclaw-agent", tools: ["read_file"] } });
    await ctx.json(`/api/threads/${thread.id}`, patch({ systemPrompt: "Jawab pendek." }));
    await collectRun(ctx, (await send(thread.id, model.id, "baca")).runId);
    const first = sentTools()[0]!;
    expect((first.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["read_file"]);
    expect((first.messages as { role: string; content: string }[])[0]).toEqual({ role: "system", content: "Jawab pendek." });
  });

  it("on: adds the project's AGENTS.md and the thread's own prompt after the harness text", async () => {
    writeFileSync(join(ws, "AGENTS.md"), "Gunakan tab, bukan spasi.");
    const { model, thread } = await setup("agent-read");
    await ctx.json(`/api/threads/${thread.id}`, patch({ systemPrompt: "Selalu sebut nama file." }));
    await collectRun(ctx, (await send(thread.id, model.id)).runId);
    const system = String((sentTools()[0]!.messages as { content: string }[])[0]!.content);
    expect(system.indexOf("You are EZClaw Agent")).toBeLessThan(system.indexOf("Gunakan tab, bukan spasi."));
    expect(system.indexOf("Gunakan tab, bukan spasi.")).toBeLessThan(system.indexOf("Selalu sebut nama file."));
    expect(system).toContain("# Project instructions (AGENTS.md)");
  });

  it("built-in profiles cannot be edited or deleted, but a copy can", async () => {
    expect((await ctx.req("/api/harness/ezclaw-agent", patch({ name: "x" }))).status).toBe(400);
    expect((await ctx.req("/api/harness/ezclaw-agent", { method: "DELETE" })).status).toBe(400);
    const copy = await ctx.json<HarnessProfile>("/api/harness/ezclaw-agent/duplicate", { method: "POST" });
    expect(copy).toMatchObject({ builtin: false, name: "EZClaw Agent (salinan)" });
    expect(await ctx.json<HarnessProfile>(`/api/harness/${copy.id}`, patch({ name: "Punyaku", tools: ["read_file"] }))).toMatchObject({ name: "Punyaku", tools: ["read_file"] });
    expect((await ctx.req(`/api/harness/${copy.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("a Codex-ref thread cannot start without a Codex folder, and uses the catalog's instructions once set", async () => {
    const { model, thread } = await setup("agent-codex", "openai-chat", { harness: { on: true, profileId: "codex-ref", tools: [] } });
    const refused = await ctx.req(`/api/threads/${thread.id}/messages`, post({ text: "x", modelId: model.id }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("codex_unavailable");

    const codex = join(ctx.tmp, "codex");
    mkdirSync(codex);
    writeFileSync(join(codex, "models.json"), JSON.stringify({ models: [{ slug: "agent-codex", base_instructions: "INSTRUKSI-CODEX-UJI" }] }));
    await ctx.json("/api/settings", put({ codexDir: codex }));
    const status = await ctx.json<{ ok: boolean; models: string[] }>("/api/codex/status", post({}));
    expect(status).toMatchObject({ ok: true, models: ["agent-codex"] });

    await setMode(thread.id, "full");
    const events = await collectRun(ctx, (await send(thread.id, model.id)).runId);
    expect((sentTools()[0]!.messages as { content: string }[])[0]!.content).toContain("INSTRUKSI-CODEX-UJI");
    expect((sentTools()[0]!.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(["exec_command", "apply_patch", "update_plan"]);
    const result = events.find((e) => e.type === "tool_result") as Extract<RunEvent, { type: "tool_result" }>;
    expect(result.output).toContain("dari-codex-ref");
  });

  it("only ever reads models.json from the Codex folder", () => {
    const codex = join(ctx.tmp, "codex2");
    mkdirSync(codex);
    writeFileSync(join(codex, "auth.json"), '{"secret":"jangan-dibaca"}');
    writeFileSync(join(codex, "models.json"), JSON.stringify({ models: [{ slug: "m", base_instructions: "ok" }] }));
    expect(JSON.stringify(ctx.services.harness.list())).not.toContain("jangan-dibaca");
  });
});

describe("threads", () => {
  it("validates the workspace and keeps agent-only fields off chat threads", async () => {
    const bad = await ctx.req("/api/threads", post({ mode: "agent", workspace: join(ctx.tmp, "tidak-ada") }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_workspace");
    expect((await ctx.req("/api/threads", post({ mode: "agent" }))).status).toBe(400);
    expect((await ctx.req("/api/threads", post({ mode: "agent", workspace: "relatif/saja" }))).status).toBe(400);

    const chat = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
    expect(chat).toMatchObject({ workspace: null, harness: { on: false, profileId: "ezclaw-chat" } });
    expect((await ctx.req(`/api/threads/${chat.id}`, patch({ approvalMode: "edit" }))).status).toBe(400);
  });

  it("lists recent workspaces and checks a path before use", async () => {
    await setup("agent-read");
    expect(await ctx.json("/api/workspaces/recent")).toEqual({ workspaces: [expect.stringContaining("ws")] });
    expect(await ctx.json("/api/workspaces/check", post({ path: ws }))).toMatchObject({ ok: true });
    expect(await ctx.json("/api/workspaces/check", post({ path: join(ws, "nope") }))).toMatchObject({ ok: false });
  });

  it("cannot change the workspace or harness while the agent is working", async () => {
    const { model, thread } = await setup("agent-edit");
    const run = await send(thread.id, model.id);
    await waitFor(run.runId, (e) => e.type === "approval");
    expect((await ctx.req(`/api/threads/${thread.id}`, patch({ workspace: ws }))).status).toBe(409);
    expect((await ctx.req(`/api/threads/${thread.id}`, patch({ harness: { on: false, profileId: "ezclaw-agent", tools: [] } }))).status).toBe(409);
    await ctx.req(`/api/runs/${run.runId}/stop`, { method: "POST" });
    await collectRun(ctx, run.runId);
  });
});

describe("context", () => {
  it("compacts older messages into a summary when the window fills up, and sends the summary instead", async () => {
    const { model, thread } = await setup("agent-read");
    await ctx.json(`/api/models/${model.id}`, patch({ override: { contextLength: 2000 } }));
    // A long earlier conversation, written straight into the thread.
    const insert = ctx.opened.sqlite.prepare("INSERT INTO messages (id, thread_id, seq, role, parts, status, notes, created_at) VALUES (?, ?, ?, ?, ?, 'complete', '[]', 0)");
    for (let i = 1; i <= 10; i++) {
      insert.run(`m${i}`, thread.id, i, i % 2 ? "user" : "assistant", JSON.stringify([{ type: "text", text: `Pesan lama nomor ${i}. ${"isi panjang ".repeat(60)}` }]));
    }
    const events = await collectRun(ctx, (await send(thread.id, model.id, "baca hello.txt")).runId);
    expect(types(events)).toContain("compaction");
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });

    const saved = await getThread(thread.id);
    expect(saved.summarySeq).toBeGreaterThan(0);
    const agentCalls = mock.requests.filter((r) => r.path.endsWith("/chat/completions") && r.body?.tools);
    const lastRequest = JSON.stringify(agentCalls.at(-1)!.body);
    expect(lastRequest).toContain("Ringkasan percakapan sebelumnya");
    expect(lastRequest).toContain("RINGKASAN uji");
    expect(lastRequest).not.toContain("Pesan lama nomor 1.");
  });
});

describe("request log", () => {
  it("records every model call of a step, with the key hidden", async () => {
    const { model, thread } = await setup("agent-read");
    await collectRun(ctx, (await send(thread.id, model.id)).runId);
    const saved = await getThread(thread.id);
    const first = saved.messages.find((m) => m.role === "assistant")!;
    const { logs } = await ctx.json<RequestLogResponse>(`/api/messages/${first.id}/request-logs`);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.requestHeaders.authorization).toBe("[disembunyikan]");
    expect(JSON.stringify(logs)).not.toContain("sk-test-agent-0001");
    expect((logs[0]?.requestBody as { tools?: unknown[] }).tools?.length).toBeGreaterThan(0);
  });
});

