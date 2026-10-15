import type { EndpointDto, EndpointTestResponse, MessageDto, ModelDto, ModelListResponse, RequestLogResponse, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { startMockProvider, type MockProvider } from "./testing/mockProvider.js";

let mock: MockProvider;
let ctx: TestContext;

beforeAll(async () => {
  mock = await startMockProvider();
});
afterAll(() => mock.close());
beforeEach(() => {
  ctx = createTestContext();
  mock.requests.length = 0;
});
afterEach(async () => {
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });

async function addEndpoint(overrides: Record<string, unknown> = {}, key: string | null = "sk-secret-key-1234") {
  const endpoint = await ctx.json<EndpointDto>(
    "/api/endpoints",
    post({
      name: "Mock",
      presetId: "custom",
      protocol: "openai-chat",
      baseUrl: `${mock.url}/v1`,
      auth: { type: "bearer" },
      ...(key ? { apiKey: key } : {}),
      ...overrides,
    }),
  );
  return endpoint;
}

async function modelRow(endpoint: EndpointDto, modelId: string): Promise<ModelDto> {
  const { models } = await ctx.json<ModelListResponse>("/api/models");
  const found = models.find((m) => m.endpointId === endpoint.id && m.modelId === modelId);
  if (!found) throw new Error(`model ${modelId} not found`);
  return found;
}

async function setup(modelId: string, endpointOverrides: Record<string, unknown> = {}) {
  const endpoint = await addEndpoint(endpointOverrides);
  await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId }));
  const model = await modelRow(endpoint, modelId);
  const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
  return { endpoint, model, thread };
}

async function send(threadId: string, modelId: string, text: string, extra: Record<string, unknown> = {}) {
  return ctx.json<SendMessageResponse>(`/api/threads/${threadId}/messages`, post({ text, modelId, ...extra }));
}

async function thread(id: string) {
  return ctx.json<ThreadDetailDto>(`/api/threads/${id}`);
}

const textOf = (m: MessageDto) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("");

