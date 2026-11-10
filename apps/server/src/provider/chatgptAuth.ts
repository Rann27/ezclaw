import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import type { SecretStore } from "../secrets.js";
import { ProviderError } from "./http.js";

/**
 * Sign in with ChatGPT for plan usage: the owner's ChatGPT Plus or Pro plan pays for Responses API
 * requests instead of an API key. OpenAI offers this to open-source and personal local apps.
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * OAuth 2.0 authorization code with PKCE, a public client registered on first sign-in through
 * `dynamic_agent_client`. Tokens live in the secret store, split into chunks because a Windows
 * credential holds at most 2,560 bytes.
 */

const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const APP_NAME = "EZClaw";
/** Refreshes this long before the access token runs out, so a long step never starts with a dying token. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const PENDING_TTL_MS = 15 * 60_000;
const CHUNK = 1000;
/** Refresh answers that mean the grant is gone: the owner signs in again with the same client. */
const TERMINAL_REFRESH = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

interface Session {
  clientId: string;
  refreshToken: string | null;
  accessToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  email: string | null;
  sub: string | null;
}

interface Pending {
  endpointId: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** The client the authorize request named: "dynamic_agent_client" on a first sign-in. */
  clientId: string | null;
  createdAt: number;
}

export class ChatGptAuthError extends Error {}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signed: string; signature: Buffer } {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new ChatGptAuthError("ID token tidak berbentuk JWT.");
  const json = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  return { header: json(h), payload: json(p), signed: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

export class ChatGptAuth {
  private readonly pending = new Map<string, Pending>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private callbackBase = "http://127.0.0.1:8787";

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof fetch,
    /** Overridable for tests; OpenAI's issuer otherwise. */
    private readonly authBase = (process.env.EZCLAW_CHATGPT_AUTH_URL || "https://auth.openai.com").replace(/\/$/, ""),
  ) {}

  setCallbackBase(origin: string) {
    // The redirect must be a 127.0.0.1 loopback address; "localhost" is refused.
    this.callbackBase = origin.replace(/\/$/, "").replace("://localhost", "://127.0.0.1");
  }

  get callbackUrl(): string {
    return `${this.callbackBase}/chatgpt/oauth/callback`;
  }

  /* ------------------------------------------------------------- storage */

  private putLarge(id: string, value: string | null) {
    const old = Number(this.secrets.get(id) ?? "0");
    for (let i = 0; i < old; i++) this.secrets.delete(`${id}#${i}`);
    if (value === null) {
      this.secrets.delete(id);
      return;
    }
    const parts = Math.max(1, Math.ceil(value.length / CHUNK));
    for (let i = 0; i < parts; i++) this.secrets.set(`${id}#${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    this.secrets.set(id, String(parts));
  }

  private getLarge(id: string): string | null {
    const parts = Number(this.secrets.get(id) ?? "0");
    if (!parts) return null;
    const out: string[] = [];
    for (let i = 0; i < parts; i++) {
      const part = this.secrets.get(`${id}#${i}`);
      if (part === null) return null;
      out.push(part);
    }
    return out.join("");
  }

  private session(endpointId: string): Session | null {
    const raw = this.getLarge(`chatgpt:${endpointId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  private save(endpointId: string, s: Session) {
    this.putLarge(`chatgpt:${endpointId}`, JSON.stringify(s));
  }

  /** One random id per EZClaw install, sent on every sign-in. */
  private hostId(): string {
    const existing = this.secrets.get("chatgpt:host-id");
    if (existing) return existing;
    const id = `urn:uuid:${randomUUID()}`;
    this.secrets.set("chatgpt:host-id", id);
    return id;
  }

  signedInAs(endpointId: string): string | null {
    const s = this.session(endpointId);
    return s?.refreshToken ? (s.email ?? "akun ChatGPT") : null;
  }

  hasSession(endpointId: string): boolean {
    return !!this.session(endpointId)?.refreshToken;
  }

  /* ------------------------------------------------------------- sign-in */

  /** The page the owner opens in the browser to sign in. */
  start(endpointId: string): string {
    const now = Date.now();
    for (const [state, p] of this.pending) if (now - p.createdAt > PENDING_TTL_MS) this.pending.delete(state);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const nonce = b64url(randomBytes(16));
    const known = this.session(endpointId);
    const url = new URL(`${this.authBase}/api/accounts/authorize`);
    const q = url.searchParams;
    q.set("client_id", known?.clientId ?? "dynamic_agent_client");
    if (!known?.clientId) q.set("agent_name_hint", APP_NAME);
    q.set("ext_agent_host_id", this.hostId());
    if (known?.email) q.set("login_hint", known.email);
    q.set("response_type", "code");
    q.set("redirect_uri", this.callbackUrl);
    q.set("scope", SCOPES);
    q.set("resource", RESOURCE);
    q.set("state", state);
    q.set("nonce", nonce);
    q.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    q.set("code_challenge_method", "S256");
    this.pending.set(state, { endpointId, verifier, nonce, redirectUri: this.callbackUrl, clientId: known?.clientId ?? null, createdAt: now });
    return url.toString();
  }

  /** Finishes a sign-in this EZClaw started. Returns the endpoint it belongs to. */
  async finish(state: string, code: string, issuedClientId: string | null): Promise<{ endpointId: string; email: string | null }> {
    const p = this.pending.get(state);
    if (!p) throw new ChatGptAuthError("Login ini tidak dimulai dari EZClaw, atau sudah kedaluwarsa. Mulai lagi dari Settings, bagian Endpoint.");
    this.pending.delete(state);
    const clientId = issuedClientId ?? p.clientId;
    if (!clientId) throw new ChatGptAuthError("OpenAI tidak mengembalikan client ID, jadi pendaftaran EZClaw belum selesai. Coba masuk lagi.");

    const tokens = await this.tokenRequest({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE });
    const scopes = String(tokens.scope ?? "").split(/[\s+]+/);
    if (!scopes.includes(PLAN_SCOPE)) {
      throw new ChatGptAuthError("Akun ini masuk, tapi OpenAI tidak memberi izin memakai plan ChatGPT. Fitur ini untuk ChatGPT Plus dan Pro.");
    }
    const claims = typeof tokens.id_token === "string" ? await this.verifyIdToken(tokens.id_token, clientId, p.nonce) : {};
    this.save(p.endpointId, {
      clientId,
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null,
      accessToken: String(tokens.access_token ?? ""),
      expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
      email: typeof claims.email === "string" ? claims.email : null,
      sub: typeof claims.sub === "string" ? claims.sub : null,
    });
    return { endpointId: p.endpointId, email: typeof claims.email === "string" ? claims.email : null };
  }

  /* -------------------------------------------------------------- tokens */

  /** A current access token, refreshed first when it is close to running out. */
  async accessToken(endpointId: string, force = false): Promise<string> {
    const s = this.session(endpointId);
    if (!s?.refreshToken) throw new ProviderError("Belum masuk dengan akun ChatGPT. Masuk di Settings, bagian Endpoint.");
    if (!force && s.accessToken && s.expiresAt - REFRESH_MARGIN_MS > Date.now()) return s.accessToken;
    // One refresh at a time: the refresh token rotates, and a second use of the old one revokes the grant.
    const running = this.refreshing.get(endpointId);
    if (running) return running;
    const job = this.refresh(endpointId, s).finally(() => this.refreshing.delete(endpointId));
    this.refreshing.set(endpointId, job);
    return job;
  }

  private async refresh(endpointId: string, s: Session): Promise<string> {
    let tokens: Record<string, unknown>;
    try {
      tokens = await this.tokenRequest({ grant_type: "refresh_token", client_id: s.clientId, refresh_token: s.refreshToken!, resource: RESOURCE });
    } catch (err) {
      if (err instanceof ChatGptAuthError && TERMINAL_REFRESH.has(err.message.split(":")[0]!)) {
        // The grant is gone. The client registration stays, so signing in again needs no new consent screen.
        this.save(endpointId, { ...s, refreshToken: null, accessToken: null });
        throw new ProviderError("Login ChatGPT sudah tidak berlaku. Masuk lagi di Settings, bagian Endpoint.");
      }
      throw new ProviderError(`Token ChatGPT gagal diperbarui: ${err instanceof Error ? err.message : String(err)}`, { network: true });
    }
    const next: Session = {
      ...s,
      accessToken: String(tokens.access_token ?? ""),
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : s.refreshToken,
      expiresAt: Date.now() + Number(tokens.expires_in ?? 3600) * 1000,
    };
    this.save(endpointId, next);
    return next.accessToken!;
  }

  private async tokenRequest(form: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.authBase}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Reported below with the status.
    }
    if (!res.ok) {
      const code = typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
      const detail = typeof json.error_description === "string" ? json.error_description : text.slice(0, 200);
      throw new ChatGptAuthError(`${code}: ${detail}`);
    }
    return json;
  }

  private async verifyIdToken(idToken: string, clientId: string, nonce: string): Promise<Record<string, unknown>> {
    const { header, payload, signed, signature } = decodeJwt(idToken);
    if (header.alg !== "RS256") throw new ChatGptAuthError(`ID token memakai algoritma ${String(header.alg)}, bukan RS256.`);
    const jwks = (await (await this.fetchImpl(`${this.authBase}/.well-known/jwks.json`, { signal: AbortSignal.timeout(15_000) })).json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const jwk = jwks.keys?.find((k) => k.kid === header.kid);
    if (!jwk) throw new ChatGptAuthError("Kunci tanda tangan ID token tidak ditemukan di JWKS OpenAI.");
    if (!verify("RSA-SHA256", Buffer.from(signed), createPublicKey({ key: jwk, format: "jwk" }), signature)) throw new ChatGptAuthError("Tanda tangan ID token tidak valid.");
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== this.authBase) throw new ChatGptAuthError("ID token bukan dari OpenAI.");
    if (!aud.includes(clientId)) throw new ChatGptAuthError("ID token bukan untuk EZClaw.");
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now() - 5000) throw new ChatGptAuthError("ID token sudah kedaluwarsa.");
    if (payload.nonce !== nonce) throw new ChatGptAuthError("Nonce ID token tidak cocok.");
    return payload;
  }

  /** Signs out: revokes the grant when OpenAI says how, and forgets the tokens. The client ID stays for the next sign-in. */
  async signOut(endpointId: string): Promise<void> {
    const s = this.session(endpointId);
    if (!s) return;
    if (s.refreshToken) {
      try {
        const conf = (await (await this.fetchImpl(`${this.authBase}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })).json()) as { revocation_endpoint?: string };
        if (conf.revocation_endpoint) {
          await this.fetchImpl(conf.revocation_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: s.refreshToken, token_type_hint: "refresh_token", client_id: s.clientId }).toString(),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch {
        // Forgetting the tokens below still signs this EZClaw out.
      }
    }
    this.save(endpointId, { ...s, refreshToken: null, accessToken: null });
  }

  /** Removes everything, client registration included (the endpoint was deleted). */
  forget(endpointId: string) {
    this.putLarge(`chatgpt:${endpointId}`, null);
  }
}
