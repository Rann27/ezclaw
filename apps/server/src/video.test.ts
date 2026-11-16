import type { AssetDto, EndpointDto, ModelDto, ModelListResponse, ModelProfileResponse, RunEvent, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recoverRuns } from "./services/index.js";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { makePng } from "./testing/mockImages.js";
import { startMockProvider, type MockProvider } from "./testing/mockProvider.js";
import { releaseSlowJobs } from "./testing/mockVideos.js";

let mock: MockProvider;
let ctx: TestContext;

beforeAll(async () => {
  mock = await startMockProvider();
});
afterAll(() => mock.close());
beforeEach(() => {
  ctx = createTestContext();
  mock.requests.length = 0;
  releaseSlowJobs(false);
});
afterEach(async () => {
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

async function endpoint(base: string, presetId = "custom", family?: string): Promise<EndpointDto> {
  return ctx.json<EndpointDto>(
    "/api/endpoints",
    post({ name: "MockVid", presetId, protocol: "openai-chat", baseUrl: `${mock.url}${base}`, auth: { type: "bearer" }, apiKey: "sk-test-vid-0001", ...(family ? { family } : {}) }),
  );
}

async function models(endpointId: string): Promise<ModelDto[]> {
  return (await ctx.json<ModelListResponse>("/api/models")).models.filter((m) => m.endpointId === endpointId);
}

async function discover(base: string, presetId: string) {
  const ep = await endpoint(base, presetId);
  await ctx.json(`/api/endpoints/${ep.id}/test`, post({}));
  return { ep, list: await models(ep.id) };
}

const newThread = (modelId: string) => ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "video", modelId }));

async function upload(seed = 1): Promise<AssetDto> {
  const res = await ctx.req("/api/assets", { method: "POST", body: makePng(seed), headers: { "content-type": "application/octet-stream" } });
  return (await res.json()) as AssetDto;
}

async function run(threadId: string, body: Record<string, unknown>) {
  const res = await ctx.json<SendMessageResponse>(`/api/threads/${threadId}/videos`, post(body));
  const events = await collectRun(ctx, res.runId);
  const thread = await ctx.json<ThreadDetailDto>(`/api/threads/${threadId}`);
  const assistant = thread.messages.find((m) => m.id === res.assistantMessageId)!;
  return { res, events, assistant, done: events.find((e) => e.type === "done") as Extract<RunEvent, { type: "done" }> };
}

const notes = (events: RunEvent[]) => events.filter((e) => e.type === "note").map((e) => (e as { text: string }).text);

describe("video: Venice", () => {
  it("finds text-to-video and image-to-video models with their limits, and leaves upscalers out", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const videos = list.filter((m) => m.kind === "video").map((m) => m.modelId).sort();
    expect(videos).toEqual(["wan-mock-image-to-video", "wan-mock-text-to-video"]);
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    const profile = await ctx.json<ModelProfileResponse>(`/api/models/${t2v.id}/profile`);
    expect(profile.videoSpec).toMatchObject({ wire: "venice-video", durations: [5, 10], resolutions: ["480p", "720p"], textToVideo: true, startFrame: false, pairedModelId: "wan-mock-image-to-video" });
  });

  it("makes a video from text: queue, wait, download, and a playable asset", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    const thread = await newThread(t2v.id);
    const { events, assistant, done } = await run(thread.id, { text: "kucing berlari di pantai", modelId: t2v.id, params: { duration: 10, resolution: "720p", aspectRatio: "16:9" } });

    expect(done.status).toBe("complete");
    const queued = mock.requests.find((r) => r.path.endsWith("/video/queue"))!.body!;
    expect(queued).toMatchObject({ model: "wan-mock-text-to-video", prompt: "kucing berlari di pantai", duration: "10s", resolution: "720p", aspect_ratio: "16:9" });
    expect(queued).not.toHaveProperty("image_url");
    expect(notes(events).some((n) => n.includes("$0.123"))).toBe(true);
    expect(events.some((e) => e.type === "video_progress" && e.status === "running")).toBe(true);
    expect(mock.requests.some((r) => r.path.endsWith("/video/complete"))).toBe(true);

    const part = assistant.parts[0] as { type: string; assetId: string };
    expect(part.type).toBe("video");
    expect(assistant.video).toMatchObject({ wire: "venice-video", job: { id: expect.any(String) } });

    const whole = await ctx.req(`/api/assets/${part.assetId}`);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    const ranged = await ctx.req(`/api/assets/${part.assetId}`, { headers: { range: "bytes=0-7" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toMatch(/^bytes 0-7\//);
    expect((await ranged.arrayBuffer()).byteLength).toBe(8);
  });

  it("switches to the image-to-video sibling when a start frame is attached", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    const frame = await upload();
    const thread = await newThread(t2v.id);
    const { events, done } = await run(thread.id, { text: "kucing menoleh", modelId: t2v.id, startFrame: frame.id, params: { aspectRatio: "16:9", audio: false } });

    expect(done.status).toBe("complete");
    const queued = mock.requests.find((r) => r.path.endsWith("/video/queue"))!.body!;
    expect(queued.model).toBe("wan-mock-image-to-video");
    expect(String(queued.image_url)).toMatch(/^data:image\/png;base64,/);
    expect(queued).not.toHaveProperty("aspect_ratio");
    expect(queued.audio).toBe(false);
    expect(notes(events).some((n) => n.includes("wan-mock-image-to-video"))).toBe(true);
  });

  it("reports a refused job as an error on the message", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    const thread = await newThread(t2v.id);
    const { done, assistant } = await run(thread.id, { text: "ini akan gagal", modelId: t2v.id });
    expect(done.status).toBe("error");
    expect(assistant.status).toBe("error");
    expect(assistant.error).toContain("content policy");
  });
});