describe("endpoints and keys", () => {
  it("never returns the key: only whether one exists and its last 4 characters", async () => {
    const endpoint = await addEndpoint();
    expect(endpoint).toMatchObject({ hasKey: true, keyLast4: "1234" });
    const all = JSON.stringify(await ctx.json("/api/endpoints"));
    expect(all).not.toContain("sk-secret-key");
    expect(ctx.secrets.get(`endpoint:${endpoint.id}`)).toBe("sk-secret-key-1234");
  });

  it("keeps keys out of the SQLite file entirely", async () => {
    await addEndpoint();
    const rows = JSON.stringify(ctx.opened.sqlite.prepare("SELECT * FROM endpoints").all());
    expect(rows).not.toContain("sk-secret-key");
    expect(rows).toContain("1234");
  });

  it("validates input: bad URL, credentials in the URL, header auth without a name", async () => {
    const bad = (overrides: Record<string, unknown>) => ctx.req("/api/endpoints", post({ name: "X", presetId: "custom", protocol: "openai-chat", baseUrl: "https://a.example/v1", auth: { type: "bearer" }, ...overrides }));
    expect((await bad({ baseUrl: "not a url" })).status).toBe(400);
    expect((await bad({ baseUrl: "ftp://a.example" })).status).toBe(400);
    expect((await bad({ baseUrl: "https://user:pw@a.example/v1" })).status).toBe(400);
    expect((await bad({ auth: { type: "header" } })).status).toBe(400);
    expect((await bad({ presetId: "nope" })).status).toBe(400);
  });

  it("replaces and clears the key, and removes it from the store on delete", async () => {
    const endpoint = await addEndpoint();
    expect(await ctx.json<EndpointDto>(`/api/endpoints/${endpoint.id}/key`, put({ key: "sk-other-9999" }))).toMatchObject({ keyLast4: "9999" });
    expect(await ctx.json<EndpointDto>(`/api/endpoints/${endpoint.id}/key`, { method: "DELETE" })).toMatchObject({ hasKey: false, keyLast4: null });
    expect(ctx.secrets.get(`endpoint:${endpoint.id}`)).toBeNull();

    await ctx.json(`/api/endpoints/${endpoint.id}/key`, put({ key: "sk-again-0000" }));
    expect((await ctx.req(`/api/endpoints/${endpoint.id}`, { method: "DELETE" })).status).toBe(204);
    expect(ctx.secrets.get(`endpoint:${endpoint.id}`)).toBeNull();
  });

  it("discovers models from the provider and reports the count", async () => {
    const endpoint = await addEndpoint();
    const result = await ctx.json<EndpointTestResponse>(`/api/endpoints/${endpoint.id}/test`, post({}));
    expect(result).toMatchObject({ ok: true, usedSuggestions: false });
    expect(result.modelCount).toBeGreaterThanOrEqual(7);
    expect(mock.requests.at(-1)?.headers.authorization).toBe("Bearer sk-secret-key-1234");
    const { endpoints } = await ctx.json<{ endpoints: EndpointDto[] }>("/api/endpoints");
    expect(endpoints[0]?.lastTest).toMatchObject({ ok: true });
  });

  it("explains a missing key, a rejected key, and an unreachable server", async () => {
    const noKey = await addEndpoint({ name: "No key" }, null);
    expect(await ctx.json<EndpointTestResponse>(`/api/endpoints/${noKey.id}/test`, post({}))).toMatchObject({ ok: false, message: expect.stringContaining("Key belum diisi") });

    const rejected = await addEndpoint({ name: "Rejected", baseUrl: `${mock.url}/v1x` });
    const res = await ctx.json<EndpointTestResponse>(`/api/endpoints/${rejected.id}/test`, post({}));
    expect(res.ok).toBe(false);
    expect(res.message).toContain("404");

    const down = await addEndpoint({ name: "Down", baseUrl: "http://127.0.0.1:9/v1" });
    const downRes = await ctx.json<EndpointTestResponse>(`/api/endpoints/${down.id}/test`, post({}));
    expect(downRes.ok).toBe(false);
    expect(downRes.message).toContain("Tidak bisa menjangkau http://127.0.0.1:9/v1");
  });

  it("uses suggested models when the provider has no list endpoint (DeepSeek)", async () => {
    const endpoint = await ctx.json<EndpointDto>(
      "/api/endpoints",
      post({ name: "DeepSeek", presetId: "deepseek", protocol: "openai-chat", baseUrl: `${mock.url}/nolist`, auth: { type: "bearer" }, apiKey: "sk-deepseek-0001" }),
    );
    expect(endpoint.modelCount).toBe(1 + 1);
    const res = await ctx.json<EndpointTestResponse>(`/api/endpoints/${endpoint.id}/test`, post({}));
    expect(res).toMatchObject({ ok: true, usedSuggestions: true });
    const { models } = await ctx.json<ModelListResponse>("/api/models");
    expect(models.map((m) => m.modelId)).toContain("deepseek-flash");
  });

  it("reads Anthropic capabilities and authenticates with x-api-key plus the version header", async () => {
    const endpoint = await ctx.json<EndpointDto>(
      "/api/endpoints",
      post({ name: "Claude", presetId: "anthropic", protocol: "anthropic", baseUrl: `${mock.url}/anthropic`, auth: { type: "header", headerName: "x-api-key" }, apiKey: "sk-ant-1111" }),
    );
    const res = await ctx.json<EndpointTestResponse>(`/api/endpoints/${endpoint.id}/test`, post({}));
    expect(res).toMatchObject({ ok: true });
    const listing = mock.requests.at(-1)!;
    expect(listing.headers["x-api-key"]).toBe("sk-ant-1111");
    expect(listing.headers["anthropic-version"]).toBe("2023-06-01");
    const model = await modelRow(endpoint, "claude-sonnet-5-5");
    expect(model.summary).toMatchObject({ reasoning: true, reasoningStyle: "anthropic-adaptive" });
  });

  it("clears default-model settings that point at a deleted endpoint", async () => {
    const { endpoint, model } = await setup("echo");
    await ctx.json("/api/settings", put({ defaultModels: { chat: model.id } }));
    await ctx.req(`/api/endpoints/${endpoint.id}`, { method: "DELETE" });
    expect(await ctx.json("/api/settings")).toMatchObject({ defaultModels: {} });
  });
});

