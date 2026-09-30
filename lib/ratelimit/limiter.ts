import type { RateLimitPolicy } from "@/lib/ratelimit/policy";
import { MemoryRateLimitStore, type RateLimitStore } from "@/lib/ratelimit/store";

export const UNAVAILABLE_RETRY_SECONDS = 5;

export type RateLimitDecision = Readonly<{
  outcome: "allowed" | "limited" | "unavailable";
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
  /** True when the shared store failed and the per-instance fallback decided. */
  degraded: boolean;
}>;

export type RateLimiterOptions = Readonly<{
  store: RateLimitStore;
  fallbackStore?: RateLimitStore;
  now?: () => number;
  storeTimeoutMs?: number;
}>;

export class RateLimiter {
  private readonly store: RateLimitStore;
  private readonly fallback: RateLimitStore;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: RateLimiterOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.fallback = options.fallbackStore ?? new MemoryRateLimitStore(this.now);
    this.timeoutMs = options.storeTimeoutMs ?? 300;
  }

  async check(
    policy: RateLimitPolicy,
    identityKey: string,
  ): Promise<RateLimitDecision> {
    const nowMs = this.now();
    const windowIndex = Math.floor(nowMs / policy.windowMs);
    const key = `rl:v1:${policy.group}:${identityKey}:${windowIndex}`;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((windowIndex + 1) * policy.windowMs - nowMs) / 1000),
    );

    let count: number;
    let degraded = false;

    try {
      count = await this.hitWithTimeout(this.store, key, policy.windowMs);
    } catch {
      if (policy.onStoreFailure === "deny") {
        return Object.freeze({
          outcome: "unavailable",
          limit: policy.limit,
          remaining: 0,
          retryAfterSeconds: UNAVAILABLE_RETRY_SECONDS,
          degraded: true,
        });
      }
      degraded = true;
      count = await this.fallback.hit(key, policy.windowMs);
    }

    const limited = count > policy.limit;
    return Object.freeze({
      outcome: limited ? "limited" : "allowed",
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - count),
      retryAfterSeconds,
      degraded,
    });
  }

  private async hitWithTimeout(
    store: RateLimitStore,
    key: string,
    windowMs: number,
  ): Promise<number> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("rate limit store timed out"));
      }, this.timeoutMs);
    });

    try {
      const count = await Promise.race([
        store.hit(key, windowMs, controller.signal),
        timeout,
      ]);
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error("invalid count");
      }
      return count;
    } finally {
      clearTimeout(timer);
    }
  }
}
