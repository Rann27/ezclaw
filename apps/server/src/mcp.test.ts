import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EndpointDto, McpListResponse, McpServerDto, ModelDto, ModelListResponse, RunEvent, SendMessageResponse, SkillDto, SkillListResponse, ThreadDetailDto } from "@ezclaw/core";
import { zipSync } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { startMockProvider, type MockProvider } from "./testing/mockProvider.js";

const SERVER = fileURLToPath(new URL("./testing/mcpTestServer.mjs", import.meta.url));

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
});
afterEach(async () => {
  await ctx.services.mcp.stopAll();
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });

async function addTester(extra: Record<string, unknown> = {}): Promise<McpServerDto> {
  const created = await ctx.json<McpServerDto>("/api/mcp", post({ name: "tester", transport: "stdio", command: process.execPath, args: [SERVER], ...extra }));
  await ctx.services.mcp.ensure(created.id);
  return (await ctx.json<McpListResponse>("/api/mcp")).servers.find((s) => s.id === created.id)!;
}

async function model(modelId: string, opts: { vision?: boolean } = {}): Promise<ModelDto> {
  const endpoint = await ctx.json<EndpointDto>("/api/endpoints", post({ name: "Mock", presetId: "custom", protocol: "openai-chat", baseUrl: `${mock.url}/v1`, auth: { type: "bearer" }, apiKey: "sk-test-mcp-0001" }));
  await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId }));
  const m = (await ctx.json<ModelListResponse>("/api/models")).models.find((x) => x.endpointId === endpoint.id && x.modelId === modelId)!;
  return ctx.json<ModelDto>(`/api/models/${m.id}`, patch({ override: { tools: true, ...(opts.vision ? { inputModalities: ["text", "image"] } : {}) } }));
}

async function agentThread(m: ModelDto, full = false) {
  const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "agent", workspace: ws, modelId: m.id, ...(full ? { approvalMode: "full", confirmFull: true } : {}) }));
  return t;
}

const send = (threadId: string, modelId: string, text = "mulai") => ctx.json<SendMessageResponse>(`/api/threads/${threadId}/messages`, post({ text, modelId }));

