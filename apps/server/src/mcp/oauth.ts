import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import type { SecretStore } from "../secrets.js";

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/**
 * OAuth for one remote MCP server. Client registration, tokens and the PKCE verifier live in the
 * secret store, never in the database. When the server needs a login, the authorization URL is
 * handed to `onAuthUrl` so the owner can open it; the browser then comes back to `redirectUrl`.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private readonly key: string;
  private currentState: string | null = null;

  constructor(
    serverId: string,
    private readonly secrets: SecretStore,
    private readonly callbackUrl: string,
    private readonly onAuthUrl: (url: string, state: string) => void,
  ) {
    this.key = `mcp:${serverId}:oauth`;
  }

  private read(): Stored {
    const raw = this.secrets.get(this.key);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Stored;
    } catch {
      return {};
    }
  }

  private write(patch: Partial<Stored>) {
    this.secrets.set(this.key, JSON.stringify({ ...this.read(), ...patch }));
  }

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "EZClaw",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.currentState = randomBytes(16).toString("hex");
    return this.currentState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.write({ client: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.onAuthUrl(url.toString(), url.searchParams.get("state") ?? this.currentState ?? "");
  }

  saveCodeVerifier(verifier: string): void {
    this.write({ verifier });
  }

  codeVerifier(): string {
    const v = this.read().verifier;
    if (!v) throw new Error("Login MCP belum dimulai dari EZClaw.");
    return v;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const s = this.read();
    if (scope === "all") this.secrets.delete(this.key);
    else if (scope === "client") this.write({ ...s, client: undefined });
    else if (scope === "tokens") this.write({ ...s, tokens: undefined });
    else if (scope === "verifier") this.write({ ...s, verifier: undefined });
  }

  hasTokens(): boolean {
    return !!this.read().tokens;
  }

  clear(): void {
    this.secrets.delete(this.key);
  }
}
