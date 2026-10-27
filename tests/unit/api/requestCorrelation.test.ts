import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as anchorsRoute from "@/app/api/anchors/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as corridorsRoute from "@/app/api/corridors/route";
import * as rateHistoryRoute from "@/app/api/rates/history/route";
import * as ratesRoute from "@/app/api/rates/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import * as reputationRoute from "@/app/api/reputation/route";
import { consolePublicApiErrorReporter, publicApiErrorEnvelope } from "@/lib/api/errors";
import { getRatesApiResult } from "@/lib/api/rates";
import { createRateLimiter, RATE_LIMIT_ERROR_BODY } from "@/lib/api/rateLimiter";
import {
  createRequestId,
  isValidRequestId,
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "@/lib/api/requestId";

const CLIENT_ID = "client-trace-0001";
const FORGED_ID = "postgresql://admin:super-secret@private-db.internal/core";

function requestWithRequestId(path: string, requestId: string | null): Request {
  const headers = new Headers();
  if (requestId !== null) headers.set(REQUEST_ID_HEADER, requestId);
  return new Request(`http://localhost${path}`, { headers });
}

function detailContext(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

async function errorBody(response: Response) {
  return await response.json() as {
    error: { code: string; message: string; requestId?: string };
  };
}

test("request id validation accepts only conservative, log-safe identifiers", () => {
  for (const value of [
    "client-trace-0001",
    "5cf4e241-a328-4881-a1e3-8b319d8a7320",
    "Client.Trace_01",
    "a".repeat(8),
    "a".repeat(64),
  ]) {
    assert.equal(isValidRequestId(value), true, `${value} should be accepted`);
  }

  for (const value of [
    "",
    "short",
    "a".repeat(65),
    "-leading-dash",
    "has space here",
    "line\nbreak",
    "quote\"inside",
    FORGED_ID,
    "connect:ECONNREFUSED",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isValidRequestId(value), false, `${String(value)} should be rejected`);
  }
});

test("generated ids are valid and unique", () => {
  const generated = new Set<string>();
  for (let index = 0; index < 200; index += 1) {
    const id = createRequestId();
    assert.equal(isValidRequestId(id), true);
    generated.add(id);
  }
  assert.equal(generated.size, 200);
});

test("a valid inbound id is propagated unchanged", () => {
  assert.equal(
    resolveRequestId(requestWithRequestId("/api/rates", CLIENT_ID)),
    CLIENT_ID,
  );
});

test("an invalid inbound id is replaced, never echoed", () => {
  // Newlines cannot be represented in a `Headers` value at all, so the
  // transport layer rejects them before our validation runs; the pattern tests
  // below cover them directly.
  for (const forged of [FORGED_ID, "short", "a".repeat(65), "connect:ECONNREFUSED"]) {
    const resolved = resolveRequestId(requestWithRequestId("/api/rates", forged));
    assert.equal(isValidRequestId(resolved), true);
    assert.notEqual(resolved, forged);
  }
  const generated = resolveRequestId(requestWithRequestId("/api/rates", null));
  assert.equal(isValidRequestId(generated), true);
});

test("the envelope publishes only code, message, and a validated request id", () => {
  assert.deepEqual(publicApiErrorEnvelope("internal_error", "Unable to load.", CLIENT_ID), {
    error: { code: "internal_error", message: "Unable to load.", requestId: CLIENT_ID },
  });
  assert.deepEqual(publicApiErrorEnvelope("internal_error", "Unable to load."), {
    error: { code: "internal_error", message: "Unable to load." },
  });
  // The builder re-validates, so a bug elsewhere cannot publish a forged value.
  assert.deepEqual(publicApiErrorEnvelope("internal_error", "Unable to load.", FORGED_ID), {
    error: { code: "internal_error", message: "Unable to load." },
  });
});

test("every public GET route echoes the resolved id in the header and the error body", async () => {
  const cases: { name: string; response: Response; status?: number }[] = [
    {
      name: "anchors list",
      status: 400,
      response: await anchorsRoute.GET(new Request("http://localhost/api/anchors?limit=0")),
    },
    {
      name: "anchor detail",
      status: 400,
      response: await anchorDetailRoute.GET(
        new Request("http://localhost/api/anchors/bad--slug"),
        detailContext("bad--slug"),
      ),
    },
    {
      name: "corridors list",
      status: 400,
      response: await corridorsRoute.GET(new Request("http://localhost/api/corridors?limit=0")),
    },
    {
      name: "corridor detail",
      status: 400,
      response: await corridorDetailRoute.GET(
        new Request("http://localhost/api/corridors/bad--slug"),
        detailContext("bad--slug"),
      ),
    },
    {
      name: "rates",
      status: 400,
      response: await ratesRoute.GET(new Request("http://localhost/api/rates")),
    },
    {
      name: "rate history",
      status: 400,
      response: await rateHistoryRoute.GET(
        new Request("http://localhost/api/rates/history?corridor=usdc-us-brl-br&days=bad"),
      ),
    },
    {
      // The reputation list route has no query validation, so its status
      // depends on the database. Only the header contract is unconditional.
      name: "reputation list",
      response: await reputationRoute.GET(new Request("http://localhost/api/reputation")),
    },
    {
      name: "reputation detail",
      status: 400,
      response: await reputationDetailRoute.GET(
        new Request("http://localhost/api/reputation/bad--slug"),
        detailContext("bad--slug"),
      ),
    },
  ];

  for (const { name, response, status } of cases) {
    if (status !== undefined) {
      assert.equal(response.status, status, `${name} should reject the request deterministically`);
    }
    const header = response.headers.get("x-request-id");
    assert.equal(isValidRequestId(header), true, `${name} must publish a request id header`);
    if (response.status < 400) continue;
    const body = await errorBody(response);
    assert.equal(body.error.requestId, header, `${name} body and header must agree`);
    assert.deepEqual(
      Object.keys(body.error).sort(),
      ["code", "message", "requestId"],
      `${name} must publish only the documented safe fields`,
    );
  }
});

test("a client-supplied id is propagated by the route and echoed by the rate limiter budget", async () => {
  const response = await ratesRoute.GET(
    requestWithRequestId("/api/rates?corridor=bad--slug", CLIENT_ID),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("x-request-id"), CLIENT_ID);
  assert.equal((await errorBody(response)).error.requestId, CLIENT_ID);
});

test("a forged inbound id is replaced on every public route", async () => {
  const responses = [
    await anchorDetailRoute.GET(
      requestWithRequestId("/api/anchors/bad--slug", FORGED_ID),
      detailContext("bad--slug"),
    ),
    await corridorDetailRoute.GET(
      requestWithRequestId("/api/corridors/bad--slug", FORGED_ID),
      detailContext("bad--slug"),
    ),
    await reputationDetailRoute.GET(
      requestWithRequestId("/api/reputation/bad--slug", FORGED_ID),
      detailContext("bad--slug"),
    ),
    await rateHistoryRoute.GET(
      requestWithRequestId("/api/rates/history?corridor=usdc-us-brl-br&days=bad", FORGED_ID),
    ),
  ];

  for (const response of responses) {
    const header = response.headers.get("x-request-id");
    assert.equal(isValidRequestId(header), true);
    assert.notEqual(header, FORGED_ID);
    const body = await errorBody(response);
    assert.equal(body.error.requestId, header);
    assert.equal(JSON.stringify(body).includes("super-secret"), false);
    assert.equal(JSON.stringify(body).includes("private-db.internal"), false);
  }
});

test("the 429 response carries the same id the limiter was given", async () => {
  const limiter = createRateLimiter(1, 60_000);
  const now = 1_700_000_000_000;
  const request = new Request("http://localhost/api/anchors");

  assert.deepEqual(
    await limiter.check(request, now, CLIENT_ID),
    { allowed: true },
  );

  const blocked = await limiter.check(request, now, CLIENT_ID);
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) return assert.fail("the second request should be limited");
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.response.headers.get("x-request-id"), CLIENT_ID);
  assert.deepEqual(await blocked.response.json(), {
    error: {
      code: "rate_limited",
      message: "Too many requests. Please try again later.",
      requestId: CLIENT_ID,
    },
  });
});

