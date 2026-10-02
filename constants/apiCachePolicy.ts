/**
 * Intermediary cache policy for StellarCore's public responses.
 *
 * Every public route module (`route.ts`) and page (`page.tsx`) under the
 * `app` directory must be classified in `ROUTE_CACHE_POLICY`. The inventory
 * test in `tests/unit/api/cachePolicy.test.ts` fails for any unclassified
 * response module so a new endpoint cannot silently inherit framework
 * defaults, and `scripts/verify-cache-policy.ts` proves the declared policy
 * against a real production build and server.
 *
 * Evidence classes describe responses an intermediary (CDN, proxy) must never
 * retain: successes, errors, rate-limit responses, and degraded payloads all
 * share the route-level policy. Static classes describe resources that are
 * intentionally cacheable: they are documented and verified separately, and
 * hashed build assets and `public/` files are never rewritten by
 * `next.config.ts`.
 */

export type EvidenceCacheClass =
  | "evidence_api"
  | "internal_api"
  | "evidence_page";

export type StaticCacheClass =
  | "static_page"
  | "framework_not_found"
  | "hashed_build_asset"
  | "public_asset";

export type PublicCacheClass = EvidenceCacheClass | StaticCacheClass;

/** Classes whose responses an intermediary must never retain. */
export const EVIDENCE_CACHE_CLASSES: readonly PublicCacheClass[] =
  Object.freeze(["evidence_api", "internal_api", "evidence_page"]);

/** Exact `Cache-Control` value each class must produce. */
export const CACHE_CLASS_DIRECTIVES: Readonly<Record<PublicCacheClass, string>> =
  Object.freeze({
    evidence_api: "no-store",
    internal_api: "no-store",
    evidence_page: "no-store",
    // Framework default for not-found responses on unmatched paths; it embeds
    // no-store + private so a 404 can never be retained and mask recovery.
    // `next.config.ts` cannot inject headers into unmatched-path 404s, so the
    // value is pinned here and asserted by `npm run verify:cache`.
    framework_not_found: "private, no-cache, no-store, max-age=0, must-revalidate",
    // The framework serves prerendered pages with `s-maxage=31536000`, which
    // would let an intermediary keep stale landing HTML for a year after a
    // redeploy; `next.config.ts` pins revalidation instead.
    static_page: "public, max-age=0, must-revalidate",
    hashed_build_asset: "public, max-age=31536000, immutable",
    public_asset: "public, max-age=0",
  });

/** Explicit `Vary` value attached to evidence responses. */
export const EVIDENCE_VARY_VALUE = "Accept-Encoding";

/**
 * How each classified module's policy is enforced:
 * - `route_handler`: the route module sets headers through
 *   `lib/api/cachePolicy` on every response, and the `next.config.ts` safety
 *   net also covers the path.
 * - `next_config`: `next.config.ts` declares header sources for the page, so
 *   the policy does not depend on a framework default staying stable.
 * - `documented`: the framework serves the resource; the declared class is
 *   pinned by `npm run verify:cache` instead of being injected, so static
 *   asset caching stays untouched.
 */
export type RouteCacheEnforcement =
  | "route_handler"
  | "next_config"
  | "documented";

export type RouteCachePolicyEntry = Readonly<{
  class: PublicCacheClass;
  enforcement: RouteCacheEnforcement;
  /** Module that sets the response headers; defaults to the route file. */
  headersModule?: string;
  /** `next.config.ts` header sources that must cover the page. */
  configSources?: readonly string[];
}>;

export const ROUTE_CACHE_POLICY: Readonly<Record<string, RouteCachePolicyEntry>> =
  Object.freeze({
    "app/api/anchors/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/anchors/[slug]/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/corridors/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/corridors/[slug]/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/rates/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/reputation/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/reputation/[slug]/route.ts": Object.freeze({
      class: "evidence_api",
      enforcement: "route_handler",
    }),
    "app/api/internal/cron/refresh/route.ts": Object.freeze({
      class: "internal_api",
      enforcement: "route_handler",
      headersModule: "lib/scheduled/http.ts",
    }),
    "app/page.tsx": Object.freeze({
      class: "static_page",
      enforcement: "next_config",
      configSources: Object.freeze(["/"]),
    }),
    "app/dashboard/page.tsx": Object.freeze({
      class: "evidence_page",
      enforcement: "next_config",
      configSources: Object.freeze(["/dashboard"]),
    }),
    "app/corridors/[slug]/page.tsx": Object.freeze({
      class: "evidence_page",
      enforcement: "next_config",
      configSources: Object.freeze(["/corridors/:slug"]),
    }),
  });

/**
 * `next.config.ts` safety net covering every API path, including routes that
 * are added later. It guarantees the evidence policy ships even if a handler
 * forgets its own headers; the inventory test still fails until the new route
 * is classified.
 */
export const API_SAFETY_NET_SOURCE = "/api/:path*";

export type StaticResourceCachePolicy = Readonly<{
  /** Where the resource lives and how it is served. */
  location: string;
  class: StaticCacheClass;
  /** Representative paths covered by the class. */
  servedPaths: readonly string[];
}>;

/**
 * Intentionally cacheable static resources, documented separately from the
 * evidence inventory. `next.config.ts` must not inject headers for these, and
 * `npm run verify:cache` pins the framework's actual behavior.
 */
export const STATIC_RESOURCE_CACHE_POLICY: Readonly<
  Record<string, StaticResourceCachePolicy>
> = Object.freeze({
  hashedBuildAssets: Object.freeze({
    location: ".next/static build output served at /_next/static",
    class: "hashed_build_asset",
    servedPaths: Object.freeze(["/_next/static/:path*"]),
  }),
  publicFiles: Object.freeze({
    location: "public/ files served from the site root",
    class: "public_asset",
    servedPaths: Object.freeze(["/StellarCore.png", "/StellarCore-logo.png"]),
  }),
});
