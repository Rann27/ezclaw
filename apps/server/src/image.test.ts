import type { AssetDto, EndpointDto, ModelDto, ModelListResponse, RequestLogResponse, RunEvent, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { makePng } from "./testing/mockImages.js";
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
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const put = (body: unknown) => ({ method: "PUT", body: JSON.stringify(body) });

interface SetupOpts {
  model: string;
  /** Path under the mock the endpoint points at. */
  base: string;
  family?: string;
  override?: Record<string, unknown>;
}

async function setup(o: SetupOpts) {
  const endpoint = await ctx.json<EndpointDto>(
    "/api/endpoints",
    post({
      name: "MockImg",
      presetId: "custom",
      protocol: "openai-chat",
      baseUrl: `${mock.url}${o.base}`,
      auth: { type: "bearer" },
      apiKey: "sk-test-img-0001",
      ...(o.family ? { family: o.family } : {}),
    }),
  );
  await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId: o.model, kind: "image" }));
  const { models } = await ctx.json<ModelListResponse>("/api/models");
  let model = models.find((m) => m.endpointId === endpoint.id && m.modelId === o.model) as ModelDto;
  if (o.override) model = await ctx.json<ModelDto>(`/api/models/${model.id}`, patch({ override: o.override }));
  const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "image", modelId: model.id }));
  return { endpoint, model, thread };
}

async function upload(seed = 1): Promise<AssetDto> {
  const res = await ctx.req("/api/assets", { method: "POST", body: makePng(seed), headers: { "content-type": "application/octet-stream" } });
  expect(res.status).toBe(201);
  return (await res.json()) as AssetDto;
}

const sendImage = (threadId: string, body: Record<string, unknown>) => ctx.json<SendMessageResponse>(`/api/threads/${threadId}/images`, post(body));
const getThread = (id: string) => ctx.json<ThreadDetailDto>(`/api/threads/${id}`);

async function run(threadId: string, body: Record<string, unknown>) {
  const res = await sendImage(threadId, body);
  const events = await collectRun(ctx, res.runId);
  const thread = await getThread(threadId);
  const assistant = thread.messages.find((m) => m.id === res.assistantMessageId)!;
  return { res, events, thread, assistant, done: events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> };
}

const imageIds = (m: { parts: { type: string; assetId?: string }[] }) => m.parts.filter((p) => p.type === "image").map((p) => p.assetId!);

