import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import { GET as getRatesRoute } from "@/app/api/rates/route";
import {
  consolePublicApiErrorReporter,
  publicApiErrorResult,
} from "@/lib/api/errors";
import {
  RATE_LIMIT_ERROR_BODY,
  createRateLimiter,
} from "@/lib/api/rateLimiter";
import { getRatesApiResult } from "@/lib/api/rates";
import {
  REQUEST_ID_HEADER,
  createRequestId,
  isValidRequestId,
  resolveRequestId,
} from "@/lib/api/requestId";

const VALID_REQUEST_ID = "9f1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
const FORGED_VALUES = [
  "short",
  "a".repeat(65),
  "has space 1234",
  "line\nbreak-1234",
  "quoted\"identifier\"",
  "postgresql://admin:super-secret@private-db.internal/core",
  "../../etc/passwd",
];

type ErrorBody = { error: { code: string; message: string; requestId?: string } };

/** Stubs a request whose header value may not be expressible through `Headers`. */
function stubRequest(value: string): Request {
  return { headers: { get: () => value } } as unknown as Request;
}

function captureConsoleError(run: () => void): unknown[][] {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    run();
  } finally {
    console.error = original;
  }
  return calls;
}

test("generated request ids are opaque, valid, and never repeat", () => {
  const first = createRequestId();
  const second = createRequestId();
  assert.equal(isValidRequestId(first), true);
  assert.equal(isValidRequestId(second), true);
  assert.notEqual(first, second);
  assert.equal(first.length >= 8 && first.length <= 64, true);
});

test("a strictly valid inbound request id is propagated unchanged", () => {
  const request = new Request("http://localhost/api/rates", {
    headers: { [REQUEST_ID_HEADER]: VALID_REQUEST_ID },
  });
  assert.equal(resolveRequestId(request), VALID_REQUEST_ID);
});

test("missing, forged, or oversized inbound ids are replaced by a fresh id", () => {
  for (const forged of FORGED_VALUES) {
    const resolved = resolveRequestId(stubRequest(forged));
    assert.equal(isValidRequestId(resolved), true, `unexpected id for ${forged}`);
    assert.notEqual(resolved, forged);
  }

  const generated = resolveRequestId(new Request("http://localhost/api/rates"), {
    generate: () => "fixture-request-id-0001",
  });
  assert.equal(generated, "fixture-request-id-0001");
  assert.equal(isValidRequestId(generated), true);
});

test("public error routes return the same correlation id in body and header", async () => {
  const response = await getRatesRoute(new Request("http://localhost/api/rates", {
    headers: { [REQUEST_ID_HEADER]: VALID_REQUEST_ID },
  }));
  assert.equal(response.status, 400);
  const body = await response.json() as ErrorBody;
  assert.equal(body.error.code, "missing_corridor");
  assert.equal(body.error.requestId, VALID_REQUEST_ID);
  assert.equal(response.headers.get(REQUEST_ID_HEADER.toLowerCase()), VALID_REQUEST_ID);
});

test("a forged inbound id never reaches the response body or header", async () => {
  const forged = "postgresql://admin:super-secret@private-db.internal/core";
  const response = await getRatesRoute(new Request("http://localhost/api/rates", {
    headers: { [REQUEST_ID_HEADER]: forged },
  }));
  const body = await response.json() as ErrorBody;
  assert.equal(response.status, 400);
  assert.equal(body.error.requestId === forged, false);
  assert.equal(isValidRequestId(body.error.requestId ?? ""), true);
  assert.equal(response.headers.get(REQUEST_ID_HEADER.toLowerCase()), body.error.requestId);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("private-db.internal"), false);
});

test("detail routes carry the correlation id on not-found responses", async () => {
  const response = await anchorDetailRoute.GET(
    new Request("http://localhost/api/anchors/bad--slug", {
      headers: { [REQUEST_ID_HEADER]: VALID_REQUEST_ID },
    }),
    { params: Promise.resolve({ slug: "bad--slug" }) },
  );
  const body = await response.json() as ErrorBody;
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "invalid_anchor_slug");
  assert.equal(body.error.requestId, VALID_REQUEST_ID);
});

