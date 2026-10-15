import type { IncomingMessage, ServerResponse } from "node:http";
import { crc32, deflateSync } from "node:zlib";

/** A small valid PNG whose colours depend on `seed`, so different results look different. */
export function makePng(seed: number, size = 48): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = (seed * 53 + x * 4) & 255;
      row[2 + x * 3] = (seed * 97 + y * 4) & 255;
      row[3 + x * 3] = (seed * 29 + ((x + y) * 2)) & 255;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const b64 = (seed: number) => makePng(seed).toString("base64");

export interface ImageMockCtx {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  body: Record<string, unknown> | null;
  raw: string;
  origin: string;
}

interface Task {
  polls: number;
  seed: number;
}

const tasks = new Map<string, Task>();
let counter = 100;

function failing(ctx: ImageMockCtx): boolean {
  return ctx.raw.includes("GAGAL");
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function rejected(ctx: ImageMockCtx) {
  json(ctx.res, 400, { error: { message: "Prompt ditolak oleh filter mock.", code: "content_policy" } });
}

/** Returns true when the request was an image route and has been answered. */
export function handleImageRoute(ctx: ImageMockCtx): boolean {
  const { req, res, path, body, raw } = ctx;
  const method = req.method ?? "";

  // OpenAI Images: generations (JSON) and edits (multipart).
  if (method === "POST" && path === "/v1/images/generations") {
    if (failing(ctx)) return rejected(ctx), true;
    const n = Number(body?.n ?? 1);
    json(res, 200, { created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: b64(counter++ + i) })) });
    return true;
  }
  if (method === "POST" && path === "/v1/images/edits") {
    if (failing(ctx)) return rejected(ctx), true;
    const n = Number(/name="n"\r\n\r\n(\d+)/.exec(raw)?.[1] ?? 1);
    json(res, 200, { created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: b64(counter++ + i) })) });
    return true;
  }

  // OpenRouter's dedicated image endpoint.
  if (method === "POST" && path === "/or/api/v1/images") {
    if (failing(ctx)) return rejected(ctx), true;
    const n = Number(body?.n ?? 1);
    json(res, 200, { created: 1, data: Array.from({ length: n }, (_, i) => ({ b64_json: b64(counter++ + i), media_type: "image/png" })), usage: { cost: 0.04 } });
    return true;
  }

  // Venice: generate returns JSON, edit returns the image bytes.
  if (method === "POST" && path === "/venice/api/v1/image/generate") {
    if (failing(ctx)) return rejected(ctx), true;
    const n = Number(body?.variants ?? 1);
    json(res, 200, { id: "generate-1", images: Array.from({ length: n }, (_, i) => b64(counter++ + i)) });
    return true;
  }
  if (method === "POST" && path === "/venice/api/v1/image/edit") {
    if (failing(ctx)) return rejected(ctx), true;
    const png = makePng(counter++);
    res.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) });
    res.end(png);
    return true;
  }

  // DashScope: submit a task, poll it, download the result.
  if (method === "POST" && path === "/dash/api/v1/services/aigc/text2image/image-synthesis") {
    if (req.headers["x-dashscope-async"] !== "enable") {
      json(res, 403, { code: "AccessDenied", message: "current user api does not support synchronous calls" });
      return true;
    }
    if (failing(ctx)) return rejected(ctx), true;
    const id = `task-${counter++}`;
    tasks.set(id, { polls: 0, seed: counter });
    json(res, 200, { output: { task_status: "PENDING", task_id: id }, request_id: "r1" });
    return true;
  }
  const poll = /^\/dash\/api\/v1\/tasks\/([^/]+)$/.exec(path);
  if (method === "GET" && poll) {
    const task = tasks.get(poll[1]!);
    if (!task) {
      json(res, 404, { code: "InvalidParameter", message: "task not found" });
      return true;
    }
    task.polls++;
    if (task.polls < 2) json(res, 200, { output: { task_id: poll[1], task_status: "RUNNING" } });
    else json(res, 200, { output: { task_id: poll[1], task_status: "SUCCEEDED", results: [{ url: `${ctx.origin}/dash/img/${task.seed}.png` }] }, usage: { image_count: 1 } });
    return true;
  }
  const img = /^\/dash\/img\/(\d+)\.png$/.exec(path);
  if (method === "GET" && img) {
    const png = makePng(Number(img[1]));
    res.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) });
    res.end(png);
    return true;
  }

  return false;
}

/** Chat completion for the `img-chat` model: an image comes back inside the assistant message. */
export function imageChatResponse(body: Record<string, unknown>, raw: string): { status: number; payload: unknown } {
  if (raw.includes("GAGAL")) return { status: 400, payload: { error: { message: "Prompt ditolak oleh filter mock.", code: "content_policy" } } };
  return {
    status: 200,
    payload: {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Ini gambarnya.",
            images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64(counter++)}` } }],
          },
        },
      ],
      echoModalities: body.modalities ?? null,
    },
  };
}
