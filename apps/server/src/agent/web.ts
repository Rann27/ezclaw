import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { WebSearchProvider } from "@ezclaw/core";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export class WebError extends Error {}

/** Loopback, private, link-local and similar ranges: the agent must not reach this computer or its network through web_fetch. */
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublic(url: URL, allowPrivate: boolean) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebError("Hanya alamat http dan https yang bisa diambil.");
  if (url.username || url.password) throw new WebError("Alamat dengan kredensial tidak diizinkan.");
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new WebError("Alamat lokal tidak bisa diambil lewat web_fetch.");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new WebError(`Nama host tidak ditemukan: ${host}`);
  if (addresses.some(isPrivateAddress)) throw new WebError("Alamat ini menuju jaringan lokal atau komputer ini sendiri, jadi tidak diambil.");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", copy: "©" };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Readable text from HTML: scripts, styles and navigation chrome removed, headings and list items kept as lines. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  const body = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(h[1-6])[^>]*>/gi, "\n\n## ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|p|div|tr|section|article)[^>]*>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && /^https?:/.test(href) ? `${l} (${href})` : l;
    })
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((l, i, arr) => l || (arr[i - 1] ?? "") !== "")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

export interface FetchedPage {
  url: string;
  title: string;
  contentType: string;
  text: string;
}

/** Fetches a public web page and returns it as text. Redirects are followed one by one, each checked again. */
export async function fetchPage(rawUrl: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch, opts: { allowPrivate?: boolean } = {}): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebError(`URL tidak valid: ${rawUrl}`);
  }
  for (let hop = 0; ; hop++) {
    await assertPublic(url, opts.allowPrivate === true);
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      headers: { "user-agent": "Mozilla/5.0 (compatible; EZClaw-agent)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    }).catch((err: unknown) => {
      if (signal.aborted) throw err;
      throw new WebError(`Tidak bisa mengambil ${url.href}: ${err instanceof Error ? err.message : String(err)}`);
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new WebError("Terlalu banyak redirect.");
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new WebError(`${url.href} menjawab ${res.status} ${res.statusText}.`);
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/|json|xml|javascript/i.test(type)) throw new WebError(`Isi halaman ini bukan teks (${type || "tipe tidak diketahui"}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf.subarray(0, MAX_BYTES).toString("utf8");
    if (/html/i.test(type)) {
      const { title, text } = htmlToText(raw);
      return { url: url.href, title, contentType: type, text };
    }
    return { url: url.href, title: "", contentType: type, text: raw };
  }
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Runs a web search with the provider set in Settings. */
export async function searchWeb(provider: WebSearchProvider, key: string, query: string, count: number, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<SearchResult[]> {
  const opts = { signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) };
  let res: Response;
  if (provider === "brave") {
    res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { ...opts, headers: { accept: "application/json", "x-subscription-token": key } });
  } else if (provider === "tavily") {
    res = await fetchImpl("https://api.tavily.com/search", { ...opts, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ query, max_results: count, search_depth: "basic" }) });
  } else {
    res = await fetchImpl("https://api.exa.ai/search", { ...opts, method: "POST", headers: { "content-type": "application/json", "x-api-key": key }, body: JSON.stringify({ query, numResults: count, contents: { highlights: true } }) });
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new WebError(`Pencarian gagal (${res.status})${res.status === 401 || res.status === 403 ? ": key ditolak, periksa di Settings" : ""}. ${body}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (provider === "brave") return arr((json.web as Record<string, unknown> | undefined)?.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.description).replace(/<[^>]+>/g, "") }));
  if (provider === "tavily") return arr(json.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: str(r.content) }));
  return arr(json.results).map((r) => ({ title: str(r.title), url: str(r.url), snippet: Array.isArray(r.highlights) ? (r.highlights as unknown[]).map(str).join(" … ") : str(r.text).slice(0, 500) }));
}
