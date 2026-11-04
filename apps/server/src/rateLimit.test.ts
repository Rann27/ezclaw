import type { EndpointDto, ModelListResponse, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isQuotaError, RateLimiter, retryAfterMs } from "./provider/rateLimit.js";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { startMockProvider, type MockProvider } from "./testing/mockProvider.js";

const never = new AbortController().signal;

describe("RateLimiter", () => {
  it("lets rpm requests through per window, then waits for the oldest to age out", async () => {
    const limiter = new RateLimiter(300);
    const waits: number[] = [];
    const t0 = Date.now();
    await limiter.acquire("ep", 2, never, (ms) => waits.push(ms));
    await limiter.acquire("ep", 2, never, (ms) => waits.push(ms));
    expect(waits).toEqual([]);
    await limiter.acquire("ep", 2, never, (ms) => waits.push(ms));
    expect(waits).toHaveLength(1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    // Another endpoint has its own budget.
    expect(await limiter.acquire("other", 2, never)).toBe(0);
  });

  it("holds every request back after a pause, even without a limit", async () => {
    const limiter = new RateLimiter(60_000);
    limiter.pause("ep", 150);
    const why: string[] = [];
    const waited = await limiter.acquire("ep", null, never, (_ms, w) => why.push(w));
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(why).toEqual(["paused"]);
  });

  it("stops waiting when the run is stopped", async () => {
    const limiter = new RateLimiter(60_000);
    limiter.pause("ep", 10_000);
    const stop = new AbortController();
    const pending = limiter.acquire("ep", null, stop.signal);
    stop.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("reads the wait a 429 asks for", () => {
    expect(retryAfterMs(new Headers({ "retry-after": "7" }))).toBe(7000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(retryAfterMs(new Headers({ "retry-after": new Date(Date.now() + 5000).toUTCString() }))).toBeGreaterThan(3000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset-requests": "6m0s" }))).toBe(360_000);
    expect(retryAfterMs(new Headers({ "x-ratelimit-reset-requests": "250ms" }))).toBe(250);
    expect(retryAfterMs(new Headers())).toBeNull();
  });

  it("tells an exhausted quota from a rate limit", () => {
    expect(isQuotaError('{"error":{"code":"insufficient_quota"}}')).toBe(true);
    expect(isQuotaError('{"error":{"code":"free_limit_reached"}}')).toBe(true);
    expect(isQuotaError('{"error":{"code":"rate_limit_exceeded","message":"10 requests per minute"}}')).toBe(false);
    expect(isQuotaError("Quota exceeded for metric generate_content_requests per minute")).toBe(false);
  });
});

describe("429 handling in model calls", () => {
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

  async function chatWith(modelId: string, rateLimitRpm?: number) {
    const ep = await ctx.json<EndpointDto>("/api/endpoints", post({ name: "Mock", presetId: "custom", protocol: "openai-chat", baseUrl: `${mock.url}/v1`, auth: { type: "bearer" }, apiKey: "sk-test-rate-0001", ...(rateLimitRpm ? { rateLimitRpm } : {}) }));
    await ctx.json(`/api/endpoints/${ep.id}/models`, post({ modelId }));
    const m = (await ctx.json<ModelListResponse>("/api/models")).models.find((x) => x.endpointId === ep.id)!;
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const sent = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "halo", modelId: m.id }));
    await collectRun(ctx, sent.runId);
    const detail = await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`);
    return { ep, detail, answer: detail.messages.at(-1)!, calls: mock.requests.filter((r) => r.path === "/v1/chat/completions") };
  }

  it("waits as long as Retry-After asks, then sends the same request again", async () => {
    const started = Date.now();
    const { answer, calls } = await chatWith("flaky-429");
    expect(answer.status).toBe("complete");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.raw).toBe(calls[0]!.raw);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(JSON.stringify(answer)).toContain("membalas 429");
  });

  it("waits out a CDN error page and sends the same request again", async () => {
    const { answer, calls } = await chatWith("flaky-520");
    expect(answer.status).toBe("complete");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.raw).toBe(calls[0]!.raw);
    expect(JSON.stringify(answer)).toContain("sedang bermasalah (520)");
  });

  it("gives up on a server error after the retries, with a short message instead of the HTML page", async () => {
    const { answer, calls } = await chatWith("down-503");
    expect(answer.status).toBe("error");
    expect(calls).toHaveLength(5);
    expect(answer.error).toContain("503 Service Unavailable (halaman error HTML)");
    expect(answer.error).not.toContain("<html");
  }, 120_000);

  it("does not retry a 429 for an exhausted quota", async () => {
    const { answer, calls } = await chatWith("quota-429");
    expect(answer.status).toBe("error");
    expect(calls).toHaveLength(1);
    expect(answer.error).toMatch(/quota/i);
  });

  it("keeps the limit on the endpoint", async () => {
    const { ep } = await chatWith("echo", 12);
    expect(ep.rateLimitRpm).toBe(12);
    const patched = await ctx.json<EndpointDto>(`/api/endpoints/${ep.id}`, { method: "PATCH", body: JSON.stringify({ rateLimitRpm: null }) });
    expect(patched.rateLimitRpm).toBeNull();
  });
});
