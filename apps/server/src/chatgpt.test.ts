import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EndpointDto, EndpointListResponse, ModelListResponse, ModelDto, SendMessageResponse, ThreadDetailDto } from "@ezclaw/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collectRun, createTestContext, type TestContext } from "./testing/harness.js";
import { agentResponses } from "./testing/agentStreams.js";

/** A stand-in for auth.openai.com and api.openai.com, enough for Sign in with ChatGPT. */
interface FakeOpenAI {
  url: string;
  /** Access tokens issued so far, newest last. */
  issued: string[];
  refreshes: number;
  revoked: string[];
  expiresIn: number;
  failNextInference: { status: number; code: string } | null;
  responses: { auth: string | undefined; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key";

function idToken(iss: string, aud: string, nonce: string): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: KID, typ: "JWT" });
  const body = enc({ iss, aud, nonce, sub: "user-1", email: "pemilik@example.com", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function startFake(): Promise<FakeOpenAI> {
  const challenges = new Map<string, { challenge: string; nonce: string }>();
  const fake = { issued: [] as string[], refreshes: 0, revoked: [] as string[], expiresIn: 3600, failNextInference: null, responses: [] } as unknown as FakeOpenAI;
  let refreshToken = "rt-1";
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const text = await readBody(req);
    if (url.pathname === "/.well-known/jwks.json") return json(res, 200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] });
    if (url.pathname === "/.well-known/openid-configuration") return json(res, 200, { issuer: fake.url, revocation_endpoint: `${fake.url}/oauth/revoke` });
    if (url.pathname === "/oauth/revoke") {
      fake.revoked.push(new URLSearchParams(text).get("token") ?? "");
      return json(res, 200, {});
    }
    if (url.pathname === "/test/authorize") {
      // What the browser would do: remember the PKCE challenge for the code it hands back.
      challenges.set("code-1", { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce")! });
      return json(res, 200, {});
    }
    if (url.pathname === "/api/accounts/oauth/token") {
      const form = new URLSearchParams(text);
      if (form.get("grant_type") === "authorization_code") {
        const c = challenges.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!c || createHash("sha256").update(verifier).digest("base64url") !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE gagal" });
        if (form.get("client_id") !== "oaiapp_issued" || form.get("resource") !== "https://api.openai.com/v1") return json(res, 400, { error: "invalid_client" });
      } else if (form.get("grant_type") === "refresh_token") {
        if (form.get("refresh_token") !== refreshToken) return json(res, 400, { error: "refresh_token_reused" });
        fake.refreshes++;
      }
      refreshToken = `rt-${fake.issued.length + 2}`;
      const access = `at-${fake.issued.length + 1}-${"x".repeat(1500)}`;
      fake.issued.push(access);
      const nonce = [...challenges.values()].at(-1)?.nonce ?? "";
      return json(res, 200, {
        access_token: access,
        refresh_token: refreshToken,
        id_token: idToken(fake.url, "oaiapp_issued", nonce),
        token_type: "Bearer",
        expires_in: fake.expiresIn,
        scope: "chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
      });
    }
    if (url.pathname === "/v1/models") {
      return json(res, 200, { models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }, { slug: "internal", visibility: "hide" }] });
    }
    if (url.pathname === "/v1/responses") {
      const body = JSON.parse(text) as Record<string, unknown>;
      fake.responses.push({ auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${fake.issued.at(-1)}`) return json(res, 401, { error: { message: "token lama", code: "subscription_sharing_invalid_user" } });
      if (fake.failNextInference) {
        const f = fake.failNextInference;
        fake.failNextInference = null;
        return json(res, f.status, { error: { message: "limit", code: f.code } });
      }
      return agentResponses(res, body);
    }
    json(res, 404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

let fake: FakeOpenAI;
let ctx: TestContext;

beforeAll(async () => {
  fake = await startFake();
});
afterAll(() => fake.close());
beforeEach(() => {
  process.env.EZCLAW_CHATGPT_AUTH_URL = fake.url;
  ctx = createTestContext();
  Object.assign(fake, { issued: [], refreshes: 0, revoked: [], expiresIn: 3600, failNextInference: null, responses: [] });
});
afterEach(async () => {
  delete process.env.EZCLAW_CHATGPT_AUTH_URL;
  await ctx.dispose();
});

const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

async function signedIn(): Promise<{ ep: EndpointDto; model: ModelDto }> {
  const ep = await ctx.json<EndpointDto>("/api/endpoints", post({ name: "ChatGPT", presetId: "chatgpt", protocol: "openai-responses", baseUrl: `${fake.url}/v1`, auth: { type: "bearer" } }));
  expect(ep).toMatchObject({ login: "chatgpt", hasKey: false, signedInAs: null });
  const { url } = await ctx.json<{ url: string }>(`/api/endpoints/${ep.id}/chatgpt/login`, post({}));
  const authorize = new URL(url);
  expect(authorize.pathname).toBe("/api/accounts/authorize");
  expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
    client_id: "dynamic_agent_client",
    agent_name_hint: "EZClaw",
    response_type: "code",
    resource: "https://api.openai.com/v1",
    code_challenge_method: "S256",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
  });
  expect(authorize.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/chatgpt\/oauth\/callback$/);
  expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/);
  await fetch(`${fake.url}/test/authorize?${authorize.searchParams}`);
  const page = await (await ctx.req(`/chatgpt/oauth/callback?code=code-1&state=${authorize.searchParams.get("state")}&client_id=oaiapp_issued`)).text();
  expect(page).toContain("Login ChatGPT berhasil");
  const after = (await ctx.json<EndpointListResponse>("/api/endpoints")).endpoints.find((e) => e.id === ep.id)!;
  expect(after).toMatchObject({ hasKey: true, signedInAs: "pemilik@example.com", modelCount: 1 });
  const model = (await ctx.json<ModelListResponse>("/api/models")).models.find((m) => m.endpointId === ep.id)!;
  return { ep: after, model: model as unknown as ModelDto };
}

async function ask(modelId: string, text = "halo") {
  const t = await ctx.json<ThreadDetailDto>("/api/threads", post({ mode: "chat", modelId }));
  const res = await ctx.json<SendMessageResponse>(`/api/threads/${t.id}/messages`, post({ text, modelId, params: { temperature: 0.5, max_output_tokens: 500 } }));
  const events = await collectRun(ctx, res.runId);
  return { t, events };
}

describe("Sign in with ChatGPT", () => {
  it("signs in with PKCE, lists only listed models, and sends plan requests without forbidden fields", async () => {
    const { model } = await signedIn();
    expect(model.modelId).toBe("gpt-6.1-sol");
    const { events } = await ask(model.id);
    expect(events.some((e) => e.type === "done" || e.type === "text")).toBe(true);
    const sent = fake.responses.at(-1)!;
    expect(sent.auth).toBe(`Bearer ${fake.issued.at(-1)}`);
    expect(sent.body.store).toBe(false);
    expect(sent.body.stream).toBe(true);
    for (const key of ["temperature", "top_p", "max_output_tokens"]) expect(sent.body).not.toHaveProperty(key);
    expect(events.some((e) => e.type === "note" && e.text.includes("temperature tidak dikirim"))).toBe(true);
  });

  it("refreshes a token close to expiry once, and the rotated refresh token keeps working", async () => {
    fake.expiresIn = 60;
    const { model } = await signedIn();
    await ask(model.id);
    await ask(model.id);
    // The model list after sign-in, then each answer: every one starts with a fresh token.
    expect(fake.refreshes).toBe(3);
    const used = fake.responses.map((r) => r.auth);
    expect(new Set(used).size).toBe(2);
    expect(used.every((a) => fake.issued.some((t) => a === `Bearer ${t}`))).toBe(true);
  });

  it("refreshes and resends once when OpenAI refuses the access token", async () => {
    const { model } = await signedIn();
    fake.issued.push("at-bumped-by-openai");
    const { events } = await ask(model.id);
    expect(fake.refreshes).toBe(1);
    expect(fake.responses).toHaveLength(2);
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "complete" });
  });

  it("stops with a plain message when the plan's usage is spent, without retrying", async () => {
    const { model } = await signedIn();
    fake.failNextInference = { status: 429, code: "subscription_sharing_usage_limit_exceeded" };
    const { events } = await ask(model.id);
    expect(fake.responses).toHaveLength(1);
    expect(events.find((e) => e.type === "done")).toMatchObject({ status: "error", error: expect.stringContaining("Batas pemakaian plan ChatGPT") });
  });

  it("signs out: revokes the refresh token and the endpoint asks to sign in again", async () => {
    const { ep } = await signedIn();
    const out = await ctx.json<EndpointDto>(`/api/endpoints/${ep.id}/chatgpt/logout`, post({}));
    expect(out).toMatchObject({ signedInAs: null, hasKey: false });
    expect(fake.revoked).toHaveLength(1);
    // A second sign-in reuses the issued client, so no new registration.
    const { url } = await ctx.json<{ url: string }>(`/api/endpoints/${ep.id}/chatgpt/login`, post({}));
    expect(new URL(url).searchParams.get("client_id")).toBe("oaiapp_issued");
  });

  it("refuses a callback that EZClaw did not start", async () => {
    const page = await (await ctx.req("/chatgpt/oauth/callback?code=x&state=bukan-milik-ezclaw")).text();
    expect(page).toContain("Login ChatGPT gagal");
  });
});