describe("model profile", () => {
  it("shows the effective profile with the layer each field came from, and applies an owner override", async () => {
    const { model } = await setup("echo", { presetId: "custom", family: "deepseek" });
    const before = await ctx.json<any>(`/api/models/${model.id}/profile`);
    expect(before.profile.reasoning.style).toBe("deepseek");
    expect(before.provenance["reasoning.style"]).toBe("preset");
    expect(before.presetSources.length).toBeGreaterThan(0);

    const updated = await ctx.json<ModelDto>(`/api/models/${model.id}`, patch({ override: { contextLength: 12345 }, alias: "Flash", favorite: true }));
    expect(updated).toMatchObject({ alias: "Flash", favorite: true, hasOverride: true });
    const after = await ctx.json<any>(`/api/models/${model.id}/profile`);
    expect(after.profile.contextLength).toBe(12345);
    expect(after.provenance.contextLength).toBe("override");

    const cleared = await ctx.json<ModelDto>(`/api/models/${model.id}`, patch({ override: null }));
    expect(cleared.hasOverride).toBe(false);
  });

  it("rejects an override that is not a valid profile patch", async () => {
    const { model } = await setup("echo");
    expect((await ctx.req(`/api/models/${model.id}`, patch({ override: { reasoning: { style: "made-up" } } }))).status).toBe(400);
  });
});

