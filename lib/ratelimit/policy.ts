export type RateLimitGroup = "catalog" | "rates" | "reputation";
export type StoreFailureMode = "local_fallback" | "deny";

export type RateLimitPolicy = Readonly<{
  group: RateLimitGroup;
  limit: number;
  windowMs: number;
  onStoreFailure: StoreFailureMode;
}>;

export type RateLimitConfig = Readonly<{
  policies: Readonly<Record<RateLimitGroup, RateLimitPolicy>>;
  trustedIpHeader: string;
  keySecret: string;
  store: Readonly<{ url: string; token: string }> | null;
  storeTimeoutMs: number;
}>;

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_TRUSTED_IP_HEADER = "x-vercel-forwarded-for";
export const DEFAULT_STORE_TIMEOUT_MS = 300;

const DEFAULT_LIMITS: Readonly<Record<RateLimitGroup, number>> = {
  catalog: 120,
  rates: 60,
  reputation: 60,
};
const DEFAULT_KEY_SECRET = "stellarcore-rate-limit-v1";

/** Returns null for paths that are outside the public limiter (non-API, internal). */
export function groupForPath(pathname: string): RateLimitGroup | null {
  if (!pathname.startsWith("/api/")) return null;
  if (pathname === "/api/internal" || pathname.startsWith("/api/internal/")) {
    return null;
  }
  if (pathname === "/api/rates" || pathname.startsWith("/api/rates/")) {
    return "rates";
  }
  if (pathname === "/api/reputation" || pathname.startsWith("/api/reputation/")) {
    return "reputation";
  }
  return "catalog";
}

export function loadRateLimitConfig(
  env: Readonly<Record<string, string | undefined>>,
): RateLimitConfig {
  const policy = (group: RateLimitGroup, variable: string): RateLimitPolicy =>
    Object.freeze({
      group,
      limit: positiveInt(env[variable], DEFAULT_LIMITS[group]),
      windowMs: RATE_LIMIT_WINDOW_MS,
      onStoreFailure: "local_fallback" as const,
    });

  return Object.freeze({
    policies: Object.freeze({
      catalog: policy("catalog", "RATE_LIMIT_CATALOG_PER_MINUTE"),
      rates: policy("rates", "RATE_LIMIT_RATES_PER_MINUTE"),
      reputation: policy("reputation", "RATE_LIMIT_REPUTATION_PER_MINUTE"),
    }),
    trustedIpHeader:
      parseHeaderName(env.RATE_LIMIT_TRUSTED_IP_HEADER) ??
      DEFAULT_TRUSTED_IP_HEADER,
    keySecret: parseSecret(env.RATE_LIMIT_KEY_SECRET),
    store: parseStore(env),
    storeTimeoutMs: DEFAULT_STORE_TIMEOUT_MS,
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^[1-9]\d{0,5}$/.test(value)) return fallback;
  return Number(value);
}

function parseHeaderName(value: string | undefined): string | null {
  const name = value?.trim().toLowerCase();
  return name && /^[a-z0-9-]{1,64}$/.test(name) ? name : null;
}

function parseSecret(value: string | undefined): string {
  return value && value.length >= 16 && value.length <= 256
    ? value
    : DEFAULT_KEY_SECRET;
}

function parseStore(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<{ url: string; token: string }> | null {
  const rawUrl = env.RATE_LIMIT_REDIS_REST_URL;
  const token = env.RATE_LIMIT_REDIS_REST_TOKEN;
  if (!rawUrl || !token || token.length > 512 || /\s/.test(token)) return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return Object.freeze({ url: url.toString().replace(/\/+$/, ""), token });
  } catch {
    return null;
  }
}
