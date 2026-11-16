import type { IncomingMessage, ServerResponse } from "node:http";

/** A tiny buffer that starts like an MP4 file ("ftyp" box), enough for EZClaw's check. */
export const FAKE_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(64, 1)]);

/** A real clip a browser test can hand over (base64), served instead of FAKE_MP4 so a player can show it. */
let fixture: Buffer | null = null;
const polls = new Map<string, number>();
let counter = 0;
let holdSlow = true;

/** Lets "lambat" jobs finish (tests that restart EZClaw while a job runs). */
export function releaseSlowJobs(release = true) {
  holdSlow = !release;
}

/**
 * Video job APIs of Venice, xAI and OpenRouter. Each job answers "still working" on the first poll and is
 * done on the second. A prompt containing "gagal" makes the job fail; "lambat" keeps it working for a long time.
 */
export function handleVideoRoute(ctx: { req: IncomingMessage; res: ServerResponse; path: string; body: Record<string, unknown> | null; origin: string }): boolean {
  const { req, res, path, body, origin } = ctx;
  const method = req.method ?? "";
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const mp4 = () => {
    const bytes = fixture ?? FAKE_MP4;
    res.writeHead(200, { "content-type": "video/mp4", "content-length": String(bytes.length) });
    res.end(bytes);
  };
  if (method === "POST" && path === "/fixture/video") {
    fixture = typeof body?.b64 === "string" ? Buffer.from(body.b64, "base64") : null;
    res.writeHead(204, { "access-control-allow-origin": "*" });
    res.end();
    return true;
  }
  if (method === "OPTIONS" && path === "/fixture/video") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" });
    res.end();
    return true;
  }
  const newJob = (prefix: string) => {
    const prompt = String(body?.prompt ?? "");
    const id = `${prefix}-${++counter}${prompt.includes("gagal") ? "-fail" : prompt.includes("lambat") ? "-slow" : ""}`;
    polls.set(id, 0);
    return id;
  };
  const poll = (id: string) => {
    const n = (polls.get(id) ?? 0) + 1;
    polls.set(id, n);
    return { n, fail: id.endsWith("-fail"), slow: id.endsWith("-slow") && holdSlow };
  };

  /* ---- Venice ---- */
  if (method === "POST" && path === "/venice/api/v1/video/quote") return json(200, { quote: 0.123 }), true;
  if (method === "POST" && path === "/venice/api/v1/video/complete") return json(200, { success: true }), true;
  if (method === "POST" && path === "/venice/api/v1/video/queue") {
    if (!body?.duration) return json(400, { error: "duration is required" }), true;
    return json(200, { model: body.model, queue_id: newJob("q") }), true;
  }
  if (method === "POST" && path === "/venice/api/v1/video/retrieve") {
    const id = String(body?.queue_id ?? "");
    if (!polls.has(id)) return json(400, { error: "unknown queue_id" }), true;
    const p = poll(id);
    if (p.fail) return json(422, { error: { message: "Prompt violates content policy", type: "provider_content_policy" } }), true;
    if (p.n < 2 || p.slow) return json(200, { status: "PROCESSING", average_execution_time: 60000, execution_duration: 30000 }), true;
    return mp4(), true;
  }

  /* ---- xAI ---- */
  if (method === "POST" && path === "/v1/videos/generations") return json(200, { request_id: newJob("x") }), true;
  const xai = /^\/v1\/videos\/([^/]+)$/.exec(path);
  if (method === "GET" && xai) {
    const id = decodeURIComponent(xai[1]!);
    if (!polls.has(id)) return json(404, { error: "not found" }), true;
    const p = poll(id);
    if (p.fail) return json(200, { status: "failed", error: { code: "invalid_argument", message: "Gambar ditolak" } }), true;
    if (p.n < 2 || p.slow) return json(200, { status: "pending", progress: 40 }), true;
    return json(200, { status: "done", progress: 100, model: "grok-imagine-video", video: { url: `${origin}/files/${id}.mp4`, duration: 8, respect_moderation: true }, usage: { cost_in_usd_ticks: 5_000_000_000 } }), true;
  }
  if (method === "GET" && /^\/files\/[^/]+\.mp4$/.test(path)) return mp4(), true;

  /* ---- OpenRouter ---- */
  if (method === "GET" && path === "/or/api/v1/models") {
    return json(200, { data: [{ id: "or/text", name: "OR Text", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, supported_parameters: [] }] }), true;
  }
  if (method === "GET" && path === "/or/api/v1/videos/models") {
    return json(200, {
      data: [
        { id: "google/veo-mock", name: "Veo Mock", supported_durations: [4, 8], supported_resolutions: ["720p", "1080p"], supported_aspect_ratios: ["16:9", "9:16"], supported_frame_images: ["first_frame", "last_frame"], generate_audio: true, seed: true, pricing_skus: { "per-video-second": "0.40" } },
        { id: "text/only-video", name: "Text Only", supported_durations: [5], supported_resolutions: ["720p"], supported_aspect_ratios: ["16:9"], supported_frame_images: null, generate_audio: false, seed: null },
      ],
    }), true;
  }
  if (method === "POST" && path === "/or/api/v1/videos") {
    const id = newJob("gen-vid");
    return json(202, { id, polling_url: `/api/v1/videos/${id}`, status: "pending" }), true;
  }
  const orContent = /^\/or\/api\/v1\/videos\/([^/]+)\/content$/.exec(path);
  if (method === "GET" && orContent) {
    if (!req.headers.authorization) return json(401, { error: { message: "No auth" } }), true;
    return mp4(), true;
  }
  const or = /^\/or\/api\/v1\/videos\/([^/]+)$/.exec(path);
  if (method === "GET" && or) {
    const id = decodeURIComponent(or[1]!);
    if (!polls.has(id)) return json(404, { error: { message: "not found" } }), true;
    const p = poll(id);
    if (p.fail) return json(200, { id, status: "failed", error: "Provider rejected the request" }), true;
    if (p.n < 2 || p.slow) return json(200, { id, status: "in_progress" }), true;
    return json(200, { id, status: "completed", unsigned_urls: [`${origin}/or/api/v1/videos/${id}/content?index=0`], usage: { cost: 0.5, is_byok: false } }), true;
  }
  return false;
}
