import type { NextConfig } from "next";

import {
  API_SAFETY_NET_SOURCE,
  CACHE_CLASS_DIRECTIVES,
  EVIDENCE_CACHE_CLASSES,
  EVIDENCE_VARY_VALUE,
  ROUTE_CACHE_POLICY,
  type PublicCacheClass,
} from "./constants/apiCachePolicy";

/**
 * Intermediary-cache headers are declared from the shared policy registry so
 * the framework cannot silently apply its own defaults to evidence responses:
 * every `/api/*` path (including routes added later), every classified
 * evidence page, and the static landing page receive their policy at the
 * server, independently of what a handler or a future framework default
 * emits. Route handlers set the same headers themselves so direct handler
 * tests observe the policy too; the values are identical, so the two layers
 * cannot disagree. Intentionally cacheable static resources (`/_next/static`
 * and `public/` files) are never targeted here — their classes are documented
 * and pinned by `npm run verify:cache` instead.
 */
function headersForClass(
  cacheClass: PublicCacheClass,
): { key: string; value: string }[] {
  const headers = [
    { key: "Cache-Control", value: CACHE_CLASS_DIRECTIVES[cacheClass] },
  ];
  if (EVIDENCE_CACHE_CLASSES.includes(cacheClass)) {
    headers.push({ key: "Vary", value: EVIDENCE_VARY_VALUE });
  }
  return headers;
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    const rules = [
      { source: API_SAFETY_NET_SOURCE, headers: headersForClass("evidence_api") },
    ];

    for (const entry of Object.values(ROUTE_CACHE_POLICY)) {
      for (const source of entry.configSources ?? []) {
        rules.push({ source, headers: headersForClass(entry.class) });
      }
    }

    return rules;
  },
};

export default nextConfig;
