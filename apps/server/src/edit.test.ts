import { buildVersions, type AssetDto, type EndpointDto, type ModelDto, type ModelListResponse, type RunEvent, type SendMessageResponse, type ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { sniffImage } from "./services/imageInfo.js";
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

async function setup(o: { model: string; base: string; family?: string; override?: Record<string, unknown> }) {
  const endpoint = await ctx.json<EndpointDto>(
    "/api/endpoints",
    post({ name: "MockEdit", presetId: "custom", protocol: "openai-chat", baseUrl: `${mock.url}${o.base}`, auth: { type: "bearer" }, apiKey: "sk-test-edit-0001", ...(o.family ? { family: o.family } : {}) }),
  );
  await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId: o.model, kind: "image" }));
  let model = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.endpointId === endpoint.id && m.modelId === o.model) as ModelDto;
  if (o.override) model = await ctx.json<ModelDto>(`/api/models/${model.id}`, patch({ override: o.override }));
  const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "edit", modelId: model.id }));
  return { endpoint, model, thread };
}

async function upload(seed: number, size?: number): Promise<AssetDto> {
  const res = await ctx.req("/api/assets", { method: "POST", body: makePng(seed, size), headers: { "content-type": "application/octet-stream" } });
  return (await res.json()) as AssetDto;
}

const getThread = (id: string) => ctx.json<ThreadDetailDto>(`/api/threads/${id}`);

async function edit(threadId: string, body: Record<string, unknown>) {
  const res = await ctx.json<SendMessageResponse>(`/api/threads/${threadId}/edits`, post(body));
  const events = await collectRun(ctx, res.runId);
  const thread = await getThread(threadId);
  const assistant = thread.messages.find((m) => m.id === res.assistantMessageId)!;
  return { res, events, thread, assistant, done: events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> };
}

const imageIds = (m: { parts: { type: string; assetId?: string }[] }) => m.parts.filter((p) => p.type === "image").map((p) => p.assetId!);

