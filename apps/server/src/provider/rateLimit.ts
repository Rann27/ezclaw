/**
 * Keeps requests to each endpoint under its per-minute limit, and holds every request to an endpoint
 * back after it answered 429, so a provider's rate limit slows a run down instead of failing it.
 */
export class RateLimiter {
  private readonly sent = new Map<string, number[]>();
  private readonly pausedUntil = new Map<string, number>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Waits until a request to `key` may go out, then counts it. `onWait` hears each pause before it
   * starts: "limit" when the per-minute budget is used up, "paused" after a 429. Returns the ms waited.
   */
  async acquire(key: string, rpm: number | null, signal: AbortSignal, onWait?: (ms: number, why: "limit" | "paused") => void): Promise<number> {
    let waited = 0;
    for (;;) {
      const t = this.now();
      let wait = (this.pausedUntil.get(key) ?? 0) - t;
      let why: "limit" | "paused" = "paused";
      if (wait <= 0 && rpm) {
        const recent = (this.sent.get(key) ?? []).filter((at) => t - at < this.windowMs);
        this.sent.set(key, recent);
        // A little slack past the window edge, so the provider's own clock agrees.
        if (recent.length >= rpm) {
          wait = recent[0]! + this.windowMs - t + 250;
          why = "limit";
        }
      }
      if (wait <= 0) break;
      onWait?.(wait, why);
      await sleep(wait, signal);
      waited += wait;
    }
    if (rpm) this.sent.set(key, [...(this.sent.get(key) ?? []), this.now()]);
    return waited;
  }

  /** Holds every request to `key` back for `ms` (after a 429). */
  pause(key: string, ms: number) {
    this.pausedUntil.set(key, Math.max(this.pausedUntil.get(key) ?? 0, this.now() + ms));
  }
}

/** Resolves after `ms`, or rejects with the abort reason when `signal` fires. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** How long a 429 asks to wait: Retry-After (seconds or a date), retry-after-ms, or OpenAI's reset header. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  // "1s", "6m0s", "250ms"
  const reset = headers.get("x-ratelimit-reset-requests");
  if (reset) {
    const m = /^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/.exec(reset.trim());
    if (m && (m[1] || m[2] || m[3])) return Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
  }
  return null;
}

/**
 * A 429 that waiting will not fix: an exhausted quota, balance or free allowance. A per-minute quota
 * (Gemini words its rate limit that way) is still a rate limit and worth waiting for.
 */
export function isQuotaError(text: string): boolean {
  if (/per.?minute|rate.?limit|requests per|\bRPM\b|\bTPM\b/i.test(text)) return false;
  return /insufficient_quota|quota|billing|insufficient.{0,20}(credit|balance|fund)|free_limit|payment_required|requires_payment/i.test(text);
}

export const rateLimiter = new RateLimiter();