describe("chat streaming", () => {
  it("streams an answer, saves both messages, titles the thread, and logs the request without the key", async () => {
    const { thread: t, model } = await setup("echo");
    const sent = await send(t.id, model.id, "Halo, apa kabar?");
    const events = await collectRun(ctx, sent.runId);

    expect(events[0]).toMatchObject({ type: "start", messageId: sent.assistantMessageId });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Halo dunia");
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete", finishReason: "stop" });

    const saved = await thread(t.id);
    expect(saved.title).toBe("Halo, apa kabar?");
    expect(saved.activeRun).toBeNull();
    expect(saved.messages.map((m) => [m.role, m.status, textOf(m)])).toEqual([
      ["user", "complete", "Halo, apa kabar?"],
      ["assistant", "complete", "Halo dunia"],
    ]);
    expect(saved.messages[1]).toMatchObject({ modelLabel: "Mock / echo", usage: { inputTokens: 3, outputTokens: 2 }, finishReason: "stop" });

    const sentBody = mock.requests.find((r) => r.path === "/v1/chat/completions")!.body!;
    expect(sentBody).toMatchObject({ model: "echo", stream: true, messages: [{ role: "user", content: "Halo, apa kabar?" }] });

    const { logs } = await ctx.json<RequestLogResponse>(`/api/messages/${sent.assistantMessageId}/request-logs`);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ attempt: 1, method: "POST", status: 200, url: `${mock.url}/v1/chat/completions` });
    expect(logs[0]?.requestHeaders.authorization).toBe("[disembunyikan]");
    expect(JSON.stringify(logs)).not.toContain("sk-secret-key");
  });

  it("sends earlier turns as history and the system prompt first", async () => {
    const { thread: t, model } = await setup("echo");
    await collectRun(ctx, (await send(t.id, model.id, "satu", { systemPrompt: "Tanggal {{date}}." })).runId);
    await collectRun(ctx, (await send(t.id, model.id, "dua")).runId);
    const second = mock.requests.filter((r) => r.path === "/v1/chat/completions")[1]!.body!;
    const msgs = second.messages as { role: string; content: string }[];
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toMatch(/^Tanggal \d{4}-\d{2}-\d{2}\.$/);
    expect(msgs.slice(1)).toEqual([
      { role: "user", content: "satu" },
      { role: "assistant", content: "Halo dunia" },
      { role: "user", content: "dua" },
    ]);
  });

  it("separates reasoning from the answer", async () => {
    const { thread: t, model } = await setup("think");
    const events = await collectRun(ctx, (await send(t.id, model.id, "mikir")).runId);
    expect(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join("")).toBe("Saya berpikir.");
    const m = (await thread(t.id)).messages[1]!;
    expect(m.parts).toEqual([
      { type: "reasoning", text: "Saya berpikir." },
      { type: "text", text: "Jawaban akhir." },
    ]);
    expect(m.usage).toMatchObject({ reasoningTokens: 4 });
  });

  it("splits inline <think> tags on custom endpoints even when a tag is cut across chunks", async () => {
    const { thread: t, model } = await setup("tags");
    await collectRun(ctx, (await send(t.id, model.id, "x")).runId);
    expect((await thread(t.id)).messages[1]?.parts).toEqual([
      { type: "reasoning", text: "diam-diam" },
      { type: "text", text: "terlihat" },
    ]);
  });

  it("copes with a server that ignores stream: true", async () => {
    const { thread: t, model } = await setup("json-only");
    await collectRun(ctx, (await send(t.id, model.id, "x")).runId);
    const m = (await thread(t.id)).messages[1]!;
    expect(m.status).toBe("complete");
    expect(textOf(m)).toBe("balasan tanpa stream");
  });

  it("replays a run's events from any point, as when a tab reconnects", async () => {
    const { thread: t, model } = await setup("echo");
    const sent = await send(t.id, model.id, "x");
    const all = await collectRun(ctx, sent.runId);
    const tail = await collectRun(ctx, sent.runId, 2);
    expect(tail).toEqual(all.slice(2));
  });

  it("refuses a second message while one is running, and stop keeps the partial answer", async () => {
    const { thread: t, model } = await setup("slow");
    const sent = await send(t.id, model.id, "pelan");
    expect((await ctx.req(`/api/threads/${t.id}/messages`, post({ text: "lagi", modelId: model.id }))).status).toBe(409);
    expect((await thread(t.id)).activeRun).toMatchObject({ runId: sent.runId });

    const collecting = collectRun(ctx, sent.runId);
    await new Promise((r) => setTimeout(r, 250));
    expect((await ctx.req(`/api/runs/${sent.runId}/stop`, { method: "POST" })).status).toBe(202);
    const events = await collecting;
    expect(events.at(-1)).toMatchObject({ type: "done", status: "stopped" });

    const m = (await thread(t.id)).messages[1]!;
    expect(m.status).toBe("stopped");
    expect(textOf(m)).toMatch(/^kata0 /);
    expect((await ctx.req(`/api/runs/${sent.runId}/stop`, { method: "POST" })).status).toBe(404);
  });

  it("marks an answer left streaming by a crash instead of showing it as running forever", async () => {
    const { thread: t } = await setup("echo");
    ctx.opened.sqlite
      .prepare("INSERT INTO messages (id, thread_id, seq, role, parts, status, notes, created_at) VALUES ('orphan', ?, 1, 'assistant', '[]', 'streaming', '[]', 0)")
      .run(t.id);
    ctx.services.chat.recover();
    const m = (await thread(t.id)).messages[0]!;
    expect(m.status).toBe("error");
    expect(m.error).toContain("dimulai ulang");
  });

  it("saves the partial answer when the server shuts down mid-stream", async () => {
    const { thread: t, model } = await setup("slow");
    await send(t.id, model.id, "pelan");
    await new Promise((r) => setTimeout(r, 200));
    await ctx.restart();
    const m = (await thread(t.id)).messages[1]!;
    expect(m.status).toBe("stopped");
    expect(textOf(m)).toContain("kata0");
  });
});

