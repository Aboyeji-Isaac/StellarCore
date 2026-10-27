import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as anchorsListRoute from "@/app/api/anchors/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as corridorsListRoute from "@/app/api/corridors/route";
import * as ratesRoute from "@/app/api/rates/route";
import * as rateHistoryRoute from "@/app/api/rates/history/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import * as reputationListRoute from "@/app/api/reputation/route";

import { isValidRequestId } from "@/lib/api/requestId";
import {
  getAnchorApiResult,
  getAnchorsApiResult,
} from "@/lib/api/anchors";
import {
  getCorridorApiResult,
  getCorridorsApiResult,
} from "@/lib/api/corridors";
import { getRatesApiResult } from "@/lib/api/rates";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import {
  getAnchorReputationApiResult,
  getReputationApiResult,
} from "@/lib/api/reputation";

import {
  PUBLIC_API_ERROR_CODES,
  PUBLIC_API_ERROR_STATUS_BY_CODE,
  type PublicApiErrorCode,
} from "@/types/api/errors";

/**
 * Pinned public error codes and canonical public error messages across all
 * public evidence endpoints. These exact string constants must remain stable
 * across internal refactorings.
 */
type PublicErrorBody = Readonly<{
  error: Readonly<{ code: string; message: string }>;
}>;

function errorBody(result: { readonly body: unknown }): PublicErrorBody {
  assert.ok(
    typeof result.body === "object"
      && result.body !== null
      && "error" in result.body,
    "Expected a public API error body",
  );
  return result.body as PublicErrorBody;
}

