import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EndpointDto, LibraryResponse, ModelDto, ModelListResponse, RunEvent, SearchResponse, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { zipSync } from "fflate";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { makePng } from "./testing/mockImages.js";
import { startMockProvider, type MockProvider } from "./testing/mockProvider.js";

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
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });

let endpoint: EndpointDto | null = null;
async function model(modelId: string, override: Record<string, unknown> = {}, kind?: "image"): Promise<ModelDto> {
  endpoint ??= null;
  const ep = await ctx.json<EndpointDto>("/api/endpoints", post({ name: `Mock ${modelId}`, presetId: "custom", protocol: "openai-chat", baseUrl: `${mock.url}/v1`, auth: { type: "bearer" }, apiKey: "sk-test-feat-0001" }));
  await ctx.json(`/api/endpoints/${ep.id}/models`, post({ modelId, ...(kind ? { kind } : {}) }));
  const m = (await ctx.json<ModelListResponse>("/api/models")).models.find((x) => x.endpointId === ep.id && x.modelId === modelId)!;
  return Object.keys(override).length ? ctx.json<ModelDto>(`/api/models/${m.id}`, patch({ override })) : m;
}

async function attach(bytes: Buffer, name: string): Promise<{ id: string; attachmentKind: string }> {
  const res = await ctx.req("/api/attachments", { method: "POST", body: bytes, headers: { "x-file-name": encodeURIComponent(name), "content-type": "application/octet-stream" } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; attachmentKind: string };
}

/** A one-page PDF; with `text` it has a text layer, without it the page only has a drawn rectangle. */
function makePdf(text?: string): Buffer {
  const content = text ? `BT /F1 18 Tf 72 720 Td (${text}) Tj ET` : "0 0 1 rg 100 100 300 300 re f";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

function makeDocx(text: string): Buffer {
  const enc = new TextEncoder();
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
      "_rels/.rels": enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": enc.encode(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
    }),
  );
}

const lastChatBody = () => JSON.stringify(mock.requests.filter((r) => r.path.endsWith("/chat/completions")).at(-1)!.body);

describe("search and rename", () => {
  it("finds threads by title and by message text, and renames", async () => {
    const m = await model("echo");
    const t1 = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    await collectRun(ctx, (await ctx.json<SendMessageResponse>(`/api/threads/${t1.id}/messages`, post({ text: "Resep rendang padang yang pedas", modelId: m.id }))).runId);
    const t2 = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    await ctx.json(`/api/threads/${t2.id}`, patch({ title: "Rencana liburan Bali" }));

    const byText = await ctx.json<SearchResponse>(`/api/search?q=${encodeURIComponent("RENDANG")}`);
    expect(byText.hits.some((h) => h.threadId === t1.id && h.match.toLowerCase() === "rendang")).toBe(true);
    const byTitle = await ctx.json<SearchResponse>(`/api/search?q=bali`);
    expect(byTitle.hits[0]).toMatchObject({ threadId: t2.id, in: "title", title: "Rencana liburan Bali" });
    expect((await ctx.json<SearchResponse>("/api/search?q=a")).hits).toEqual([]);
    // LIKE wildcards are matched literally.
    expect((await ctx.json<SearchResponse>(`/api/search?q=${encodeURIComponent("%%")}`)).hits).toEqual([]);
  });
});