describe("assets", () => {
  it("stores an upload, serves it back, and treats the same file twice as one", async () => {
    const a = await upload(3);
    expect(a).toMatchObject({ kind: "upload", mime: "image/png", width: 48, height: 48 });
    expect(await upload(3)).toMatchObject({ id: a.id });

    const res = await ctx.req(`/api/assets/${a.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(makePng(3))).toBe(true);
    expect((await ctx.req(`/api/assets/${a.id}?download=1`)).headers.get("content-disposition")).toContain("attachment");
  });

  it("refuses anything that is not an image, whatever it claims to be", async () => {
    const res = await ctx.req("/api/assets", { method: "POST", body: "<html>bukan gambar</html>", headers: { "content-type": "image/png" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_an_image");
    expect((await ctx.req("/api/assets", { method: "POST", body: "" })).status).toBe(400);
  });

  it("needs the session token like every other route", async () => {
    const a = await upload();
    const res = await ctx.app.request(`http://127.0.0.1:8787/api/assets/${a.id}`, { headers: { host: "127.0.0.1:8787" } });
    expect(res.status).toBe(401);
  });
});

describe("generate", () => {
  it("openai-images: n images, size passed, saved as assets", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const { events, assistant, done } = await run(thread.id, { text: "a harbour", modelId: model.id, params: { n: 2, size: "1024x1024" } });
    expect(done.status).toBe("complete");
    const req = mock.requests.find((r) => r.path === "/v1/images/generations")!;
    expect(req.body).toMatchObject({ model: "gpt-img", prompt: "a harbour", n: 2, size: "1024x1024" });
    expect(req.headers.authorization).toBe("Bearer sk-test-img-0001");
    expect(imageIds(assistant)).toHaveLength(2);
    expect(assistant.image).toMatchObject({ wire: "openai-images", prompt: "a harbour", sentPrompt: "a harbour", composed: false, n: 2 });
    expect(events.filter((e) => e.type === "image_slot" && e.status === "done")).toHaveLength(2);
    for (const id of imageIds(assistant)) expect((await ctx.req(`/api/assets/${id}`)).status).toBe(200);
  });

  it("openai-images with references uses the edits endpoint and names each image", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const [a, b] = [await upload(1), await upload(2)];
    const { assistant, done } = await run(thread.id, {
      text: "paint a harbour",
      modelId: model.id,
      references: [
        { assetId: a.id, role: "style" },
        { assetId: b.id, role: "palette" },
      ],
    });
    expect(done.status).toBe("complete");
    const req = mock.requests.find((r) => r.path === "/v1/images/edits")!;
    expect(req.headers["content-type"]).toMatch(/^multipart\/form-data/);
    expect(req.raw!.match(/name="image\[\]"/g)).toHaveLength(2);
    expect(req.raw).toContain("Image 1 is a style reference");
    expect(req.raw).toContain("Image 2 is a colour palette reference");
    expect(assistant.image?.references).toEqual([
      { assetId: a.id, role: "style" },
      { assetId: b.id, role: "palette" },
    ]);
    expect(assistant.image?.sentPrompt).toContain("Instruction: paint a harbour");
  });

  it("openrouter-images: references travel as input_references and request logs hide the base64", async () => {
    const { thread, model } = await setup({ model: "bytedance/img", base: "/or/api/v1", family: "openrouter" });
    const a = await upload(4);
    const { res, assistant } = await run(thread.id, { text: "night", modelId: model.id, references: [{ assetId: a.id }], params: { aspectRatio: "16:9", resolution: "2K" } });
    const req = mock.requests.find((r) => r.path === "/or/api/v1/images")!;
    expect(req.body).toMatchObject({ aspect_ratio: "16:9", resolution: "2K" });
    expect((req.body!.input_references as { image_url: { url: string } }[])[0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(imageIds(assistant)).toHaveLength(1);

    const logs = await ctx.json<RequestLogResponse>(`/api/messages/${res.assistantMessageId}/request-logs`);
    expect(logs.logs).toHaveLength(1);
    const logged = JSON.stringify(logs.logs[0]);
    expect(logged).toContain("data URL gambar");
    expect(logged).not.toContain("base64,iVBOR");
    expect(logs.logs[0]!.requestHeaders.authorization).toBe("[disembunyikan]");
  });

  it("venice: generate with variants, and the edit endpoint when a reference is given", async () => {
    const { thread, model } = await setup({ model: "qwen-image", base: "/venice/api/v1", family: "venice" });
    const first = await run(thread.id, { text: "a fox", modelId: model.id, params: { n: 2, aspectRatio: "1:1", negativePrompt: "blur", seed: 7 } });
    expect(imageIds(first.assistant)).toHaveLength(2);
    expect(mock.requests.find((r) => r.path.endsWith("/image/generate"))!.body).toMatchObject({ variants: 2, aspect_ratio: "1:1", negative_prompt: "blur", seed: 7 });

    mock.requests.length = 0;
    const [a, b] = [await upload(5), await upload(6)];
    const second = await run(thread.id, { text: "make it blue", modelId: model.id, references: [{ assetId: a.id }, { assetId: b.id }], params: { composer: false } });
    expect(second.done.status).toBe("complete");
    const edits = mock.requests.filter((r) => r.path.endsWith("/image/edit"));
    expect(edits).toHaveLength(1);
    expect(String(edits[0]!.body!.image)).toMatch(/^data:image\/png;base64,/);
    expect(second.assistant.notes.join(" ")).toContain("paling banyak 1 gambar referensi");
    expect(imageIds(second.assistant)).toHaveLength(1);
  });

  it("dashscope: submits async tasks, polls, and downloads each result", async () => {
    const { thread, model } = await setup({ model: "qwen-image-3.0-pro", base: "/dash/compatible-mode/v1", family: "qwen" });
    const { assistant, done } = await run(thread.id, { text: "a cat", modelId: model.id, params: { n: 2, size: "1664*928", negativePrompt: "low quality" } });
    expect(done.status).toBe("complete");
    const submits = mock.requests.filter((r) => r.path.endsWith("/image-synthesis"));
    expect(submits).toHaveLength(2);
    expect(submits[0]!.headers["x-dashscope-async"]).toBe("enable");
    expect(submits[0]!.body).toMatchObject({ model: "qwen-image-3.0-pro", input: { prompt: "a cat" }, parameters: { n: 1, size: "1664*928", negative_prompt: "low quality" } });
    expect(mock.requests.filter((r) => r.path.includes("/tasks/")).length).toBeGreaterThanOrEqual(4);
    expect(imageIds(assistant)).toHaveLength(2);
  });

  it("dashscope cannot take references, and says so", async () => {
    const { thread, model } = await setup({ model: "qwen-image-3.0-pro", base: "/dash/compatible-mode/v1", family: "qwen" });
    const a = await upload(8);
    const { assistant } = await run(thread.id, { text: "a cat", modelId: model.id, references: [{ assetId: a.id }] });
    expect(assistant.notes.join(" ")).toContain("tidak menerima gambar referensi");
    expect(mock.requests.find((r) => r.path.endsWith("/image-synthesis"))!.raw).not.toContain("data:image");
  });

  it("chat-modalities: image comes back inside the message, modalities asked for", async () => {
    const { thread, model } = await setup({ model: "img-chat", base: "/v1", family: "google" });
    const { assistant, done } = await run(thread.id, { text: "a lighthouse", modelId: model.id, params: { aspectRatio: "9:16" } });
    expect(done.status).toBe("complete");
    const req = mock.requests.find((r) => r.path === "/v1/chat/completions")!;
    expect(req.body).toMatchObject({ model: "img-chat", modalities: ["image"], image_config: { aspect_ratio: "9:16" }, stream: false });
    expect(imageIds(assistant)).toHaveLength(1);
    expect(assistant.parts.find((p) => p.type === "text")).toMatchObject({ text: "Ini gambarnya." });
  });

  it("chat-modalities follow-up sends the earlier result with the new instruction", async () => {
    const { thread, model } = await setup({ model: "img-chat", base: "/v1", family: "google" });
    await run(thread.id, { text: "a lighthouse", modelId: model.id });
    mock.requests.length = 0;
    await run(thread.id, { text: "make it night", modelId: model.id });
    const req = mock.requests.find((r) => r.path === "/v1/chat/completions")!;
    const messages = req.body!.messages as { role: string; content: unknown }[];
    const last = messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("data:image/png;base64,");
    expect(JSON.stringify(last.content)).toContain("make it night");
    expect(messages[0]).toMatchObject({ role: "user", content: "a lighthouse" });
  });
});

describe("failures and limits", () => {
  it("a rejected prompt ends the turn as an error with the provider's reason", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const { assistant, done } = await run(thread.id, { text: "GAGAL total", modelId: model.id });
    expect(done.status).toBe("error");
    expect(assistant.status).toBe("error");
    expect(assistant.error).toContain("Prompt ditolak oleh filter mock");
    expect(imageIds(assistant)).toHaveLength(0);
  });

  it("caps n at the model limit and explains", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const { assistant } = await run(thread.id, { text: "x", modelId: model.id, params: { n: 9 } });
    expect(mock.requests.find((r) => r.path === "/v1/images/generations")!.body).toMatchObject({ n: 4 });
    expect(assistant.notes.join(" ")).toContain("paling banyak 4");
  });

  it("drops parameters the wire does not have", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const { assistant } = await run(thread.id, { text: "x", modelId: model.id, params: { negativePrompt: "blur", seed: 3 } });
    const body = mock.requests.find((r) => r.path === "/v1/images/generations")!.body!;
    expect(body).not.toHaveProperty("negative_prompt");
    expect(body).not.toHaveProperty("seed");
    expect(assistant.notes.join(" ")).toContain("Negative prompt tidak dikirim");
  });

  it("refuses a text model and a missing key", async () => {
    const { thread, model, endpoint } = await setup({ model: "gpt-img", base: "/v1" });
    await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId: "echo" }));
    const echo = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.modelId === "echo")!;
    const bad = await ctx.req(`/api/threads/${thread.id}/images`, post({ text: "x", modelId: echo.id }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("not_an_image_model");

    await ctx.req(`/api/endpoints/${endpoint.id}/key`, { method: "DELETE" });
    const noKey = await ctx.req(`/api/threads/${thread.id}/images`, post({ text: "x", modelId: model.id }));
    expect(((await noKey.json()) as { error: { code: string } }).error.code).toBe("key_missing");
  });

  it("rejects an unknown reference", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const res = await ctx.req(`/api/threads/${thread.id}/images`, post({ text: "x", modelId: model.id, references: [{ assetId: "nope" }] }));
    expect(res.status).toBe(404);
  });

  it("the profile can switch the wire and shrink its limits", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/or/api/v1", override: { image: { wire: "openrouter-images", maxN: 1 } } });
    const { assistant } = await run(thread.id, { text: "x", modelId: model.id, params: { n: 3 } });
    expect(mock.requests.some((r) => r.path === "/or/api/v1/images")).toBe(true);
    expect(imageIds(assistant)).toHaveLength(1);
    const profile = await ctx.json<{ imageSpec: { wire: string; maxN: number } }>(`/api/models/${model.id}/profile`);
    expect(profile.imageSpec).toMatchObject({ wire: "openrouter-images", maxN: 1 });
  });
});