describe("provider failures", () => {
  it("shows a clear error for a rejected key and keeps the user message", async () => {
    const { thread: t, model } = await setup("unauthorized");
    const events = await collectRun(ctx, (await send(t.id, model.id, "x")).runId);
    const done = events.at(-1) as { status: string; error: string };
    expect(done.status).toBe("error");
    expect(done.error).toContain("menolak key (401)");
    expect(done.error).toContain("Incorrect API key");
    const saved = await thread(t.id);
    expect(saved.messages.map((m) => m.status)).toEqual(["complete", "error"]);
    expect(saved.messages[1]?.error).toContain("401");
    expect(mock.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(1);
  });

  it("keeps the text received before a mid-stream error", async () => {
    const { thread: t, model } = await setup("midfail");
    const events = await collectRun(ctx, (await send(t.id, model.id, "x")).runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "error", error: "upstream exploded" });
    expect(textOf((await thread(t.id)).messages[1]!)).toBe("setengah ");
  });

  it("refuses to send without a key, or with an image-only model", async () => {
    const endpoint = await addEndpoint({}, null);
    await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId: "echo" }));
    const model = await modelRow(endpoint, "echo");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
    const res = await ctx.req(`/api/threads/${t.id}/messages`, post({ text: "x", modelId: model.id }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("key_missing");
    expect(mock.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(0);
  });

  it("reports an unreachable server with the address that was tried", async () => {
    const { thread: t, model } = await setup("echo", { baseUrl: "http://127.0.0.1:9/v1" });
    const events = await collectRun(ctx, (await send(t.id, model.id, "x")).runId);
    expect((events.at(-1) as { error: string }).error).toContain("http://127.0.0.1:9/v1");
  });
});