describe("edit", () => {
  it("openai-images: target first, references with roles, and what to keep, all in the prompt", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const [target, ref] = [await upload(1), await upload(2)];
    const { assistant, done } = await edit(thread.id, {
      text: "make it dusk",
      modelId: model.id,
      target: target.id,
      references: [{ assetId: ref.id, role: "style" }],
      keep: ["face", "composition"],
    });
    expect(done.status).toBe("complete");

    const req = mock.requests.find((r) => r.path === "/v1/images/edits")!;
    expect(req.raw!.match(/name="image\[\]"/g)).toHaveLength(2);
    expect(req.raw).toContain("Image 1 is the image to edit.");
    expect(req.raw).toContain("Image 2 is a style reference");
    expect(req.raw).toContain("Instruction: make it dusk");
    expect(req.raw).toContain("Keep unchanged from Image 1: the face and identity of any person or character, the composition and framing.");

    expect(assistant.image).toMatchObject({ target: target.id, keep: ["face", "composition"], prompt: "make it dusk", composed: false, wire: "openai-images" });
    expect(assistant.image!.references).toEqual([{ assetId: ref.id, role: "style" }]);
    expect(imageIds(assistant)).toHaveLength(1);
  });

  it("the owner's message records the target apart from the references", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const [target, ref] = [await upload(1), await upload(2)];
    const { thread: after } = await edit(thread.id, { text: "x", modelId: model.id, target: target.id, references: [{ assetId: ref.id, role: "palette" }] });
    const user = after.messages.find((m) => m.role === "user")!;
    expect(user.parts.filter((p) => p.type === "image")).toEqual([
      { type: "image", assetId: target.id, role: "target" },
      { type: "image", assetId: ref.id, role: "palette" },
    ]);
  });

  it("chains versions, and editing an older one branches without touching the rest", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const original = await upload(3);
    const first = await edit(thread.id, { text: "one", modelId: model.id, target: original.id, params: { n: 2 } });
    const [v1, v2] = imageIds(first.assistant);
    expect([v1, v2]).toHaveLength(2);

    const second = await edit(thread.id, { text: "two", modelId: model.id, target: v1, keep: ["colors"], params: { n: 1 } });
    const [v3] = imageIds(second.assistant);
    const third = await edit(thread.id, { text: "three", modelId: model.id, target: original.id, params: { n: 1 } });
    const [v4] = imageIds(third.assistant);

    const final = await getThread(thread.id);
    const versions = buildVersions(final.messages);
    expect(versions.map((v) => [v.label, v.assetId, v.parent])).toEqual([
      ["v0", original.id, null],
      ["v1", v1, original.id],
      ["v2", v2, original.id],
      ["v3", v3, v1],
      ["v4", v4, original.id],
    ]);
    expect(versions[3]).toMatchObject({ instruction: "two" });

    // The second edit really sent the first result, not the original.
    const edits = mock.requests.filter((r) => r.path === "/v1/images/edits");
    expect(edits).toHaveLength(3);
    expect(edits[1]!.raw).toContain("Keep unchanged from Image 1: the colour palette.");
  });

  it("exact sends the text as written, with the images still in order", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const target = await upload(4);
    const { assistant } = await edit(thread.id, { text: "my own words", modelId: model.id, target: target.id, keep: ["face"], exact: true });
    const req = mock.requests.find((r) => r.path === "/v1/images/edits")!;
    expect(req.raw).toContain("my own words");
    expect(req.raw).not.toContain("Image 1 is the image to edit");
    expect(assistant.image?.sentPrompt).toBe("my own words");
  });

  it("openrouter-images: the target is the first input reference", async () => {
    const { thread, model } = await setup({ model: "bytedance/img", base: "/or/api/v1", family: "openrouter" });
    const [target, ref] = [await upload(5), await upload(6)];
    await edit(thread.id, { text: "x", modelId: model.id, target: target.id, references: [{ assetId: ref.id }] });
    const body = mock.requests.find((r) => r.path === "/or/api/v1/images")!.body!;
    const refs = body.input_references as { image_url: { url: string } }[];
    expect(refs).toHaveLength(2);
    expect(refs[0]!.image_url.url).toContain(makePng(5).toString("base64").slice(0, 60));
    expect(refs[1]!.image_url.url).toContain(makePng(6).toString("base64").slice(0, 60));
  });

  it("venice takes one image, so the target goes and references are dropped with a reason", async () => {
    const { thread, model } = await setup({ model: "qwen-edit", base: "/venice/api/v1", family: "venice" });
    const [target, ref] = [await upload(7), await upload(8)];
    const { assistant, done } = await edit(thread.id, { text: "x", modelId: model.id, target: target.id, references: [{ assetId: ref.id }] });
    expect(done.status).toBe("complete");
    const req = mock.requests.find((r) => r.path.endsWith("/image/edit"))!;
    expect(String(req.body!.image)).toContain(makePng(7).toString("base64").slice(0, 60));
    expect(assistant.notes.join(" ")).toContain("hanya menerima satu gambar input");
    expect(assistant.image!.references).toEqual([]);
  });

  it("venice: ratio and tier come from the target, and the result is resized to its exact size", async () => {
    const { thread, model } = await setup({ model: "qwen-edit", base: "/venice/api/v1", family: "venice" });
    const target = await upload(12, 64);
    const { assistant, done } = await edit(thread.id, { text: "x", modelId: model.id, target: target.id });
    expect(done.status).toBe("complete");
    const body = mock.requests.find((r) => r.path.endsWith("/image/edit"))!.body!;
    expect(body.aspect_ratio).toBe("auto");
    expect(body.resolution).toBe("1K");
    const bytes = Buffer.from(await (await ctx.req(`/api/assets/${imageIds(assistant)[0]}`)).arrayBuffer());
    expect(sniffImage(bytes)).toMatchObject({ width: 64, height: 64 });
    expect(assistant.notes.join(" ")).toContain("48x48, diubah ke 64x64");
  });

  it("venice: with the size switch off the provider size is kept", async () => {
    const { thread, model } = await setup({ model: "qwen-edit", base: "/venice/api/v1", family: "venice" });
    const target = await upload(13, 64);
    const { assistant } = await edit(thread.id, { text: "x", modelId: model.id, target: target.id, params: { matchTarget: false } });
    const bytes = Buffer.from(await (await ctx.req(`/api/assets/${imageIds(assistant)[0]}`)).arrayBuffer());
    expect(sniffImage(bytes)).toMatchObject({ width: 48, height: 48 });
    expect(mock.requests.find((r) => r.path.endsWith("/image/edit"))!.body!.resolution).toBeUndefined();
  });

  it("venice: test connection discovers edit models, and they edit with no resolution they do not list", async () => {
    const endpoint = await ctx.json<EndpointDto>(
      "/api/endpoints",
      post({ name: "Venice", presetId: "venice", protocol: "openai-chat", baseUrl: `${mock.url}/venice/api/v1`, auth: { type: "bearer" }, apiKey: "sk-test-venice-0001" }),
    );
    const test = await ctx.json<{ ok: boolean }>(`/api/endpoints/${endpoint.id}/test`, post({}));
    expect(test.ok).toBe(true);
    const all = (await ctx.json<ModelListResponse>("/api/models")).models.filter((m) => m.endpointId === endpoint.id);
    const byId = Object.fromEntries(all.map((m) => [m.modelId, m]));
    expect(byId["qwen-edit"]).toMatchObject({ kind: "image", summary: { imageInputs: 1, editOnly: true } });
    expect(byId["flux-gen"]).toMatchObject({ kind: "image", summary: { imageInputs: 0, editOnly: false } });
    expect(byId["venice-text"]?.kind).toBe("text");

    const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "edit", modelId: byId["qwen-edit"]!.id }));
    const target = await upload(14, 64);
    const { assistant, done } = await edit(thread.id, { text: "make it dusk", modelId: byId["qwen-edit"]!.id, target: target.id });
    expect(done.status).toBe("complete");
    const body = mock.requests.find((r) => r.path.endsWith("/image/edit"))!.body!;
    expect(body).toMatchObject({ model: "qwen-edit", aspect_ratio: "auto" });
    expect(body).not.toHaveProperty("resolution");
    const bytes = Buffer.from(await (await ctx.req(`/api/assets/${imageIds(assistant)[0]}`)).arrayBuffer());
    expect(sniffImage(bytes)).toMatchObject({ width: 64, height: 64 });

    // A generation-only model cannot edit.
    const res = await ctx.req(`/api/threads/${thread.id}/edits`, post({ text: "x", modelId: byId["flux-gen"]!.id, target: target.id }));
    expect(res.status).toBe(400);
  });

  it("on start, a model list made by an older discovery is reloaded once", async () => {
    const endpoint = await ctx.json<EndpointDto>(
      "/api/endpoints",
      post({ name: "Venice", presetId: "venice", protocol: "openai-chat", baseUrl: `${mock.url}/venice/api/v1`, auth: { type: "bearer" }, apiKey: "sk-test-venice-0001" }),
    );
    await ctx.json(`/api/endpoints/${endpoint.id}/test`, post({}));
    // Pretend the list came from the old discovery: only the text model, and no version stored.
    const { models: modelsTable, settings: settingsTable } = await import("./db/schema.js");
    const { and, eq, ne } = await import("drizzle-orm");
    const db = ctx.opened.db;
    db.delete(modelsTable).where(and(eq(modelsTable.endpointId, endpoint.id), ne(modelsTable.modelId, "venice-text"))).run();
    db.delete(settingsTable).where(eq(settingsTable.key, "_discoveryVersion")).run();

    expect(await ctx.services.registry.refreshStaleDiscovery()).toBe(1);
    const ids = (await ctx.json<ModelListResponse>("/api/models")).models.filter((m) => m.endpointId === endpoint.id).map((m) => m.modelId).sort();
    expect(ids).toEqual(["flux-gen", "krea-gen", "nano-edit", "qwen-edit", "venice-text"]);
    // Once is enough.
    expect(await ctx.services.registry.refreshStaleDiscovery()).toBe(0);
  });

  it("venice: an edit with references goes to /image/multi-edit, target first; generate sends style references", async () => {
    const endpoint = await ctx.json<EndpointDto>(
      "/api/endpoints",
      post({ name: "Venice", presetId: "venice", protocol: "openai-chat", baseUrl: `${mock.url}/venice/api/v1`, auth: { type: "bearer" }, apiKey: "sk-test-venice-0001" }),
    );
    await ctx.json(`/api/endpoints/${endpoint.id}/test`, post({}));
    const byId = Object.fromEntries((await ctx.json<ModelListResponse>("/api/models")).models.filter((m) => m.endpointId === endpoint.id).map((m) => [m.modelId, m]));
    expect(byId["nano-edit"]!.summary).toMatchObject({ imageInputs: 4, editOnly: true });
    expect(byId["krea-gen"]!.summary).toMatchObject({ imageInputs: 3, editOnly: false });
    expect(byId["qwen-edit"]!.summary.imageInputs).toBe(1); // combineImages false: one image only

    const thread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "edit", modelId: byId["nano-edit"]!.id }));
    const [target, ref] = [await upload(15, 64), await upload(16)];
    const { done, assistant } = await edit(thread.id, { text: "x", modelId: byId["nano-edit"]!.id, target: target.id, references: [{ assetId: ref.id, role: "style" }] });
    expect(done.status).toBe("complete");
    const body = mock.requests.find((r) => r.path.endsWith("/image/multi-edit"))!.body!;
    expect(body).toMatchObject({ modelId: "nano-edit", aspect_ratio: "auto", resolution: "1K", safe_mode: false });
    const images = body.images as string[];
    expect(images).toHaveLength(2);
    expect(images[0]).toBe(makePng(15, 64).toString("base64"));
    expect(images[1]).toBe(makePng(16).toString("base64"));
    expect(assistant.image!.references).toHaveLength(1);
    expect(mock.requests.some((r) => r.path.endsWith("/image/edit"))).toBe(false);

    // Generate with a style reference.
    mock.requests.length = 0;
    const gen = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "image", modelId: byId["krea-gen"]!.id }));
    const res = await ctx.json<{ runId: string }>(`/api/threads/${gen.id}/images`, post({ text: "a cat", modelId: byId["krea-gen"]!.id, references: [{ assetId: ref.id }], params: { n: 2 } }));
    await collectRun(ctx, res.runId);
    const g = mock.requests.find((r) => r.path.endsWith("/image/generate"))!.body!;
    expect(g).toMatchObject({ model: "krea-gen", variants: 2, safe_mode: false });
    expect(g.style_references).toEqual([{ image: makePng(16).toString("base64") }]);
  });

  it("a model that takes no input images cannot edit, and the request never leaves", async () => {
    const { thread, model } = await setup({ model: "qwen-image-3.0-pro", base: "/dash/compatible-mode/v1", family: "qwen" });
    const target = await upload(9);
    const res = await ctx.req(`/api/threads/${thread.id}/edits`, post({ text: "x", modelId: model.id, target: target.id }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("model_cannot_edit");
    expect(mock.requests.some((r) => r.path.includes("image-synthesis"))).toBe(false);
  });

  it("chat-modalities: one self-contained request with the target first, even after earlier edits", async () => {
    const { thread, model } = await setup({ model: "img-chat", base: "/v1", family: "google" });
    const [target, ref] = [await upload(10), await upload(11)];
    const first = await edit(thread.id, { text: "one", modelId: model.id, target: target.id });
    mock.requests.length = 0;
    await edit(thread.id, { text: "two", modelId: model.id, target: imageIds(first.assistant)[0], references: [{ assetId: ref.id, role: "style" }] });
    const messages = mock.requests.find((r) => r.path === "/v1/chat/completions")!.body!.messages as { role: string; content: { type: string; image_url?: { url: string } }[] }[];
    expect(messages).toHaveLength(1);
    const images = messages[0]!.content.filter((p) => p.type === "image_url");
    expect(images).toHaveLength(2);
    expect(images[1]!.image_url!.url).toContain(makePng(11).toString("base64").slice(0, 60));
  });

  it("tidying with the Prompt Composer is opt-in and replaces the compiled prompt", async () => {
    const { thread, model, endpoint } = await setup({ model: "gpt-img", base: "/v1" });
    await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId: "composer-json" }));
    const composer = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.modelId === "composer-json")!;
    await ctx.json("/api/settings", put({ defaultModels: { composer: composer.id } }));
    const target = await upload(12);

    const plain = await edit(thread.id, { text: "make it dusk", modelId: model.id, target: target.id });
    expect(plain.events.some((e) => e.type === "composed")).toBe(false);
    expect(mock.requests.some((r) => r.body?.model === "composer-json")).toBe(false);

    const polished = await edit(thread.id, { text: "make it dusk", modelId: model.id, target: target.id, params: { composer: true } });
    expect(polished.events.some((e) => e.type === "composed")).toBe(true);
    expect(polished.assistant.image).toMatchObject({ composed: true, sentPrompt: "a red cat at night, street lamps" });
    expect(JSON.stringify(mock.requests.find((r) => r.body?.model === "composer-json")!.body)).toContain("Image 1 is the image to edit");
  });

  it("says so when tidying is asked for but there is no composer model", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const target = await upload(13);
    const { assistant } = await edit(thread.id, { text: "x", modelId: model.id, target: target.id, params: { composer: true } });
    expect(assistant.notes.join(" ")).toContain("Prompt Composer tidak jalan");
    expect(assistant.image?.sentPrompt).toContain("Image 1 is the image to edit.");
  });
});