describe("video: xAI", () => {
  it("sends the start frame as an image object and records the cost", async () => {
    const ep = await endpoint("/v1", "xai");
    await ctx.json(`/api/endpoints/${ep.id}/models`, post({ modelId: "grok-imagine-video", kind: "video" }));
    const model = (await models(ep.id)).find((m) => m.modelId === "grok-imagine-video")!;
    const frame = await upload(2);
    const thread = await newThread(model.id);
    const { done, assistant } = await run(thread.id, { text: "angin meniup rambutnya", modelId: model.id, startFrame: frame.id, params: { duration: 20, resolution: "720p", audio: true } });

    expect(done.status).toBe("complete");
    const sent = mock.requests.find((r) => r.path === "/v1/videos/generations")!.body!;
    expect(sent).toMatchObject({ model: "grok-imagine-video", prompt: "angin meniup rambutnya", duration: 15, resolution: "720p", generate_audio: true });
    expect(String((sent.image as { url: string }).url)).toMatch(/^data:image\/png;base64,/);
    expect(assistant.usage?.costUsd).toBeCloseTo(0.5);
    expect(assistant.notes.some((n) => n.includes("15 detik"))).toBe(true);
  });
});

describe("video: OpenRouter", () => {
  it("lists video models from /videos/models and sends first and last frames", async () => {
    const { list } = await discover("/or/api/v1", "openrouter");
    const veo = list.find((m) => m.modelId === "google/veo-mock")!;
    expect(veo.kind).toBe("video");
    const profile = await ctx.json<ModelProfileResponse>(`/api/models/${veo.id}/profile`);
    expect(profile.videoSpec).toMatchObject({ wire: "openrouter-videos", durations: [4, 8], startFrame: true, endFrame: true, audio: "optional", seed: true });

    const [a, b] = [await upload(3), await upload(4)];
    const thread = await newThread(veo.id);
    const { done, assistant } = await run(thread.id, { text: "transisi siang ke malam", modelId: veo.id, startFrame: a.id, endFrame: b.id, params: { duration: 8, seed: 7 } });

    expect(done.status).toBe("complete");
    const sent = mock.requests.find((r) => r.method === "POST" && r.path === "/or/api/v1/videos")!.body!;
    expect((sent.frame_images as { frame_type: string }[]).map((f) => f.frame_type)).toEqual(["first_frame", "last_frame"]);
    expect(sent).toMatchObject({ duration: 8, seed: 7 });
    const download = mock.requests.find((r) => r.path.endsWith("/content"))!;
    expect(download.headers.authorization).toBe("Bearer sk-test-vid-0001");
    expect(assistant.usage?.costUsd).toBeCloseTo(0.5);
  });

  it("refuses a start frame on a model that only makes video from text", async () => {
    const { list } = await discover("/or/api/v1", "openrouter");
    const textOnly = list.find((m) => m.modelId === "text/only-video")!;
    const frame = await upload(5);
    const thread = await newThread(textOnly.id);
    const { done, assistant } = await run(thread.id, { text: "x", modelId: textOnly.id, startFrame: frame.id });
    expect(done.status).toBe("error");
    expect(assistant.error).toContain("hanya membuat video dari teks");
    expect(mock.requests.some((r) => r.method === "POST" && r.path === "/or/api/v1/videos")).toBe(false);
  });
});

