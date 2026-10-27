import assert from "node:assert/strict";
import test from "node:test";

import { dynamic as liveDynamic, GET as liveGet } from "@/app/api/health/live/route";
import * as liveRoute from "@/app/api/health/live/route";
import {
  dynamic as readyDynamic,
  GET as readyGet,
  runtime as readyRuntime,
} from "@/app/api/health/ready/route";
import * as readyRoute from "@/app/api/health/ready/route";
import {
  getLivenessResponse,
  getReadinessResponse,
} from "@/lib/health/http";

const SENSITIVE_STRINGS = [
  "password",
  "secret",
  "postgres://",
  "postgresql://",
  "internal-host",
  "SELECT 1",
  "stack trace",
  "Error: connection lost",
  "rate_snapshots",
  "anchor_records",
  "corridor_directory",
  "reputation_scores",
  "zeam",
  "0.170000000000000001",
];

test("liveness exposes only documented minimal status fields and is database-independent", async () => {
  const response = liveGet();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.json();
  assert.deepEqual(body, { status: "alive" });
  assert.deepEqual(Object.keys(body), ["status"]);

  for (const forbidden of SENSITIVE_STRINGS) {
    assert.equal(JSON.stringify(body).includes(forbidden), false);
  }
});

test("readiness succeeds with documented minimal status fields when database is healthy", async () => {
  const response = await getReadinessResponse(async () => {}, 50);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.json();
  assert.deepEqual(body, { status: "ready" });
  assert.deepEqual(Object.keys(body), ["status"]);

  for (const forbidden of SENSITIVE_STRINGS) {
    assert.equal(JSON.stringify(body).includes(forbidden), false);
  }
});

test("readiness safely represents database failure without exposing evidence rows, internals, or stack traces", async () => {
  const sensitiveError = new Error(
    "FATAL: password authentication failed for user 'postgres' at postgresql://admin:secret_pass@internal-host:5432/stellarcore\n" +
    "at async checkDatabaseConnection (/app/lib/health/http.ts:12:3)\n" +
    "with evidence payload: { anchorSlug: 'zeam', rate: '0.170000000000000001' }",
  );

  const response = await getReadinessResponse(async () => {
    throw sensitiveError;
  }, 50);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const rawText = await response.text();
  const body = JSON.parse(rawText);

  assert.deepEqual(body, { status: "not_ready" });
  assert.deepEqual(Object.keys(body), ["status"]);

  for (const forbidden of SENSITIVE_STRINGS) {
    assert.equal(rawText.includes(forbidden), false, `Response must not contain sensitive string: ${forbidden}`);
  }
  assert.equal(rawText.includes("secret_pass"), false);
  assert.equal(rawText.includes("admin"), false);
  assert.equal(rawText.includes("FATAL"), false);
});

test("readiness returns safe not_ready within configured timeout when database hangs", async () => {
  const hangingDatabaseCheck = () => new Promise<void>(() => {});
  const response = await getReadinessResponse(hangingDatabaseCheck, 10);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.json();
  assert.deepEqual(body, { status: "not_ready" });
  assert.deepEqual(Object.keys(body), ["status"]);
});

test("health check routes are dynamic, nodejs-compatible, and export GET only", async () => {
  assert.equal(liveDynamic, "force-dynamic");
  assert.equal(readyDynamic, "force-dynamic");
  assert.equal(readyRuntime, "nodejs");

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
    assert.equal(method in liveRoute, false, `live route must not export ${method}`);
    assert.equal(method in readyRoute, false, `ready route must not export ${method}`);
  }

  const liveRes = getLivenessResponse();
  assert.equal(liveRes.headers.get("cache-control"), "no-store");
  assert.equal(typeof readyGet, "function");
  assert.equal(typeof liveGet, "function");
});
