import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { agentAnthropic, agentChat, agentResponses } from "./agentStreams.js";
import { SCRIPTS } from "./agentScripts.js";
import { handleImageRoute, imageChatResponse } from "./mockImages.js";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
  /** The body as received, for requests that are not JSON (multipart uploads). */
  raw?: string;
}

export interface MockProvider {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MARKDOWN_DOC = [
  "## Ringkasan",
  "",
  "Berikut contoh **jawaban** dengan `kode` inline dan tabel.",
  "",
  "| Provider | Reasoning |",
  "|---|---|",
  "| DeepSeek | `thinking` |",
  "| OpenRouter | `reasoning` |",
  "",
  "```ts",
  "export function tambah(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "```",
  "",
  "Rumus: $E = mc^2$ dan blok:",
  "",
  String.raw`$$\int_0^1 x^2\,dx = \tfrac{1}{3}$$`,
  "",
  "![pelacak](https://example.com/pixel.png?q=rahasia)",
  "",
  "- butir satu",
  "- butir dua",
  "",
  "> kutipan penutup",
  "",
].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A stand-in for provider APIs. The model name in the request picks the behaviour, so tests
 * can ask for reasoning, a rejected parameter, a slow stream, or an auth failure by name.
 */
export async function startMockProvider(port = 0): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const raw = await readBody(req);
    let body: Record<string, unknown> | null = null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    requests.push({ method: req.method ?? "", path, headers: req.headers, body, raw });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const sse = () => res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (data: unknown) => res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (handleImageRoute({ req, res, path, body, raw, origin })) return;

    if (req.method === "GET" && path === "/v1/models") {
      return json(200, { object: "list", data: [{ id: "echo" }, { id: "think" }, { id: "tags" }, { id: "reject-top_p" }, { id: "slow" }, { id: "midfail" }, { id: "markdown" }, { id: "composer-json" }, ...Object.keys(SCRIPTS).map((id) => ({ id }))] });
    }
    if (req.method === "GET" && path === "/v1/models-401") return json(401, { error: { message: "Invalid API key" } });
    if (req.method === "GET" && path === "/anthropic/v1/models") {
      return json(200, { data: [{ id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: true } } }, effort: { low: { supported: true }, high: { supported: true } } } }], has_more: false });
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      const model = String(body?.model ?? "");
      if (model in SCRIPTS) return agentChat(res, body ?? {});
      if (model === "img-chat") {
        const r = imageChatResponse(body ?? {}, raw);
        return json(r.status, r.payload);
      }
      if (model === "unauthorized") return json(401, { error: { message: "Incorrect API key provided: sk-...", code: "invalid_api_key" } });
      if (model === "reject-top_p" && body && "top_p" in body) {
        return json(400, { error: { message: "Unsupported parameter: 'top_p' is not supported with this model.", param: "top_p", code: "unsupported_parameter" } });
      }
      if (model === "json-only") {
        return json(200, { choices: [{ message: { role: "assistant", content: "balasan tanpa stream", reasoning_content: "mikir dulu" } }] });
      }
      sse();
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

      if (model === "think") {
        send(chunk({ reasoning_content: "Saya " }));
        send(chunk({ reasoning_content: "berpikir." }));
        send(chunk({ content: "Jawaban " }));
        send(chunk({ content: "akhir." }, "stop"));
        send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 } } });
      } else if (model === "composer-json") {
        send(chunk({ role: "assistant", content: '{"prompt": "a red cat at night, ' }));
        send(chunk({ content: 'street lamps", "use_last_image": true}' }, "stop"));
      } else if (model === "tags") {
        send(chunk({ content: "<thi" }));
        send(chunk({ content: "nk>diam-diam</th" }));
        send(chunk({ content: "ink>terlihat" }, "stop"));
      } else if (model === "markdown") {
        const doc = MARKDOWN_DOC;
        send(chunk({ reasoning_content: "Menyusun jawaban markdown." }));
        for (let i = 0; i < doc.length && !res.destroyed; i += 7) {
          send(chunk({ content: doc.slice(i, i + 7) }));
          await sleep(15);
        }
        send(chunk({}, "stop"));
        send({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 80, cost: 0.00042 } });
      } else if (model === "slow") {
        for (let i = 0; i < 200 && !res.destroyed; i++) {
          send(chunk({ content: `kata${i} ` }));
          await sleep(60);
        }
        send(chunk({}, "stop"));
      } else if (model === "midfail") {
        send(chunk({ content: "setengah " }));
        send({ error: { message: "upstream exploded", code: 502 } });
      } else {
        send(chunk({ role: "assistant", content: "Halo " }));
        send(chunk({ content: "dunia" }, "stop"));
        send({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
      }
      send("[DONE]");
      return res.end();
    }

    if (req.method === "POST" && path === "/v1/responses") {
      const model = String(body?.model ?? "");
      if (model === "unauthorized") return json(401, { error: { message: "Incorrect API key provided", code: "invalid_api_key" } });
      return agentResponses(res, body ?? {});
    }

    if (req.method === "POST" && path === "/anthropic/v1/messages" && String(body?.model ?? "") in SCRIPTS) {
      if (!req.headers["x-api-key"]) return json(401, { type: "error", error: { type: "authentication_error", message: "x-api-key header is required" } });
      return agentAnthropic(res, body ?? {});
    }

    if (req.method === "POST" && path === "/anthropic/v1/messages") {
      if (!req.headers["x-api-key"]) return json(401, { type: "error", error: { type: "authentication_error", message: "x-api-key header is required" } });
      sse();
      const ev = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`);
      ev("message_start", { message: { usage: { input_tokens: 11 } } });
      ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } });
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Hmm." } });
      ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig123" } });
      ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } });
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Halo dari " } });
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Claude." } });
      ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
      ev("message_stop", {});
      return res.end();
    }

    json(404, { error: { message: `no mock for ${req.method} ${path}` } });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actualPort } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