const CANONICAL_ERROR_CONTRACT = Object.freeze({
  validation: [
    {
      name: "missing_corridor on /api/rates",
      endpoint: "/api/rates",
      invoke: () => getRatesApiResult(null),
      expectedStatus: 400,
      expectedCode: "missing_corridor",
      expectedMessage: "A corridor slug is required.",
    },
    {
      name: "invalid_corridor on /api/rates",
      endpoint: "/api/rates?corridor=invalid--slug",
      invoke: () => getRatesApiResult("invalid--slug"),
      expectedStatus: 400,
      expectedCode: "invalid_corridor",
      expectedMessage: "The corridor slug is invalid.",
    },
    {
      name: "missing_corridor on /api/rates/history",
      endpoint: "/api/rates/history",
      invoke: () => getRateHistoryApiResult(null),
      expectedStatus: 400,
      expectedCode: "missing_corridor",
      expectedMessage: "A corridor slug is required.",
    },
    {
      name: "invalid_corridor on /api/rates/history",
      endpoint: "/api/rates/history?corridor=invalid--slug",
      invoke: () => getRateHistoryApiResult("invalid--slug"),
      expectedStatus: 400,
      expectedCode: "invalid_corridor",
      expectedMessage: "The corridor slug is invalid.",
    },
    {
      name: "invalid_days on /api/rates/history (negative/zero/out-of-range)",
      endpoint: "/api/rates/history?corridor=usdc-us-brl-br&days=0",
      invoke: () => getRateHistoryApiResult("usdc-us-brl-br", "0"),
      expectedStatus: 400,
      expectedCode: "invalid_days",
      expectedMessage: "The days parameter must be an integer between 1 and 365.",
    },
    {
      name: "invalid_anchor_slug on /api/anchors/[slug]",
      endpoint: "/api/anchors/invalid--slug",
      invoke: () => getAnchorApiResult("invalid--slug"),
      expectedStatus: 400,
      expectedCode: "invalid_anchor_slug",
      expectedMessage: "A valid anchor slug is required.",
    },
    {
      name: "invalid_corridor_slug on /api/corridors/[slug]",
      endpoint: "/api/corridors/invalid--slug",
      invoke: () => getCorridorApiResult("invalid--slug"),
      expectedStatus: 400,
      expectedCode: "invalid_corridor_slug",
      expectedMessage: "A valid corridor slug is required.",
    },
    {
      name: "invalid_anchor_slug on /api/reputation/[slug]",
      endpoint: "/api/reputation/invalid--slug",
      invoke: () => getAnchorReputationApiResult("invalid--slug"),
      expectedStatus: 400,
      expectedCode: "invalid_anchor_slug",
      expectedMessage: "A valid anchor slug is required.",
    },
    {
      name: "invalid_pagination on /api/anchors",
      endpoint: "/api/anchors?limit=0",
      invoke: () => getAnchorsApiResult({}, { limit: "0", offset: null }),
      expectedStatus: 400,
      expectedCode: "invalid_pagination",
      expectedMessage: "limit must be a positive integer no greater than 100.",
    },
    {
      name: "invalid_pagination on /api/corridors",
      endpoint: "/api/corridors?limit=0",
      invoke: () => getCorridorsApiResult({}, { limit: "0", offset: null }),
      expectedStatus: 400,
      expectedCode: "invalid_pagination",
      expectedMessage: "limit must be a positive integer no greater than 100.",
    },
  ],
  missingResource: [
    {
      name: "corridor_not_found on /api/rates",
      endpoint: "/api/rates?corridor=unknown-corridor",
      invoke: () =>
        getRatesApiResult("unknown-corridor", {
          readLatestRate: async () => ({
            ok: false,
            corridorSlug: "unknown-corridor",
            code: "CORRIDOR_NOT_FOUND",
          }),
        }),
      expectedStatus: 404,
      expectedCode: "corridor_not_found",
      expectedMessage: "Corridor not found.",
    },
    {
      name: "corridor_not_found on /api/rates/history",
      endpoint: "/api/rates/history?corridor=unknown-corridor",
      invoke: () =>
        getRateHistoryApiResult("unknown-corridor", null, {
          readHistory: async () => ({
            ok: false,
            corridorSlug: "unknown-corridor",
            code: "CORRIDOR_NOT_FOUND",
          }),
        }),
      expectedStatus: 404,
      expectedCode: "corridor_not_found",
      expectedMessage: "Corridor not found.",
    },
    {
      name: "anchor_not_found on /api/anchors/[slug]",
      endpoint: "/api/anchors/unknown-anchor",
      invoke: () =>
        getAnchorApiResult("unknown-anchor", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => null,
          },
        }),
      expectedStatus: 404,
      expectedCode: "anchor_not_found",
      expectedMessage: "Anchor not found.",
    },
    {
      name: "corridor_not_found on /api/corridors/[slug]",
      endpoint: "/api/corridors/unknown-corridor",
      invoke: () =>
        getCorridorApiResult("unknown-corridor", {
          repository: {
            findBySlug: async () => null,
          },
        }),
      expectedStatus: 404,
      expectedCode: "corridor_not_found",
      expectedMessage: "Corridor not found.",
    },
    {
      name: "anchor_not_found on /api/reputation/[slug]",
      endpoint: "/api/reputation/unknown-anchor",
      invoke: () =>
        getAnchorReputationApiResult("unknown-anchor", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => null,
          },
        }),
      expectedStatus: 404,
      expectedCode: "anchor_not_found",
      expectedMessage: "Anchor not found.",
    },
  ],
  serverError: [
    {
      name: "internal_error on /api/rates",
      endpoint: "/api/rates",
      invoke: () =>
        getRatesApiResult("usdc-us-brl-br", {
          readLatestRate: async () => {
            throw new Error("Simulated Postgres pool exhaustion error");
          },
          staleEvidenceStore: { read: async () => null, write: async () => {} },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to read rates.",
    },
    {
      name: "internal_error on /api/rates/history",
      endpoint: "/api/rates/history",
      invoke: () =>
        getRateHistoryApiResult("usdc-us-brl-br", null, {
          readHistory: async () => {
            throw new Error("Simulated Postgres connection timeout");
          },
          staleEvidenceStore: { read: async () => null, write: async () => {} },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to read rate history.",
    },
    {
      name: "internal_error on /api/anchors",
      endpoint: "/api/anchors",
      invoke: () =>
        getAnchorsApiResult({
          repository: {
            findAll: async () => {
              throw new Error("Simulated database failure");
            },
            findBySlug: async () => null,
          },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to load anchors.",
    },
    {
      name: "internal_error on /api/anchors/[slug]",
      endpoint: "/api/anchors/test-anchor",
      invoke: () =>
        getAnchorApiResult("test-anchor", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => {
              throw new Error("Simulated database failure");
            },
          },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to load anchors.",
    },
    {
      name: "internal_error on /api/corridors",
      endpoint: "/api/corridors",
      invoke: () =>
        getCorridorsApiResult({
          repository: {
            findAll: async () => {
              throw new Error("Simulated database failure");
            },
          },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to load corridors.",
    },
    {
      name: "internal_error on /api/corridors/[slug]",
      endpoint: "/api/corridors/test-corridor",
      invoke: () =>
        getCorridorApiResult("test-corridor", {
          repository: {
            findBySlug: async () => {
              throw new Error("Simulated database failure");
            },
          },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to load corridor.",
    },
    {
      name: "internal_error on /api/reputation",
      endpoint: "/api/reputation",
      invoke: () =>
        getReputationApiResult({
          repository: {
            findAll: async () => {
              throw new Error("Simulated database failure");
            },
            findBySlug: async () => null,
          },
          staleEvidenceStore: { read: async () => null, write: async () => {} },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to load reputation.",
    },
    {
      name: "internal_error on /api/reputation/[slug]",
      endpoint: "/api/reputation/test-anchor",
      invoke: () =>
        getAnchorReputationApiResult("test-anchor", {
          repository: {
            findAll: async () => [],
            findBySlug: async () => {
              throw new Error("Simulated database failure");
            },
          },
          staleEvidenceStore: { read: async () => null, write: async () => {} },
          reportError: () => {},
        }),
      expectedStatus: 500,
      expectedCode: "internal_error",
      expectedMessage: "Unable to load reputation.",
    },
  ],
});

test("documented error codes and message categories remain stable for validation errors", async () => {
  for (const entry of CANONICAL_ERROR_CONTRACT.validation) {
    const result = await entry.invoke();
    assert.equal(
      result.status,
      entry.expectedStatus,
      `${entry.name} status must be ${entry.expectedStatus}`,
    );
    assert.equal(
      errorBody(result).error.code,
      entry.expectedCode,
      `${entry.name} code must be ${entry.expectedCode}`,
    );
    assert.equal(
      errorBody(result).error.message,
      entry.expectedMessage,
      `${entry.name} message must strictly match canonical contract`,
    );
  }
});

test("documented error codes and message categories remain stable for missing resources (404)", async () => {
  for (const entry of CANONICAL_ERROR_CONTRACT.missingResource) {
    const result = await entry.invoke();
    assert.equal(
      result.status,
      entry.expectedStatus,
      `${entry.name} status must be ${entry.expectedStatus}`,
    );
    assert.equal(
      errorBody(result).error.code,
      entry.expectedCode,
      `${entry.name} code must be ${entry.expectedCode}`,
    );
    assert.equal(
      errorBody(result).error.message,
      entry.expectedMessage,
      `${entry.name} message must strictly match canonical contract`,
    );
  }
});

test("documented error codes and message categories remain stable for server errors (500)", async () => {
  for (const entry of CANONICAL_ERROR_CONTRACT.serverError) {
    const result = await entry.invoke();
    assert.equal(
      result.status,
      entry.expectedStatus,
      `${entry.name} status must be ${entry.expectedStatus}`,
    );
    assert.equal(
      errorBody(result).error.code,
      entry.expectedCode,
      `${entry.name} code must be ${entry.expectedCode}`,
    );
    assert.equal(
      errorBody(result).error.message,
      entry.expectedMessage,
      `${entry.name} message must strictly match canonical contract`,
    );
  }
});

test("internal exception messages and secrets are never exposed as public text", async () => {
  const sensitiveStrings = [
    "password=super_secret_pwd",
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "SELECT * FROM \"users\" WHERE \"secret\" IS NOT NULL",
    "FATAL 28000: password authentication failed for user postgres",
    "private-db-host.internal.network:5432",
    "ECONNREFUSED 127.0.0.1:5432",
  ];

  for (const leak of sensitiveStrings) {
    const error = new Error(`Internal database error: ${leak}`);

    const result = await getRatesApiResult("usdc-us-brl-br", {
      readLatestRate: async () => {
        throw error;
      },
      staleEvidenceStore: { read: async () => null, write: async () => {} },
      reportError: () => {},
    });

    const json = JSON.stringify(result);
    assert.equal(
      json.includes(leak),
      false,
      `Public response must not leak sensitive detail: ${leak}`,
    );
    assert.equal(
      errorBody(result).error.message,
      "Unable to read rates.",
      "Must return stable sanitized message",
    );
  }
});

test("public HTTP routes produce exact canonical error response payloads and headers", async () => {
  const response = await ratesRoute.GET(new Request("http://localhost/api/rates"));
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "application/json");

  const body = (await response.json()) as {
    error: { code: string; message: string; requestId?: string };
  };
  // The correlation id is additive and per-request: the canonical payload is
  // unchanged, and the id in the body must match the response header (#369).
  assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  assert.equal(isValidRequestId(body.error.requestId), true);
  const { requestId: _requestId, ...canonicalError } = body.error;
  assert.deepEqual({ error: canonicalError }, {
    error: {
      code: "missing_corridor",
      message: "A corridor slug is required.",
    },
  });
});
