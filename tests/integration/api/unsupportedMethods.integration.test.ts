import assert from "node:assert/strict";
import test from "node:test";

import * as anchorsDetailRoute from "@/app/api/anchors/[slug]/route";
import * as anchorsListRoute from "@/app/api/anchors/route";
import * as corridorsDetailRoute from "@/app/api/corridors/[slug]/route";
import * as corridorsListRoute from "@/app/api/corridors/route";
import * as ratesHistoryRoute from "@/app/api/rates/history/route";
import * as ratesRoute from "@/app/api/rates/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import * as reputationListRoute from "@/app/api/reputation/route";

const UNSUPPORTED_HTTP_METHODS = [
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;

const PUBLIC_EVIDENCE_ROUTES = [
  {
    name: "rates",
    path: "/api/rates",
    route: ratesRoute,
    sampleValidQuery: "?corridor=usdc-us-brl-br",
    sampleInvalidQuery: "?corridor=bad--slug",
  },
  {
    name: "rates history",
    path: "/api/rates/history",
    route: ratesHistoryRoute,
    sampleValidQuery: "?corridor=usdc-us-brl-br&days=30",
    sampleInvalidQuery: "?corridor=bad--slug",
  },
  {
    name: "anchors list",
    path: "/api/anchors",
    route: anchorsListRoute,
    sampleValidQuery: "",
    sampleInvalidQuery: "?limit=-1",
  },
  {
    name: "anchors detail",
    path: "/api/anchors/[slug]",
    route: anchorsDetailRoute,
    sampleValidQuery: "/zeam",
    sampleInvalidQuery: "/bad--slug",
    params: { slug: "bad--slug" },
  },
  {
    name: "corridors list",
    path: "/api/corridors",
    route: corridorsListRoute,
    sampleValidQuery: "",
    sampleInvalidQuery: "?limit=-1",
  },
  {
    name: "corridors detail",
    path: "/api/corridors/[slug]",
    route: corridorsDetailRoute,
    sampleValidQuery: "/usdc-us-brl-br",
    sampleInvalidQuery: "/bad--slug",
    params: { slug: "bad--slug" },
  },
  {
    name: "reputation list",
    path: "/api/reputation",
    route: reputationListRoute,
    sampleValidQuery: "",
    sampleInvalidQuery: "",
  },
  {
    name: "reputation detail",
    path: "/api/reputation/[slug]",
    route: reputationDetailRoute,
    sampleValidQuery: "/zeam",
    sampleInvalidQuery: "/bad--slug",
    params: { slug: "bad--slug" },
  },
] as const;

test("all public read-only evidence routes reject unsupported HTTP methods consistently by exporting only GET", () => {
  for (const { name, route } of PUBLIC_EVIDENCE_ROUTES) {
    assert.equal(
      route.dynamic,
      "force-dynamic",
      `${name} route must be force-dynamic`,
    );
    assert.equal(
      typeof route.GET,
      "function",
      `${name} route must export a GET handler`,
    );

    for (const method of UNSUPPORTED_HTTP_METHODS) {
      assert.equal(
        method in route,
        false,
        `${name} route must not export unsupported method handler ${method}`,
      );
    }
  }
});

test("public read-only evidence routes preserve read-only invariants and do not expose write mutations", async () => {
  let writeAttemptCounter = 0;
  const mutatingRepository = {
    create: async () => { writeAttemptCounter++; },
    update: async () => { writeAttemptCounter++; },
    delete: async () => { writeAttemptCounter++; },
    upsert: async () => { writeAttemptCounter++; },
  };

  for (const { name, route } of PUBLIC_EVIDENCE_ROUTES) {
    for (const method of UNSUPPORTED_HTTP_METHODS) {
      const handler = (route as Record<string, unknown>)[method];
      assert.equal(
        handler,
        undefined,
        `${name} route must not define ${method} that could invoke mutation logic`,
      );
    }
  }

  assert.equal(
    writeAttemptCounter,
    0,
    "No write methods should have been triggered against mutatingRepository",
  );
  assert.equal(Object.isFrozen(mutatingRepository), false);
});

test("supported GET behavior remains unchanged and preserves appropriate response headers", async () => {
  for (const entry of PUBLIC_EVIDENCE_ROUTES) {
    const url = `http://localhost${entry.path}${entry.sampleInvalidQuery}`;
    const request = new Request(url, { method: "GET" });

    let response: Response;
    if ("params" in entry && entry.params) {
      const detailHandler = entry.route.GET as (
        req: Request,
        ctx: { params: Promise<{ slug: string }> },
      ) => Promise<Response>;
      response = await detailHandler(request, {
        params: Promise.resolve(entry.params),
      });
    } else {
      const listHandler = entry.route.GET as (req: Request) => Promise<Response>;
      response = await listHandler(request);
    }

    assert.ok(response instanceof Response, `${entry.name} GET must return a Response`);
    assert.equal(
      response.headers.get("cache-control"),
      "no-store",
      `${entry.name} must preserve Cache-Control: no-store header`,
    );
  }
});