async function waitFor(runId: string, predicate: (e: RunEvent) => boolean, timeoutMs = 10_000): Promise<RunEvent> {
  const started = Date.now();
  for (;;) {
    const snap = ctx.services.runs.snapshot(runId, 0);
    const hit = snap?.events.find(predicate);
    if (hit) return hit;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for event");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const toolNamesSent = () =>
  mock.requests
    .filter((r) => r.path.endsWith("/chat/completions"))
    .flatMap((r) => ((r.body?.tools as { function: { name: string } }[] | undefined) ?? []).map((t) => t.function.name));

describe("MCP servers", () => {
  it("connects a local server and lists its tools, prompts and resources", async () => {
    const s = await addTester();
    expect(s.status).toBe("connected");
    expect(s.serverName).toBe("ezclaw-test");
    expect(s.tools.map((t) => t.name).sort()).toEqual(["echo", "fail", "red_dot", "write_note"]);
    expect(s.tools.find((t) => t.name === "echo")).toMatchObject({ modelName: "mcp__tester__echo", readOnlyHint: true, policy: "auto" });
    expect(s.prompts.map((p) => p.name)).toEqual(["summarize"]);
    expect(s.resourceCount).toBe(1);
    expect(s.log.join("\n")).toContain("test server starting");

    const prompt = await ctx.json<{ text: string }>(`/api/mcp/${s.id}/prompts/summarize`, post({ arguments: { topic: "MCP" } }));
    expect(prompt.text).toBe("Please summarize MCP in three bullet points.");
  });

  it("keeps env values out of the database and reports a missing command plainly", async () => {
    const bad = await ctx.json<McpServerDto>("/api/mcp", post({ name: "rusak", transport: "stdio", command: "perintah-yang-tidak-ada-123", env: { API_KEY: "rahasia" } }));
    await ctx.services.mcp.ensure(bad.id);
    const listed = (await ctx.json<McpListResponse>("/api/mcp")).servers.find((s) => s.id === bad.id)!;
    expect(listed.status).toBe("error");
    expect(listed.envKeys).toEqual(["API_KEY"]);
    expect(JSON.stringify(listed)).not.toContain("rahasia");
    expect(ctx.secrets.get(`mcp:${bad.id}:env`)).toContain("rahasia");
  });

  it("agent: read-only tools run, others ask; 'allow always' is remembered for that tool", async () => {
    const s = await addTester();
    const m = await model("agent-mcp");
    const t = await agentThread(m);
    const run = await send(t.id, m.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(approval.request).toMatchObject({ kind: "mcp", server: "tester", tool: "write_note" });
    expect(approval.request.args).toContain("catatan");
    await ctx.json(`/api/runs/${run.runId}/approvals/${approval.approvalId}`, post({ decision: "allow_always" }));
    const events = await collectRun(ctx, run.runId);
    const results = events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["mcp__tester__echo", true],
      ["mcp__tester__write_note", true],
    ]);
    expect(results[0]!.output).toBe("echo: halo");
    expect(toolNamesSent()).toContain("mcp__tester__echo");
    expect((await ctx.json<McpListResponse>("/api/mcp")).servers.find((x) => x.id === s.id)!.toolPolicies).toEqual({ write_note: "allow" });

    // Next run: no question.
    const again = await collectRun(ctx, (await send(t.id, m.id)).runId);
    expect(again.some((e) => e.type === "approval")).toBe(false);
  });

  it("full mode runs MCP tools without asking, except tools set to 'always ask'; 'off' hides a tool", async () => {
    const s = await addTester();
    await ctx.json(`/api/mcp/${s.id}`, patch({ toolPolicies: { write_note: "ask", fail: "off" } }));
    const m = await model("agent-mcp");
    const t = await agentThread(m, true);
    const run = await send(t.id, m.id);
    const approval = (await waitFor(run.runId, (e) => e.type === "approval")) as Extract<RunEvent, { type: "approval" }>;
    expect(approval.request.tool).toBe("write_note");
    await ctx.json(`/api/runs/${run.runId}/approvals/${approval.approvalId}`, post({ decision: "deny", reason: "jangan" }));
    await collectRun(ctx, run.runId);
    expect(toolNamesSent()).not.toContain("mcp__tester__fail");
  });

  it("a trusted server runs every tool without asking; images in results reach a vision model", async () => {
    await addTester({ trust: "allow" });
    const m = await model("agent-mcp-image", { vision: true });
    const t = await agentThread(m);
    const events = await collectRun(ctx, (await send(t.id, m.id)).runId);
    expect(events.some((e) => e.type === "approval")).toBe(false);
    const last = mock.requests.filter((r) => r.path.endsWith("/chat/completions")).at(-1)!;
    expect(JSON.stringify(last.body)).toContain("data:image/png;base64,");
  });

  it("a server switched off for Agent is not offered", async () => {
    await addTester({ agent: false });
    const m = await model("agent-mcp");
    const t = await agentThread(m, true);
    await collectRun(ctx, (await send(t.id, m.id)).runId);
    expect(toolNamesSent().some((n) => n.startsWith("mcp__"))).toBe(false);
  });

  it("chat: with a server on for Chat, the chat runs through the tool loop", async () => {
    await addTester({ chat: true, trust: "allow" });
    const m = await model("agent-mcp");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const res = await send(t.id, m.id, "halo");
    expect(res.assistantMessageId).toBeNull();
    const events = await collectRun(ctx, res.runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
    const thread = await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`);
    expect(thread.messages.some((x) => x.role === "tool")).toBe(true);
    expect(thread.messages.at(-1)!.parts.find((p) => p.type === "text")).toMatchObject({ text: "MCP selesai: saved 1: catatan" });
  });

  it("chat without tools keeps the plain streaming path", async () => {
    await addTester({ chat: false });
    const m = await model("echo");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const res = await send(t.id, m.id, "halo");
    expect(res.assistantMessageId).not.toBeNull();
    await collectRun(ctx, res.runId);
  });

  it("remote server over HTTP with a header, and a clear failure without it", async () => {
    const port = 9930 + Math.floor(Math.random() * 50);
    const child: ChildProcess = spawn(process.execPath, [SERVER, "--http", String(port)], { env: { ...process.env, MCP_TEST_TOKEN: "tok-123" }, stdio: ["ignore", "pipe", "inherit"] });
    try {
      await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
      const ok = await ctx.json<McpServerDto>("/api/mcp", post({ name: "remote", transport: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer tok-123" } }));
      await ctx.services.mcp.ensure(ok.id);
      const listed = (await ctx.json<McpListResponse>("/api/mcp")).servers.find((s) => s.id === ok.id)!;
      expect(listed.status).toBe("connected");
      expect(listed.tools.length).toBe(4);
      expect(listed.headerKeys).toEqual(["Authorization"]);

      const no = await ctx.json<McpServerDto>("/api/mcp", post({ name: "remote2", transport: "http", url: `http://127.0.0.1:${port}/mcp` }));
      await ctx.services.mcp.ensure(no.id);
      const failed = (await ctx.json<McpListResponse>("/api/mcp")).servers.find((s) => s.id === no.id)!;
      expect(["error", "needs_auth"]).toContain(failed.status);
    } finally {
      child.kill();
    }
  });

  it("imports servers from Claude Desktop JSON and Codex TOML, switched off", async () => {
    const json = { mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "x" } }, web: { url: "https://example.com/mcp" } } };
    const r1 = await ctx.json<{ added: string[] }>("/api/mcp/import", post({ text: JSON.stringify(json) }));
    expect(r1.added.sort()).toEqual(["github", "web"]);
    const toml = '[mcp_servers.docs]\ncommand = "uvx"\nargs = ["docs-mcp"]\n\n[model_providers.x]\nname = "x"\n';
    const r2 = await ctx.json<{ added: string[]; skipped: unknown[] }>("/api/mcp/import", post({ text: toml }));
    expect(r2.added).toEqual(["docs"]);
    const servers = (await ctx.json<McpListResponse>("/api/mcp")).servers;
    expect(servers.every((s) => !s.enabled)).toBe(true);
    expect(servers.find((s) => s.name === "github")!.envKeys).toEqual(["GITHUB_TOKEN"]);
  });
});