test("the 429 body is unchanged when no id is available", async () => {
  const limiter = createRateLimiter(1, 60_000);
  const now = 1_700_000_000_000;
  const request = new Request("http://localhost/api/anchors");

  await limiter.check(request, now);
  const blocked = await limiter.check(request, now);
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) return assert.fail("the second request should be limited");
  assert.equal(blocked.response.headers.get("x-request-id"), null);
  assert.deepEqual(await blocked.response.json(), RATE_LIMIT_ERROR_BODY);
});

test("the structured failure log contains the published id, operation, and code", () => {
  const originalError = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };

  try {
    const failure = new Error("postgresql://admin:super-secret@private-db.internal/core");
    consolePublicApiErrorReporter(failure, {
      operation: "rates.read",
      code: "internal_error",
      requestId: CLIENT_ID,
    });
    consolePublicApiErrorReporter(failure, {
      operation: "rates.read",
      code: "internal_error",
      requestId: FORGED_ID,
    });
    consolePublicApiErrorReporter(failure, undefined);
  } finally {
    console.error = originalError;
  }

  assert.equal(calls.length, 3);

  const prefix = "[stellarcore:public-api] ";
  const first = String(calls[0]?.[0]);
  assert.equal(first.startsWith(prefix), true);
  assert.deepEqual(JSON.parse(first.slice(prefix.length)), {
    event: "public_api_error",
    operation: "rates.read",
    code: "internal_error",
    requestId: CLIENT_ID,
  });
  // The original error object stays server-side as the second argument.
  assert.equal(calls[0]?.[1] instanceof Error, true);

  const forged = String(calls[1]?.[0]);
  assert.equal(forged.includes("super-secret"), false);
  assert.equal("requestId" in JSON.parse(forged.slice(prefix.length)), false);

  const missingContext = String(calls[2]?.[0]);
  assert.deepEqual(JSON.parse(missingContext.slice(prefix.length)), {
    event: "public_api_error",
    operation: "unknown",
    code: "internal_error",
  });
});

