import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  API_SAFETY_NET_SOURCE,
  CACHE_CLASS_DIRECTIVES,
  EVIDENCE_CACHE_CLASSES,
  EVIDENCE_VARY_VALUE,
  ROUTE_CACHE_POLICY,
  STATIC_RESOURCE_CACHE_POLICY,
  type RouteCachePolicyEntry,
} from "@/constants/apiCachePolicy";
import { cacheHeadersFor } from "@/lib/api/cachePolicy";
import nextConfig from "@/next.config";

type ConfiguredHeader = Readonly<{ key: string; value: string }>;

type ConfiguredHeaderRule = Readonly<{
  source: string;
  headers: readonly ConfiguredHeader[];
}>;

/** Every response module Next.js can serve from the `app/` directory. */
function discoverResponseModules(
  directory: string,
  urlPrefix = "app",
): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    const urlPath = `${urlPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...discoverResponseModules(fullPath, urlPath));
    } else if (entry.name === "route.ts" || entry.name === "page.tsx") {
      found.push(urlPath);
    }
  }
  return found;
}

async function configuredHeaderRules(): Promise<readonly ConfiguredHeaderRule[]> {
  const configured = nextConfig.headers;
  if (typeof configured === "function") return configured();
  if (Array.isArray(configured)) return configured;
  return (await configured) ?? [];
}

test("every public route and page is classified until the inventory accepts it", () => {
  const discovered = discoverResponseModules(join(process.cwd(), "app"));
  const classified = Object.keys(ROUTE_CACHE_POLICY);

  const unclassified = discovered.filter((path) => !(path in ROUTE_CACHE_POLICY));
  assert.deepEqual(
    unclassified,
    [],
    "Unclassified response modules. Add each one to ROUTE_CACHE_POLICY in "
      + "@/constants/apiCachePolicy.ts with an explicit cache class so the "
      + "intermediary policy stays auditable.",
  );

  const missing = classified.filter(
    (path) => !discovered.includes(path) && !existsSync(path),
  );
  assert.deepEqual(
    missing,
    [],
    "Stale cache-policy entries reference response modules that no longer exist.",
  );

  assert.ok(discovered.length > 0, "route discovery must find response modules");
});

test("route-enforced classes set headers through the shared policy module", () => {
  for (const [path, entry] of Object.entries(ROUTE_CACHE_POLICY)) {
    if (entry.enforcement !== "route_handler") continue;
    const headersModule = entry.headersModule ?? path;
    const source = readFileSync(headersModule, "utf8");
    assert.ok(
      source.includes("@/lib/api/cachePolicy"),
      `${headersModule} must build its response headers with `
        + `cacheHeadersFor/shared headers from @/lib/api/cachePolicy `
        + `so ${path} (${entry.class}) cannot hand-roll a divergent policy.`,
    );
  }
});

test("framework-enforced evidence pages declare their config sources", () => {
  for (const [path, entry] of Object.entries(ROUTE_CACHE_POLICY)) {
    if (entry.enforcement !== "next_config") continue;
    assert.ok(
      (entry.configSources ?? []).length > 0,
      `${path} is enforced by next.config.ts but declares no configSources.`,
    );
  }
});

test("next.config applies the safety net to APIs and evidence pages", async () => {
  const rules = await configuredHeaderRules();
  const bySource = new Map(rules.map((rule) => [rule.source, rule]));

  const apiRule = bySource.get(API_SAFETY_NET_SOURCE);
  assert.ok(
    apiRule,
    `next.config.ts must declare a "${API_SAFETY_NET_SOURCE}" header rule so `
      + "API responses carry the evidence policy even if a handler forgets it.",
  );
  assert.deepEqual(
    [...(apiRule?.headers ?? [])].sort((left, right) => left.key.localeCompare(right.key)),
    [
      { key: "Cache-Control", value: CACHE_CLASS_DIRECTIVES.evidence_api },
      { key: "Vary", value: EVIDENCE_VARY_VALUE },
    ],
  );

  for (const [path, entry] of Object.entries(ROUTE_CACHE_POLICY)) {
    if (entry.enforcement !== "next_config") continue;
    for (const source of entry.configSources ?? []) {
      const rule = bySource.get(source);
      assert.ok(
        rule,
        `${path} (${entry.class}) has no next.config.ts header rule for "${source}".`,
      );
      const expected = [
        { key: "Cache-Control", value: CACHE_CLASS_DIRECTIVES[entry.class] },
        ...(EVIDENCE_CACHE_CLASSES.includes(entry.class)
          ? [{ key: "Vary", value: EVIDENCE_VARY_VALUE }]
          : []),
      ];
      assert.deepEqual(
        rule?.headers,
        expected,
        `${source} must serve the exact ${entry.class} policy.`,
      );
    }
  }
});

test("the configured header rules are exactly the classified inventory", async () => {
  const rules = await configuredHeaderRules();
  const expectedSources = [
    API_SAFETY_NET_SOURCE,
    ...Object.values(ROUTE_CACHE_POLICY).flatMap(
      (entry) => entry.configSources ?? [],
    ),
  ].sort();
  assert.deepEqual(
    rules.map((rule) => rule.source).sort(),
    expectedSources,
    "next.config.ts header sources must match the cache-policy inventory; "
      + "unclassified rules or missing rules are policy drift.",
  );
});

test("no config rule rewrites intentionally cacheable static resources", async () => {
  const rules = await configuredHeaderRules();

  for (const rule of rules) {
    assert.ok(
      !rule.source.startsWith("/_next/static"),
      `hashed build assets must stay framework-managed, found "${rule.source}".`,
    );
    assert.ok(
      !rule.source.includes("StellarCore"),
      `public files must stay framework-managed, found "${rule.source}".`,
    );
  }

  for (const resource of Object.values(STATIC_RESOURCE_CACHE_POLICY)) {
    const directives = CACHE_CLASS_DIRECTIVES[resource.class];
    assert.equal(typeof directives, "string");
    assert.ok(
      directives.startsWith("public,"),
      `${resource.class} must remain publicly cacheable, got "${directives}".`,
    );
  }
});

test("cache classes pin exact intermediary directives", () => {
  assert.deepEqual(CACHE_CLASS_DIRECTIVES, {
    evidence_api: "no-store",
    internal_api: "no-store",
    evidence_page: "no-store",
    framework_not_found: "private, no-cache, no-store, max-age=0, must-revalidate",
    static_page: "public, max-age=0, must-revalidate",
    hashed_build_asset: "public, max-age=31536000, immutable",
    public_asset: "public, max-age=0",
  });

  for (const cacheClass of EVIDENCE_CACHE_CLASSES) {
    assert.deepEqual(cacheHeadersFor(cacheClass), {
      "Cache-Control": CACHE_CLASS_DIRECTIVES[cacheClass],
      "Vary": EVIDENCE_VARY_VALUE,
    });
  }

  for (const cacheClass of [
    "framework_not_found",
    "static_page",
    "hashed_build_asset",
    "public_asset",
  ] as const) {
    assert.deepEqual(cacheHeadersFor(cacheClass), {
      "Cache-Control": CACHE_CLASS_DIRECTIVES[cacheClass],
    });
  }
});

test("static resource classes stay documented separately from the route inventory", () => {
  const classes = Object.values(STATIC_RESOURCE_CACHE_POLICY).map(
    (resource) => resource.class,
  );
  assert.deepEqual(classes.sort(), ["hashed_build_asset", "public_asset"]);

  for (const resource of Object.values(STATIC_RESOURCE_CACHE_POLICY)) {
    const entry: RouteCachePolicyEntry = {
      class: resource.class,
      enforcement: "documented",
    };
    assert.equal(entry.enforcement, "documented");
  }
});
