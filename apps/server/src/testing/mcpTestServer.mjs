// A small MCP server for tests and the sandbox. `node mcpTestServer.mjs` speaks stdio;
// `node mcpTestServer.mjs --http 9912` serves Streamable HTTP on that port.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { z } from "zod";

// 1x1 red PNG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const notes = [];

function build() {
  const server = new McpServer({ name: "ezclaw-test", version: "1.0.0" }, { instructions: "Test server for EZClaw." });
  server.registerTool(
    "echo",
    { description: "Echo the text back.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
    async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  server.registerTool(
    "write_note",
    { description: "Save a note.", inputSchema: { note: z.string() }, annotations: { destructiveHint: false } },
    async ({ note }) => {
      notes.push(note);
      return { content: [{ type: "text", text: `saved ${notes.length}: ${note}` }] };
    },
  );
  server.registerTool("red_dot", { description: "Return a tiny image.", inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({
    content: [
      { type: "text", text: "here is a dot" },
      { type: "image", data: PNG, mimeType: "image/png" },
    ],
  }));
  server.registerTool("fail", { description: "Always fails.", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "nope" }], isError: true }));
  server.registerPrompt(
    "summarize",
    { description: "Summarize a topic.", argsSchema: { topic: z.string() } },
    ({ topic }) => ({ messages: [{ role: "user", content: { type: "text", text: `Please summarize ${topic} in three bullet points.` } }] }),
  );
  server.registerResource("readme", "test://readme", { description: "Read me", mimeType: "text/plain" }, async (uri) => ({ contents: [{ uri: uri.href, text: "Resource text from the test server." }] }));
  return server;
}

const httpAt = process.argv.indexOf("--http");
if (httpAt >= 0) {
  const port = Number(process.argv[httpAt + 1] ?? 9912);
  const token = process.env.MCP_TEST_TOKEN;
  createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // Stateless: a fresh server and transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = build();
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined));
  }).listen(port, "127.0.0.1", () => process.stdout.write(`listening ${port}\n`));
} else {
  process.stderr.write("test server starting\n");
  await build().connect(new StdioServerTransport());
}
