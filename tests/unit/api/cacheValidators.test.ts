import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as rateHistoryRoute from "@/app/api/rates/history/route";
import * as ratesRoute from "@/app/api/rates/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import { publicApiErrorResult } from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { staleEvidenceHeaders } from "@/lib/api/staleEvidence";

const CONDITIONAL_HEADERS = {
  "If-None-Match": '"abc123"',
  "If-Modified-Since": "Wed, 01 Jan 2026 00:00:00 GMT",
};
const VALIDATOR_HEADERS = ["etag", "last-modified", "expires", "age"];

type Case = Readonly<{ name: string; call: (init?: RequestInit) => Promise<Response> }>;

const slugParams = { params: Promise.resolve({ slug: "bad--slug" }) };

// Fixed, database-free inputs: every case resolves from request validation alone.
const CASES: readonly Case[] = [
  {
    name: "anchors/[slug]",
    call: (init) => anchorDetailRoute.GET(new Request("http://localhost/api/anchors/bad--slug", init), slugParams),
  },
  {
    name: "corridors/[slug]",
    call: (init) => corridorDetailRoute.GET(new Request("http://localhost/api/corridors/bad--slug", init), slugParams),
  },
  {
    name: "reputation/[slug]",
    call: (init) => reputationDetailRoute.GET(new Request("http://localhost/api/reputation/bad--slug", init), slugParams),
  },
  { name: "rates", call: (init) => ratesRoute.GET(new Request("http://localhost/api/rates", init)) },
  {
    name: "rates/history",
    call: (init) => rateHistoryRoute.GET(
      new Request("http://localhost/api/rates/history?corridor=usdc-us-brl-br&days=bad", init),
    ),
  },
];

test("every public evidence route is no-store with no cache validators", async () => {
  for (const { name, call } of CASES) {
    const response = await call();
    assert.equal(response.headers.get("cache-control"), "no-store", name);
    for (const header of VALIDATOR_HEADERS) {
      assert.equal(response.headers.get(header), null, `${name} must not send ${header}`);
    }
  }
});

test("conditional requests never produce 304 or a cacheable response", async () => {
  for (const { name, call } of CASES) {
    const unconditional = await call();
    const conditional = await call({ headers: CONDITIONAL_HEADERS });
    assert.notEqual(conditional.status, 304, name);
    assert.equal(conditional.status, unconditional.status, name);
    assert.equal(conditional.headers.get("cache-control"), "no-store", name);
    assert.equal(conditional.headers.get("etag"), null, name);
    assert.deepEqual(await conditional.json(), await unconditional.json(), name);
  }
});

test("equivalent content serializes to identical bodies and headers", async () => {
  const first = publicApiJsonResponse(publicApiErrorResult("corridor_not_found", "Corridor not found."));
  const second = publicApiJsonResponse(publicApiErrorResult("corridor_not_found", "Corridor not found."));
  assert.equal(await first.text(), await second.text());
  assert.deepEqual([...first.headers].sort(), [...second.headers].sort());
});

test("changed content is not given a reusable validator", async () => {
  const a = publicApiJsonResponse({ status: 200, body: { value: "1" } });
  const b = publicApiJsonResponse({ status: 200, body: { value: "2" } });
  assert.notEqual(await a.text(), await b.text());
  for (const response of [a, b]) {
    assert.equal(response.headers.get("etag"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("stale evidence headers stay no-store and carry no validators", () => {
  const headers = staleEvidenceHeaders(undefined);
  assert.equal(headers["Cache-Control"], "no-store");
  for (const key of Object.keys(headers)) {
    assert.equal(VALIDATOR_HEADERS.includes(key.toLowerCase()), false, key);
  }
});