test("service failures report and publish the same correlation id", async () => {
  const reported: { error: unknown; context?: Record<string, unknown> }[] = [];
  const secret = new Error("postgresql://admin:super-secret@private-db.internal/core");

  const result = await getRatesApiResult("usdc-us-brl-br", {
    readLatestRate: async () => {
      throw secret;
    },
    reportError: (error, context) => {
      reported.push({ error, context: context as Record<string, unknown> });
    },
    staleEvidenceStore: {
      read: async () => null,
      write: async () => {},
    },
    requestId: CLIENT_ID,
  });

  assert.equal(result.status, 500);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.error, secret);
  assert.equal(reported[0]?.context?.requestId, CLIENT_ID);
  assert.equal(reported[0]?.context?.operation, "rates.read");

  if (!("error" in result.body)) return assert.fail("expected an error body");
  assert.equal(result.body.error.requestId, CLIENT_ID);
  assert.equal(JSON.stringify(result.body).includes("super-secret"), false);
});

test("a read-model failure without a stale snapshot is logged with the published id", async () => {
  const reported: { context?: Record<string, unknown> }[] = [];

  const result = await getRatesApiResult("usdc-us-brl-br", {
    readLatestRate: async () => ({
      ok: false,
      corridorSlug: "usdc-us-brl-br",
      code: "DATABASE_UNAVAILABLE",
    }),
    reportError: (_error, context) => {
      reported.push({ context: context as Record<string, unknown> });
    },
    staleEvidenceStore: {
      read: async () => null,
      write: async () => {},
    },
    requestId: CLIENT_ID,
  });

  assert.equal(result.status, 500);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.context?.requestId, CLIENT_ID);
  assert.equal(reported[0]?.context?.operation, "rates.read_model");

  if (!("error" in result.body)) return assert.fail("expected an error body");
  assert.equal(result.body.error.code, "internal_error");
  assert.equal(result.body.error.requestId, CLIENT_ID);
});