describe("video: restarts", () => {
  it("keeps waiting for the same job after EZClaw restarts, without sending it again", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    const thread = await newThread(t2v.id);
    const res = await ctx.json<SendMessageResponse>(`/api/threads/${thread.id}/videos`, post({ text: "video lambat", modelId: t2v.id }));
    // Wait until the job is accepted and saved.
    for (let i = 0; i < 200 && !ctx.services.runs.snapshot(res.runId, 0)?.events.some((e) => e.type === "video_progress" && e.status === "running"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await ctx.restart();
    const parked = (await ctx.json<ThreadDetailDto>(`/api/threads/${thread.id}`)).messages.find((m) => m.id === res.assistantMessageId)!;
    expect(parked.status).toBe("streaming");
    expect(parked.video?.job?.id).toBeTruthy();

    releaseSlowJobs();
    recoverRuns(ctx.services);
    const active = (await ctx.json<ThreadDetailDto>(`/api/threads/${thread.id}`)).activeRun!;
    const events = await collectRun(ctx, active.runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "complete" });
    expect(mock.requests.filter((r) => r.path.endsWith("/video/queue"))).toHaveLength(1);
    const after = (await ctx.json<ThreadDetailDto>(`/api/threads/${thread.id}`)).messages.find((m) => m.id === res.assistantMessageId)!;
    expect(after.parts[0]).toMatchObject({ type: "video" });
  });

  it("marks the message stopped when the owner stops waiting", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    const thread = await newThread(t2v.id);
    const res = await ctx.json<SendMessageResponse>(`/api/threads/${thread.id}/videos`, post({ text: "video lambat", modelId: t2v.id }));
    for (let i = 0; i < 200 && !ctx.services.runs.snapshot(res.runId, 0)?.events.some((e) => e.type === "video_progress" && e.status === "running"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await ctx.req(`/api/runs/${res.runId}/stop`, { method: "POST" });
    const events = await collectRun(ctx, res.runId);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "stopped" });
    const msg = (await ctx.json<ThreadDetailDto>(`/api/threads/${thread.id}`)).messages.find((m) => m.id === res.assistantMessageId)!;
    expect(msg.status).toBe("stopped");
    expect(msg.notes.some((n) => n.includes("tetap ditagih"))).toBe(true);
  });
});

describe("video: price before sending", () => {
  const quote = (body: Record<string, unknown>) => ctx.json<{ usd: number | null; source: string; modelId: string; error: string | null }>("/api/video/quote", post(body));

  it("asks Venice for a quote, following the sibling a start frame would use", async () => {
    const { list } = await discover("/venice/api/v1", "venice");
    const t2v = list.find((m) => m.modelId === "wan-mock-text-to-video")!;
    expect(await quote({ modelId: t2v.id, params: { duration: 10 } })).toMatchObject({ usd: 0.123, source: "Venice", modelId: "wan-mock-text-to-video", error: null });
    expect((await quote({ modelId: t2v.id, hasStart: true })).modelId).toBe("wan-mock-image-to-video");
    const sent = mock.requests.find((r) => r.path.endsWith("/video/quote"))!.body!;
    expect(sent).toMatchObject({ model: "wan-mock-text-to-video", duration: "10s" });
    // Nothing was queued.
    expect(mock.requests.some((r) => r.path.endsWith("/video/queue"))).toBe(false);
  });

  it("works out OpenRouter's price from its price per second", async () => {
    const { list } = await discover("/or/api/v1", "openrouter");
    const veo = list.find((m) => m.modelId === "google/veo-mock")!;
    const q = await quote({ modelId: veo.id, params: { duration: 8 } });
    expect(q.usd).toBeCloseTo(3.2);
    expect(q.source).toContain("per detik");
  });

  it("says when the price comes only afterwards, and when the request would be refused", async () => {
    const ep = await endpoint("/v1", "xai");
    await ctx.json(`/api/endpoints/${ep.id}/models`, post({ modelId: "grok-imagine-video", kind: "video" }));
    const grok = (await models(ep.id)).find((m) => m.modelId === "grok-imagine-video")!;
    expect(await quote({ modelId: grok.id })).toMatchObject({ usd: null, error: null });

    const or = await discover("/or/api/v1", "openrouter");
    const textOnly = or.list.find((m) => m.modelId === "text/only-video")!;
    expect((await quote({ modelId: textOnly.id, hasStart: true })).error).toContain("hanya membuat video dari teks");
  });
});