describe("edit guards", () => {
  it("only works in an edit thread, and an image thread rejects edits", async () => {
    const { model } = await setup({ model: "gpt-img", base: "/v1" });
    const target = await upload(14);
    const imageThread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "image", modelId: model.id }));
    const res = await ctx.req(`/api/threads/${imageThread.id}/edits`, post({ text: "x", modelId: model.id, target: target.id }));
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_edit_thread");

    const editThread = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "edit", modelId: model.id }));
    const back = await ctx.req(`/api/threads/${editThread.id}/images`, post({ text: "x", modelId: model.id }));
    expect(((await back.json()) as { error: { code: string } }).error.code).toBe("not_image_thread");
  });

  it("rejects an unknown target or reference, a text model, and a missing instruction", async () => {
    const { thread, model, endpoint } = await setup({ model: "gpt-img", base: "/v1" });
    const target = await upload(15);
    const send = (body: Record<string, unknown>) => ctx.req(`/api/threads/${thread.id}/edits`, post(body));
    expect((await send({ text: "x", modelId: model.id, target: "nope" })).status).toBe(404);
    expect((await send({ text: "x", modelId: model.id, target: target.id, references: [{ assetId: "nope" }] })).status).toBe(404);
    expect((await send({ text: "  ", modelId: model.id, target: target.id })).status).toBe(400);

    await ctx.json(`/api/endpoints/${endpoint.id}/models`, post({ modelId: "echo" }));
    const echo = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.modelId === "echo")!;
    expect(((await (await send({ text: "x", modelId: echo.id, target: target.id })).json()) as { error: { code: string } }).error.code).toBe("not_an_image_model");
  });

  it("a new edit thread starts with the Edit default model, else the Image one", async () => {
    const { model } = await setup({ model: "gpt-img", base: "/v1" });
    await ctx.json("/api/settings", put({ defaultModels: { image: model.id } }));
    expect((await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "edit" }))).modelId).toBe(model.id);
  });

  it("edit threads list under Edit and keep the default title rules", async () => {
    const { thread, model } = await setup({ model: "gpt-img", base: "/v1" });
    const target = await upload(16);
    await edit(thread.id, { text: "remove the lamp post", modelId: model.id, target: target.id });
    expect((await getThread(thread.id)).title).toBe("remove the lamp post");
    const list = await ctx.json<{ threads: { id: string }[] }>("/api/threads?mode=edit");
    expect(list.threads.map((t) => t.id)).toContain(thread.id);
  });
});
