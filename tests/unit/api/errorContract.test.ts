import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import * as ratesRoute from "@/app/api/rates/route";
import { getAnchorApiResult } from "@/lib/api/anchors";
import {
  consolePublicApiErrorReporter,
  publicApiErrorEnvelope,
  publicApiErrorResult,
} from "@/lib/api/errors";
import { publicApiJsonResponse } from "@/lib/api/http";
import { getRatesApiResult } from "@/lib/api/rates";
import {
  PUBLIC_API_ERROR_CODES,
  PUBLIC_API_ERROR_STATUS_BY_CODE,
  type PublicApiErrorCode,
} from "@/types/api/errors";

const EXPECTED_STATUS_BY_CODE: Readonly<Record<PublicApiErrorCode, number>> = {
  missing_corridor: 400,
  invalid_corridor: 400,
  invalid_corridor_slug: 400,
  invalid_anchor_slug: 400,
  anchor_not_found: 404,
  corridor_not_found: 404,
  rate_limited: 429,
  internal_error: 500,
  upstream_unavailable: 503,
};

test("every registered error code maps to its documented status class", () => {
  for (const code of PUBLIC_API_ERROR_CODES) {
    assert.equal(
      PUBLIC_API_ERROR_STATUS_BY_CODE[code],
      EXPECTED_STATUS_BY_CODE[code],
      code,
    );
  }
  assert.deepEqual([...PUBLIC_API_ERROR_CODES].sort(), [
    "anchor_not_found",
    "corridor_not_found",
    "internal_error",
    "invalid_anchor_slug",
    "invalid_corridor",
    "invalid_corridor_slug",
    "missing_corridor",
    "rate_limited",
    "upstream_unavailable",
  ]);
});

test("all five HTTP error classes are represented with stable snake_case codes", () => {
  const classes = new Set(Object.values(EXPECTED_STATUS_BY_CODE));
  assert.deepEqual([...classes].sort(), [400, 404, 429, 500, 503]);

  for (const code of PUBLIC_API_ERROR_CODES) {
    assert.match(code, /^[a-z0-9_]+$/, code);
  }

  assert.equal(PUBLIC_API_ERROR_STATUS_BY_CODE.rate_limited, 429);
  assert.equal(PUBLIC_API_ERROR_STATUS_BY_CODE.upstream_unavailable, 503);
});

test("the error envelope is exactly error.code and error.message, deeply frozen", () => {
  const envelope = publicApiErrorEnvelope("internal_error", "Unable to load.");

  assert.deepEqual(envelope, {
    error: { code: "internal_error", message: "Unable to load." },
  });
  assert.deepEqual(Object.keys(envelope).sort(), ["error"]);
  assert.deepEqual(Object.keys(envelope.error).sort(), ["code", "message"]);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.error), true);
});

test("the result helper derives status from code so handlers cannot mismatch", () => {
  assert.deepEqual(publicApiErrorResult("invalid_corridor", "bad."), {
    status: 400,
    body: { error: { code: "invalid_corridor", message: "bad." } },
  });
  assert.deepEqual(publicApiErrorResult("anchor_not_found", "gone."), {
    status: 404,
    body: { error: { code: "anchor_not_found", message: "gone." } },
  });
  assert.deepEqual(publicApiErrorResult("rate_limited", "slow down."), {
    status: 429,
    body: { error: { code: "rate_limited", message: "slow down." } },
  });
  assert.deepEqual(publicApiErrorResult("internal_error", "oops."), {
    status: 500,
    body: { error: { code: "internal_error", message: "oops." } },
  });
  assert.deepEqual(publicApiErrorResult("upstream_unavailable", "down."), {
    status: 503,
    body: { error: { code: "upstream_unavailable", message: "down." } },
  });
});

test("the shared route helper serializes status, body, and no-store together", async () => {
  const response = publicApiJsonResponse(
    publicApiErrorResult("corridor_not_found", "Corridor not found."),
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: { code: "corridor_not_found", message: "Corridor not found." },
  });
});

test("representative public routes return the exact envelope for invalid input", async () => {
  const cases = [
    {
      name: "anchors detail",
      response: await anchorDetailRoute.GET(
        new Request("http://localhost/api/anchors/bad--slug"),
        { params: Promise.resolve({ slug: "bad--slug" }) },
      ),
      code: "invalid_anchor_slug",
    },
    {
      name: "corridors detail",
      response: await corridorDetailRoute.GET(
        new Request("http://localhost/api/corridors/bad--slug"),
        { params: Promise.resolve({ slug: "bad--slug" }) },
      ),
      code: "invalid_corridor_slug",
    },
    {
      name: "reputation detail",
      response: await reputationDetailRoute.GET(
        new Request("http://localhost/api/reputation/bad--slug"),
        { params: Promise.resolve({ slug: "bad--slug" }) },
      ),
      code: "invalid_anchor_slug",
    },
    {
      name: "rates",
      response: await ratesRoute.GET(
        new Request("http://localhost/api/rates?corridor=bad--slug"),
      ),
      code: "invalid_corridor",
    },
  ] as const;

  for (const { name, response, code } of cases) {
    assert.equal(response.status, 400, name);
    assert.equal(response.headers.get("cache-control"), "no-store", name);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["error"], name);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"], name);
    assert.equal(body.error.code, code, name);
    assert.equal(typeof body.error.message, "string", name);
  }

  const missing = await ratesRoute.GET(
    new Request("http://localhost/api/rates"),
  );
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), {
    error: {
      code: "missing_corridor",
      message: "A corridor slug is required.",
    },
  });
});

test("unknown exceptions stay bounded while the reporter receives the original error", async () => {
  const reported: Array<{ error: unknown; operation: string; code: string }> = [];
  const failure = new Error("DATABASE_URL=secret prisma stack trace");

  const result = await getAnchorApiResult("zeam", {
    repository: {
      findAll: async () => [],
      findBySlug: async () => {
        throw failure;
      },
    },
    reportError: (error, context) => {
      reported.push({ error, operation: context.operation, code: context.code });
    },
  });

  assert.deepEqual(result, {
    status: 500,
    body: { error: { code: "internal_error", message: "Unable to load anchors." } },
  });
  assert.deepEqual(Object.keys(result.body.error).sort(), ["code", "message"]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(result).includes("stack"), false);

  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.error, failure);
  assert.equal(reported[0]?.operation, "anchors.detail");
  assert.equal(reported[0]?.code, "internal_error");
});

test("the default reporter is the console seam and swallows nothing silently", async () => {
  let logged = 0;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged += 1;
    assert.match(String(args[0]), /^\[stellarcore:public-api\] rates\.read failed \(internal_error\)$/);
  };
  try {
    const result = await getRatesApiResult("usdc-us-brl-br", {
      readLatestRate: async () => {
        throw new Error("DATABASE_URL=secret read failure");
      },
      reportError: consolePublicApiErrorReporter,
    });
    assert.equal(result.status, 500);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  } finally {
    console.error = original;
  }
  assert.equal(logged, 1);
});