describe("prompt composer", () => {
  async function withComposer() {
    const s = await setup({ model: "gpt-img", base: "/v1" });
    await ctx.json(`/api/endpoints/${s.endpoint.id}/models`, post({ modelId: "composer-json" }));
    const composer = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.modelId === "composer-json")!;
    await ctx.json("/api/settings", put({ defaultModels: { composer: composer.id } }));
    return s;
  }

  it("rewrites a follow-up into a standalone prompt and reuses the previous result as input", async () => {
    const { thread, model } = await withComposer();
    const first = await run(thread.id, { text: "a red cat", modelId: model.id });
    expect(first.assistant.image?.composed).toBe(false);

    mock.requests.length = 0;
    const second = await run(thread.id, { text: "make it night, add street lamps", modelId: model.id });
    const composed = second.events.find((e) => e.type === "composed") as Extract<RunEvent, { type: "composed" }>;
    expect(composed).toMatchObject({ prompt: "a red cat at night, street lamps", useLastImage: true });
    expect(second.assistant.image).toMatchObject({ composed: true, prompt: "make it night, add street lamps" });
    expect(second.assistant.image!.sentPrompt).toContain("a red cat at night, street lamps");
    expect(second.assistant.image!.sentPrompt).toContain("Image 1 is the previous result");
    // The composer saw the earlier prompt, and the previous result went along as an input image.
    expect(JSON.stringify(mock.requests.find((r) => r.body?.model === "composer-json")!.body)).toContain("a red cat");
    const edit = mock.requests.find((r) => r.path === "/v1/images/edits")!;
    expect(edit.raw!.match(/name="image\[\]"/g)).toHaveLength(1);
    expect(second.assistant.image!.references).toHaveLength(1);
  });

  it("is skipped when switched off or when the text is sent exactly", async () => {
    const { thread, model } = await withComposer();
    await run(thread.id, { text: "a red cat", modelId: model.id });
    for (const extra of [{ params: { composer: false } }, { exact: true }]) {
      mock.requests.length = 0;
      const r = await run(thread.id, { text: "make it night", modelId: model.id, ...extra });
      expect(r.events.some((e) => e.type === "composed")).toBe(false);
      expect(mock.requests.some((q) => q.body?.model === "composer-json")).toBe(false);
      expect(r.assistant.image?.sentPrompt).toBe("make it night");
    }
  });

  it("says so when no composer model is configured and sends the prompt as typed", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    await run(thread.id, { text: "a red cat", modelId: model.id });
    const r = await run(thread.id, { text: "make it night", modelId: model.id });
    expect(r.assistant.notes.join(" ")).toContain("Prompt Composer tidak jalan");
    expect(r.assistant.image?.sentPrompt).toBe("make it night");
  });
});

describe("threads", () => {
  it("image threads keep their settings and list under Image", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    expect(thread.mode).toBe("image");
    await run(thread.id, { text: "a long prompt about a harbour", modelId: model.id, params: { n: 2, size: "1536x1024" } });
    const after = await getThread(thread.id);
    expect(after.imageParams).toMatchObject({ n: 2, size: "1536x1024" });
    expect(after.title).toBe("a long prompt about a harbour");
    const list = await ctx.json<{ threads: { id: string }[] }>("/api/threads?mode=image");
    expect(list.threads.map((t) => t.id)).toContain(thread.id);
    expect((await ctx.json<{ threads: unknown[] }>("/api/threads?mode=chat")).threads).toHaveLength(0);
  });

  it("a new image thread starts with the Image default model", async () => {
    const { model } = await setup({ model: "gpt-img", base: "/v1" });
    await ctx.json("/api/settings", put({ defaultModels: { image: model.id } }));
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "image" }));
    expect(t.modelId).toBe(model.id);
  });
});
