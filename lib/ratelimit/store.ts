/**
 * Atomic fixed-window counter. `hit` increments the key and returns the
 * count AFTER the increment. Implementations must make the increment atomic
 * and expire the key so retention stays bounded.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number, signal?: AbortSignal): Promise<number>;
}

type MemoryEntry = { count: number; expiresAt: number };

/** Process-local. Tests, local development and outage fallback only. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(now: () => number = Date.now, maxKeys = 10_000) {
    this.now = now;
    this.maxKeys = maxKeys;
  }

  async hit(key: string, windowMs: number): Promise<number> {
    const nowMs = this.now();
    let entry = this.entries.get(key);

    if (!entry || entry.expiresAt <= nowMs) {
      entry = { count: 0, expiresAt: nowMs + windowMs * 2 };
      this.entries.set(key, entry);
      if (this.entries.size > this.maxKeys) this.prune(nowMs);
    }

    entry.count += 1;
    return entry.count;
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= nowMs) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

/**
 * Shared store for a Redis-compatible REST endpoint (for example Upstash or
 * Vercel KV) using one pipelined INCR + PEXPIRE request. No vendor SDK.
 */
export class RedisRestRateLimitStore implements RateLimitStore {
  private readonly url: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor(
    options: Readonly<{ url: string; token: string; fetcher?: typeof fetch }>,
  ) {
    this.url = options.url;
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
  }

  async hit(
    key: string,
    windowMs: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const response = await this.fetcher(`${this.url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        ["INCR", key],
        ["PEXPIRE", key, String(windowMs * 2)],
      ]),
      redirect: "manual",
      signal,
    });

    if (response.status !== 200) {
      throw new Error("rate limit store returned an error status");
    }

    const body: unknown = await response.json();
    const first = Array.isArray(body)
      ? (body[0] as { result?: unknown } | undefined)
      : undefined;
    const count = first?.result;

    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      throw new Error("rate limit store returned an invalid count");
    }
    return count;
  }
}
