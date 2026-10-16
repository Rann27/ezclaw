import { describe, expect, it } from "vitest";
import { fetchPage, htmlToText, searchWeb } from "./web.js";

const never = new AbortController().signal;

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe("htmlToText", () => {
  it("keeps headings, list items and link targets; drops scripts and chrome", () => {
    const { title, text } = htmlToText('<title>T &amp; U</title><body><header>logo</header><h2>Bab</h2><p>Lihat <a href="https://x.dev/doc">dok</a>.</p><ul><li>a</li></ul><script>bad()</script></body>');
    expect(title).toBe("T & U");
    expect(text).toContain("## Bab");
    expect(text).toContain("dok (https://x.dev/doc)");
    expect(text).toContain("- a");
    expect(text).not.toContain("bad()");
    expect(text).not.toContain("logo");
  });
});

describe("fetchPage guard", () => {
  it("refuses this computer and private networks, and non-http schemes", async () => {
    for (const url of ["http://127.0.0.1:8787/api/settings", "http://localhost/x", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "file:///C:/Windows/win.ini"]) {
      await expect(fetchPage(url, never)).rejects.toThrow();
    }
  });
});

describe("searchWeb", () => {
  it("brave: GET with the subscription header, results from web.results", async () => {
    const f = fakeFetch(() => ({ body: { web: { results: [{ title: "A", url: "https://a", description: "<b>x</b> y" }] } } }));
    const r = await searchWeb("brave", "KEY", "q w", 3, never, f.fetch);
    expect(f.calls[0]!.url).toBe("https://api.search.brave.com/res/v1/web/search?q=q%20w&count=3");
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-subscription-token"]).toBe("KEY");
    expect(r).toEqual([{ title: "A", url: "https://a", snippet: "x y" }]);
  });

  it("tavily: POST with a bearer key", async () => {
    const f = fakeFetch(() => ({ body: { results: [{ title: "T", url: "https://t", content: "c" }] } }));
    const r = await searchWeb("tavily", "tvly-K", "q", 2, never, f.fetch);
    expect(f.calls[0]!.url).toBe("https://api.tavily.com/search");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tvly-K");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ query: "q", max_results: 2 });
    expect(r[0]).toEqual({ title: "T", url: "https://t", snippet: "c" });
  });

  it("exa: POST with x-api-key, highlights as the snippet", async () => {
    const f = fakeFetch(() => ({ body: { results: [{ title: "E", url: "https://e", highlights: ["one", "two"] }] } }));
    const r = await searchWeb("exa", "K", "q", 1, never, f.fetch);
    expect((f.calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("K");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ query: "q", numResults: 1, contents: { highlights: true } });
    expect(r[0]!.snippet).toBe("one … two");
  });

  it("explains a rejected key", async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: "bad key" } }));
    await expect(searchWeb("brave", "K", "q", 1, never, f.fetch)).rejects.toThrow(/key ditolak/);
  });
});