describe("groups and archive", () => {
  it("a group exists while a thread is in it; archived threads list separately and come back", async () => {
    const m = await model("echo");
    const a = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const b = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    await ctx.json(`/api/threads/${a.id}`, patch({ group: "Light novel" }));
    type L = { threads: { id: string; group: string | null; archived: boolean }[] };
    let list = await ctx.json<L>("/api/threads?mode=chat");
    expect(list.threads.find((t) => t.id === a.id)!.group).toBe("Light novel");
    expect(list.threads.find((t) => t.id === b.id)!.group).toBeNull();

    await ctx.json(`/api/threads/${a.id}`, patch({ group: null }));
    list = await ctx.json<L>("/api/threads?mode=chat");
    expect(list.threads.every((t) => t.group === null)).toBe(true);

    await ctx.json(`/api/threads/${b.id}`, patch({ archived: true }));
    list = await ctx.json<L>("/api/threads?mode=chat");
    expect(list.threads.map((t) => t.id)).toEqual([a.id]);
    const arch = await ctx.json<L>("/api/threads?mode=chat&archived=1");
    expect(arch.threads).toMatchObject([{ id: b.id, archived: true }]);
    await ctx.json(`/api/threads/${b.id}`, patch({ archived: false }));
    expect((await ctx.json<L>("/api/threads?mode=chat")).threads).toHaveLength(2);

    expect((await ctx.req(`/api/threads/${b.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await ctx.req(`/api/threads/${b.id}`)).status).toBe(404);
  });
});

describe("library", () => {
  it("lists generated images with their prompt, filters, and keeps favourites", async () => {
    const m = await model("gpt-img", {}, "image");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "image", modelId: m.id }));
    const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/images`, post({ text: "kucing oranye di jendela", modelId: m.id, params: { n: 2 } }));
    await collectRun(ctx, res.runId);
    const lib = await ctx.json<LibraryResponse>("/api/library");
    expect(lib.total).toBe(2);
    expect(lib.items[0]).toMatchObject({ threadId: t.id, mode: "image", prompt: "kucing oranye di jendela", favorite: false });
    expect(lib.models.length).toBe(1);

    await ctx.json(`/api/assets/${lib.items[0]!.assetId}`, patch({ favorite: true }));
    expect((await ctx.json<LibraryResponse>("/api/library?favorite=1")).items.map((i) => i.assetId)).toEqual([lib.items[0]!.assetId]);
    expect((await ctx.json<LibraryResponse>("/api/library?q=anjing")).total).toBe(0);
    expect((await ctx.json<LibraryResponse>("/api/library?mode=edit")).total).toBe(0);
  });
});

describe("attachments", () => {
  it("text, PDF with text and DOCX go to the model as text", async () => {
    const m = await model("echo");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const txt = await attach(Buffer.from("isi catatan rapat"), "catatan.md");
    const pdf = await attach(makePdf("Halo dari PDF dengan teks yang cukup panjang untuk dibaca"), "laporan.pdf");
    const docx = await attach(makeDocx("Isi dokumen Word"), "surat.docx");
    expect([txt.attachmentKind, pdf.attachmentKind, docx.attachmentKind]).toEqual(["text", "pdf", "docx"]);

    const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "ringkas", modelId: m.id, attachments: [txt.id, pdf.id, docx.id] }));
    await collectRun(ctx, res.runId);
    const body = lastChatBody();
    expect(body).toContain('<attachment name=\\"catatan.md\\">');
    expect(body).toContain("isi catatan rapat");
    expect(body).toContain("Halo dari PDF");
    expect(body).toContain("Isi dokumen Word");
    expect(body).not.toContain("image_url");
    const thread = await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`);
    expect(thread.messages[0]!.parts.filter((p) => p.type === "file")).toHaveLength(3);
  });

  it("refuses files it cannot read", async () => {
    const res = await ctx.req("/api/attachments", { method: "POST", body: Buffer.from([0, 1, 2, 3, 255, 0]), headers: { "x-file-name": "x.bin" } });
    expect(res.status).toBe(415);
  });

  it("an image goes to a vision model when the chosen one cannot see images", async () => {
    const textOnly = await model("echo");
    const vision = await model("seer", { inputModalities: ["text", "image"] });
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: textOnly.id }));
    const img = await attach(makePng(3), "foto.png");
    expect(img.attachmentKind).toBe("image");
    const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "apa ini?", modelId: textOnly.id, attachments: [img.id] }));
    const events = await collectRun(ctx, res.runId);
    const req = mock.requests.filter((r) => r.path.endsWith("/chat/completions")).at(-1)!;
    expect(req.body!.model).toBe("seer");
    expect(JSON.stringify(req.body)).toContain("data:image/png;base64,");
    expect(events.some((e) => e.type === "note" && e.text.includes("tidak menerima gambar"))).toBe(true);
    // The thread keeps the owner's model.
    expect((await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`)).modelId).toBe(textOnly.id);
    void vision;
  });

  it("a scanned PDF (no text layer) is sent as page images", async () => {
    const vision = await model("seer", { inputModalities: ["text", "image"] });
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: vision.id }));
    const pdf = await attach(makePdf(), "scan.pdf");
    const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "baca", modelId: vision.id, attachments: [pdf.id] }));
    await collectRun(ctx, res.runId);
    expect(lastChatBody()).toContain("data:image/png;base64,");
    const parts = (await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`)).messages[0]!.parts;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
    expect(parts.find((p) => p.type === "file")).toMatchObject({ note: expect.stringContaining("hasil scan") });
  });
});

describe("messages during a run", () => {
  it("a message sent while the agent works joins after the current step and gets answered", async () => {
    const m = await model("agent-midrun", { tools: true });
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "agent", workspace: ws, modelId: m.id }));
    const first = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "mulai", modelId: m.id }));
    // The shell call waits for approval: the run is busy.
    const started = Date.now();
    let approval: Extract<RunEvent, { type: "approval" }> | undefined;
    while (!approval && Date.now() - started < 10_000) {
      approval = ctx.services.runs.snapshot(first.runId, 0)?.events.find((e): e is Extract<RunEvent, { type: "approval" }> => e.type === "approval");
      await new Promise((r) => setTimeout(r, 20));
    }
    const queued = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "ini pesan tambahan", modelId: m.id }));
    expect(queued).toMatchObject({ runId: first.runId, queued: true });
    await ctx.json(`/api/runs/${first.runId}/approvals/${approval!.approvalId}`, post({ decision: "allow" }));
    const events = await collectRun(ctx, first.runId);
    expect(events.some((e) => e.type === "user_message" && e.text === "ini pesan tambahan")).toBe(true);

    const roles = (await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`)).messages.map((x) => x.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    const last = (await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`)).messages.at(-1)!;
    expect(last.parts.find((p) => p.type === "text")).toMatchObject({ text: "Diterima: ini pesan tambahan" });
  });

  it("Chat with Web on searches through the tool loop without asking", async () => {
    process.env.EZCLAW_DDG_URL = `${mock.url}/ddg`;
    try {
      const m = await model("agent-search", { tools: true });
      const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
      const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "cari ezclaw", modelId: m.id, web: true }));
      expect(res.assistantMessageId).toBeNull();
      const events = await collectRun(ctx, res.runId);
      expect(events.some((e) => e.type === "approval")).toBe(false);
      const last = (await ctx.json<ThreadDetailDto>(`/api/threads/${t.id}`)).messages.at(-1)!;
      expect(JSON.stringify(last.parts)).toContain("https://ezclaw.dev/docs");
      const first = mock.requests.find((r) => r.path.endsWith("/chat/completions"))!;
      const tools = (first.body!.tools as { function: { name: string } }[]).map((x) => x.function.name);
      expect(tools).toEqual(["web_search", "web_fetch"]);
      expect(JSON.stringify(first.body!.messages)).toContain("Web search is on");
    } finally {
      delete process.env.EZCLAW_DDG_URL;
    }
  });

  it("Chat without Web stays a plain answer", async () => {
    const m = await model("echo");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "halo", modelId: m.id }));
    expect(res.assistantMessageId).not.toBeNull();
  });

  it("Experiential Labs: the key's models come with facts from the public catalog", async () => {
    const ep = await ctx.json<EndpointDto>("/api/endpoints", post({ name: "Experiential Labs", presetId: "experiential", protocol: "openai-chat", baseUrl: `${mock.url}/explabs/v1`, auth: { type: "bearer" }, apiKey: "xpl_0123456789abcdef0123456789abcdef01234567" }));
    const test = await ctx.json<{ ok: boolean; modelCount: number }>(`/api/endpoints/${ep.id}/test`, post({}));
    expect(test).toMatchObject({ ok: true, modelCount: 3 });
    const mine = (await ctx.json<ModelListResponse>("/api/models")).models.filter((m) => m.endpointId === ep.id);
    const opus = mine.find((m) => m.modelId === "claude-opus-5.5")!;
    expect(opus).toMatchObject({ kind: "text", name: "Claude Opus 5.5" });
    expect(opus.summary).toMatchObject({ tools: true, reasoning: true, contextLength: 1000000 });
    expect(opus.summary.inputModalities).toContain("image");
    expect(mine.find((m) => m.modelId === "text-embedding-3-small")!.kind).toBe("other");
    const auth = mock.requests.find((r) => r.path === "/explabs/v1/models")!.headers.authorization;
    expect(auth).toBe("Bearer xpl_0123456789abcdef0123456789abcdef01234567");
  });

  it("a plain chat answer still refuses a second message", async () => {
    const m = await model("slow");
    const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId: m.id }));
    const first = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text: "halo", modelId: m.id }));
    const second = await ctx.req(`/api/threads/${t.id}/messages`, post({ text: "lagi", modelId: m.id }));
    expect(second.status).toBe(409);
    await ctx.req(`/api/runs/${first.runId}/stop`, { method: "POST" });
    await collectRun(ctx, first.runId);
  });
});