describe("rejected parameters", () => {
  const sampled = { params: { top_p: 0.9, temperature: 0.5 } };

  it("retries once without the field the provider names, tells the user, and remembers it", async () => {
    const { thread: t, model } = await setup("reject-top_p");
    const sent = await send(t.id, model.id, "x", sampled);
    const events = await collectRun(ctx, sent.runId);

    expect(events.some((e) => e.type === "note" && e.text.includes('Field "top_p" ditolak'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });

    const calls = mock.requests.filter((r) => r.path === "/v1/chat/completions");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toHaveProperty("top_p", 0.9);
    expect(calls[1]?.body).not.toHaveProperty("top_p");
    expect(calls[1]?.body).toHaveProperty("temperature", 0.5);

    const { logs } = await ctx.json<RequestLogResponse>(`/api/messages/${sent.assistantMessageId}/request-logs`);
    expect(logs.map((l) => [l.attempt, l.status])).toEqual([[1, 400], [2, 200]]);

    expect((await thread(t.id)).messages[1]?.notes[0]).toContain('Field "top_p" ditolak');
    const { models } = await ctx.json<ModelListResponse>("/api/models");
    expect(models.find((m) => m.id === model.id)?.omitCount).toBe(1);

    // The next message does not even try top_p.
    await collectRun(ctx, (await send(t.id, model.id, "lagi", sampled)).runId);
    const later = mock.requests.filter((r) => r.path === "/v1/chat/completions").slice(2);
    expect(later).toHaveLength(1);
    expect(later[0]?.body).not.toHaveProperty("top_p");
  });

  it("does not retry when the owner turned auto-retry off", async () => {
    const { thread: t, model } = await setup("reject-top_p");
    await ctx.json("/api/settings", put({ autoRetryRejectedParams: false }));
    const events = await collectRun(ctx, (await send(t.id, model.id, "x", sampled)).runId);
    const done = events.at(-1) as { status: string; error: string };
    expect(done.status).toBe("error");
    expect(done.error).toContain("top_p");
    expect(mock.requests.filter((r) => r.path === "/v1/chat/completions")).toHaveLength(1);
  });

  it("lets the owner clear what was learned", async () => {
    const { thread: t, model } = await setup("reject-top_p");
    await collectRun(ctx, (await send(t.id, model.id, "x", sampled)).runId);
    const cleared = await ctx.json<ModelDto>(`/api/models/${model.id}`, patch({ omit: [] }));
    expect(cleared.omitCount).toBe(0);
  });
});

describe("anthropic protocol", () => {
  it("sends the right headers and body, and keeps thinking text and signature", async () => {
    const endpoint = await ctx.json<EndpointDto>(
      "/api/endpoints",
      post({ name: "Claude", presetId: "anthropic", protocol: "anthropic", baseUrl: `${mock.url}/anthropic`, auth: { type: "header", headerName: "x-api-key" }, apiKey: "sk-ant-2222" }),
    );
    await ctx.json(`/api/endpoints/${endpoint.id}/test`, post({}));
    const model = await modelRow(endpoint, "claude-sonnet-5-5");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
    const sent = await send(t.id, model.id, "halo", { systemPrompt: "Singkat.", params: { reasoning: { mode: "on", effort: "low" }, stop: ["STOP"] } });
    await collectRun(ctx, sent.runId);

    const call = mock.requests.find((r) => r.path === "/anthropic/v1/messages")!;
    expect(call.headers["x-api-key"]).toBe("sk-ant-2222");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: "claude-sonnet-5-5",
      stream: true,
      system: "Singkat.",
      max_tokens: 16000,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "low" },
      stop_sequences: ["STOP"],
      messages: [{ role: "user", content: [{ type: "text", text: "halo" }] }],
    });

    const m = (await thread(t.id)).messages[1]!;
    expect(m.parts).toEqual([
      { type: "reasoning", text: "Hmm.", signature: "sig123" },
      { type: "text", text: "Halo dari Claude." },
    ]);
    expect(m.usage).toMatchObject({ inputTokens: 11, outputTokens: 5 });
    expect(m.finishReason).toBe("stop");

    const { logs } = await ctx.json<RequestLogResponse>(`/api/messages/${sent.assistantMessageId}/request-logs`);
    expect(logs[0]?.requestHeaders["x-api-key"]).toBe("[disembunyikan]");
  });
});

describe("thread management", () => {
  it("renames, pins, archives, and deletes threads", async () => {
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
    expect(t.title).toBe("Percakapan baru");
    expect(await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`, patch({ title: "Riset", pinned: true }))).toMatchObject({ title: "Riset", pinned: true });
    const list = await ctx.json<{ threads: { id: string }[] }>("/api/threads?mode=chat");
    expect(list.threads.map((x) => x.id)).toEqual([t.id]);
    await ctx.json(`/api/threads/${t.id}`, patch({ archived: true }));
    expect((await ctx.json<{ threads: unknown[] }>("/api/threads?mode=chat")).threads).toHaveLength(0);
    expect((await ctx.req(`/api/threads/${t.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await ctx.req(`/api/threads/${t.id}`)).status).toBe(404);
  });

  it("starts new threads on the default chat model from settings", async () => {
    const { model } = await setup("echo");
    await ctx.json("/api/settings", put({ defaultModels: { chat: model.id } }));
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
    expect(t.modelId).toBe(model.id);
  });

  it("validates params saved on a thread", async () => {
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat" }));
    expect((await ctx.req(`/api/threads/${t.id}`, patch({ params: { temperature: "hot" } }))).status).toBe(400);
    expect((await ctx.req(`/api/threads/${t.id}`, patch({ params: { nonsense: 1 } }))).status).toBe(400);
  });
});
