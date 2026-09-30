import { deriveIdentityKey, resolveClientIdentity } from "@/lib/ratelimit/identity";
import { RateLimiter, type RateLimitDecision } from "@/lib/ratelimit/limiter";
import {
  groupForPath,
  loadRateLimitConfig,
  type RateLimitConfig,
} from "@/lib/ratelimit/policy";
import {
  MemoryRateLimitStore,
  RedisRestRateLimitStore,
} from "@/lib/ratelimit/store";

export type EnforceDependencies = Readonly<{
  config: RateLimitConfig;
  limiter: RateLimiter;
}>;

let cached: EnforceDependencies | undefined;

export function getDefaultDependencies(): EnforceDependencies {
  if (cached) return cached;

  const config = loadRateLimitConfig(process.env);
  if (!config.store && process.env.NODE_ENV === "production") {
    console.warn(
      "Public API rate limiter has no shared store configured; using per-instance limits only.",
    );
  }
  const store = config.store
    ? new RedisRestRateLimitStore(config.store)
    : new MemoryRateLimitStore();

  cached = Object.freeze({
    config,
    limiter: new RateLimiter({ store, storeTimeoutMs: config.storeTimeoutMs }),
  });
  return cached;
}

/**
 * Returns a 429/503 Response when the request must not proceed, or undefined
 * to admit it untouched. Paths outside the public API (including
 * /api/internal/*) are never limited. Unexpected limiter errors fail open:
 * public routes are read-only and never write evidence.
 */
export async function enforcePublicRateLimit(
  request: Request,
  dependencies?: EnforceDependencies,
): Promise<Response | undefined> {
  try {
    const group = groupForPath(new URL(request.url).pathname);
    if (group === null) return undefined;

    const { config, limiter } = dependencies ?? getDefaultDependencies();
    const identity = resolveClientIdentity(request.headers, config.trustedIpHeader);
    const identityKey = await deriveIdentityKey(identity, config.keySecret);
    const decision = await limiter.check(config.policies[group], identityKey);

    return decision.outcome === "allowed" ? undefined : buildResponse(decision);
  } catch {
    return undefined;
  }
}

function buildResponse(decision: RateLimitDecision): Response {
  const unavailable = decision.outcome === "unavailable";
  return Response.json(
    {
      error: {
        code: unavailable ? "rate_limiter_unavailable" : "rate_limited",
        message: unavailable
          ? "Rate limiting is temporarily unavailable."
          : "Too many requests. Retry later.",
        retryAfterSeconds: decision.retryAfterSeconds,
      },
    },
    {
      status: unavailable ? 503 : 429,
      headers: {
        "Retry-After": String(decision.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}