describe("skills", () => {
  it("creates, lists, switches off, edits and deletes a skill", async () => {
    const created = await ctx.json<SkillDto>("/api/skills", post({ name: "catatan-rilis", description: "Tulis catatan rilis.", body: "Langkah 1." }));
    expect(created).toMatchObject({ name: "catatan-rilis", editable: true, enabled: true, chat: false });
    await ctx.json(`/api/skills/${created.id}`, patch({ enabled: false, chat: true }));
    const listed = (await ctx.json<SkillListResponse>("/api/skills")).skills.find((s) => s.id === created.id)!;
    expect(listed).toMatchObject({ enabled: false, chat: true });

    const content = await ctx.json<{ content: string }>(`/api/skills/${created.id}/content`);
    expect(content.content).toContain("name: catatan-rilis");
    const bad = await ctx.req(`/api/skills/${created.id}/content`, { method: "PUT", body: JSON.stringify({ content: "tanpa front matter" }) });
    expect(bad.status).toBe(400);
    const ok = await ctx.req(`/api/skills/${created.id}/content`, { method: "PUT", body: JSON.stringify({ content: content.content.replace("Langkah 1.", "Langkah baru.") }) });
    expect(ok.status).toBe(204);
    expect((await ctx.json<{ content: string }>(`/api/skills/${created.id}/content`)).content).toContain("Langkah baru.");

    expect((await ctx.req(`/api/skills/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await ctx.json<SkillListResponse>("/api/skills")).skills).toHaveLength(0);
  });

  it("imports skill folders from a zip, and from a folder", async () => {
    const enc = new TextEncoder();
    const zip = zipSync({ "repo-main/skills/a/SKILL.md": enc.encode("---\nname: skill-a\ndescription: A\n---\nA"), "repo-main/skills/b/SKILL.md": enc.encode("---\nname: skill-b\ndescription: B\nmcp:\n  - tester\n---\nB"), "../evil.txt": enc.encode("x") });
    const res = await ctx.req("/api/skills/import-zip", { method: "POST", body: Buffer.from(zip), headers: { "content-type": "application/zip" } });
    expect(((await res.json()) as { added: string[] }).added.sort()).toEqual(["skill-a", "skill-b"]);

    const src = join(ctx.tmp, "dari-folder", "skill-c");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "SKILL.md"), "---\nname: skill-c\ndescription: C\n---\nC");
    const r2 = await ctx.json<{ added: string[] }>("/api/skills/import", post({ folder: join(ctx.tmp, "dari-folder") }));
    expect(r2.added).toEqual(["skill-c"]);

    const all = (await ctx.json<SkillListResponse>("/api/skills")).skills;
    expect(all.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(all.find((s) => s.name === "skill-b")).toMatchObject({ mcp: ["tester"], missingMcp: ["tester"] });
  });

  it("a skill that needs an MCP server starts it when read, even if the server is off", async () => {
    await addTester({ enabled: false });
    await ctx.json("/api/skills", post({ name: "pakai-tester", description: "Pakai server tester.", body: "Panggil echo.", mcp: ["tester"] }));
    const m = await model("agent-skill-mcp");
    const t = await agentThread(m, true);
    const events = await collectRun(ctx, (await send(t.id, m.id)).runId);
    const results = events.filter((e): e is Extract<RunEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => r.name)).toEqual(["read_skill", "mcp__tester__echo"]);
    expect(results[1]).toMatchObject({ ok: true, output: "echo: dari skill" });
  });

  it("/skill-name sends the skill with the request and starts its MCP server", async () => {
    await addTester({ enabled: false });
    await ctx.json("/api/skills", post({ name: "pakai-tester", description: "Pakai server tester.", body: "INSTRUKSI-SKILL-UNIK", mcp: ["tester"] }));
    const m = await model("agent-slash");
    const t = await agentThread(m, true);
    const events = await collectRun(ctx, (await send(t.id, m.id, "/pakai-tester tolong")).runId);
    expect(events.some((e) => e.type === "note" && e.text.includes("Skill pakai-tester dipakai"))).toBe(true);
    const first = JSON.stringify(mock.requests.find((r) => r.path.endsWith("/chat/completions"))!.body);
    expect(first).toContain("INSTRUKSI-SKILL-UNIK");
    expect(first).toContain("mcp__tester__echo");
  });

  it("a switched-off skill is not listed for the model", async () => {
    const s = await ctx.json<SkillDto>("/api/skills", post({ name: "rahasia-dimatikan", description: "Tidak boleh terlihat." }));
    await ctx.json(`/api/skills/${s.id}`, patch({ enabled: false }));
    const m = await model("echo");
    const t = await agentThread(m, true);
    await collectRun(ctx, (await send(t.id, m.id, "halo")).runId);
    expect(JSON.stringify(mock.requests.at(-1)!.body)).not.toContain("rahasia-dimatikan");
  });
});