test("the failure reporter receives the same id as the safe error envelope", async () => {
  const secret = new Error(
    "postgresql://admin:super-secret@private-db.internal/core JWT=eyJ.secret.payload",
  );
  const reported: Array<{ context: { operation: string; code: string; requestId?: string } }> = [];

  const result = await getRatesApiResult("usdc-us-brl-br", {
    requestId: VALID_REQUEST_ID,
    readLatestRate: async () => {
      throw secret;
    },
    reportError: (_error, context) => {
      reported.push({ context });
    },
    staleEvidenceStore: {
      read: async () => null,
      write: async () => {},
    },
  });

  assert.equal(result.status, 500);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.context.requestId, VALID_REQUEST_ID);
  assert.equal(result.body.error.requestId, VALID_REQUEST_ID);
  assert.equal(result.body.error.code, "internal_error");

  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("super-secret"), false);
  assert.equal(serialized.includes("private-db.internal"), false);
  assert.equal(serialized.includes("eyJ.secret.payload"), false);
});

test("a read-model failure that becomes a 500 is still reported with the same id", async () => {
  const reported: Array<{ operation: string; code: string; requestId?: string }> = [];

  const result = await getRatesApiResult("usdc-us-brl-br", {
    requestId: VALID_REQUEST_ID,
    readLatestRate: async (slug) => ({
      ok: false,
      corridorSlug: slug,
      code: "DATABASE_UNAVAILABLE",
    }),
    reportError: (_error, context) => {
      reported.push(context);
    },
    staleEvidenceStore: {
      read: async () => null,
      write: async () => {},
    },
  });

  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "internal_error");
  assert.equal(result.body.error.requestId, VALID_REQUEST_ID);
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.operation, "rates.read");
  assert.equal(reported[0]?.requestId, VALID_REQUEST_ID);
});

test("the structured failure log records the id, operation, code, and internal error", () => {
  const secret = new Error("connect ECONNREFUSED postgresql://admin:super-secret@db");
  const calls = captureConsoleError(() => {
    consolePublicApiErrorReporter(secret, {
      operation: "rates.read",
      code: "internal_error",
      requestId: VALID_REQUEST_ID,
    });
  });

  assert.equal(calls.length, 1);
  const line = String(calls[0]?.[0]);
  assert.match(line, /^\[stellarcore:public-api\] /);
  const entry = JSON.parse(line.replace("[stellarcore:public-api] ", "")) as {
    event: string;
    requestId: string | null;
    operation: string;
    code: string;
    error: { name: string; message: string };
  };
  assert.equal(entry.event, "public_api_error");
  assert.equal(entry.requestId, VALID_REQUEST_ID);
  assert.equal(entry.operation, "rates.read");
  assert.equal(entry.code, "internal_error");
  assert.equal(entry.error.name, "Error");
  // The original error object stays server-side so operators keep the stack.
  assert.equal(calls[0]?.[1], secret);

  const fallbackCalls = captureConsoleError(() => {
    consolePublicApiErrorReporter(secret, {
      operation: "rates.read",
      code: "internal_error",
    });
  });
  const fallbackEntry = JSON.parse(
    String(fallbackCalls[0]?.[0]).replace("[stellarcore:public-api] ", ""),
  ) as { requestId: string | null };
  assert.equal(fallbackEntry.requestId, null);
});

test("rate-limited responses carry the id without changing the safe message", async () => {
  const limiter = createRateLimiter(1, 60_000);
  const now = Date.now();
  const request = new Request("http://localhost/api/rates");

  assert.deepEqual(await limiter.check(request, now, VALID_REQUEST_ID), { allowed: true });
  const blocked = await limiter.check(request, now, VALID_REQUEST_ID);
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) return assert.fail("second request should be blocked");

  const body = await blocked.response.json() as ErrorBody;
  assert.equal(blocked.response.status, 429);
  assert.equal(body.error.code, "rate_limited");
  assert.equal(body.error.message, RATE_LIMIT_ERROR_BODY.error.message);
  assert.equal(body.error.requestId, VALID_REQUEST_ID);
  assert.equal(
    blocked.response.headers.get(REQUEST_ID_HEADER.toLowerCase()),
    VALID_REQUEST_ID,
  );

  const unlabelledLimiter = createRateLimiter(1, 60_000);
  await unlabelledLimiter.check(request, now);
  const unlabelled = await unlabelledLimiter.check(request, now);
  assert.equal(unlabelled.allowed, false);
  if (unlabelled.allowed) return assert.fail("second request should be blocked");
  assert.deepEqual(await unlabelled.response.json(), RATE_LIMIT_ERROR_BODY);
  assert.equal(unlabelled.response.headers.get(REQUEST_ID_HEADER.toLowerCase()), null);
});

test("the shared envelope builder refuses to publish an invalid id", () => {
  const result = publicApiErrorResult("internal_error", "Unable to load.", "not a valid id");
  assert.deepEqual(result.body, {
    error: { code: "internal_error", message: "Unable to load." },
  });
});
