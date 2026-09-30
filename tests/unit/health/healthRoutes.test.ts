import assert from "node:assert/strict";
import test from "node:test";

import { dynamic as liveDynamic, GET as liveGet } from "@/app/api/health/live/route";
import {
  dynamic as readyDynamic,
  GET as readyGet,
  runtime as readyRuntime,
} from "@/app/api/health/ready/route";
import {
  getLivenessResponse,
  getReadinessResponse,
} from "@/lib/health/http";

test("liveness is database-independent, small, dynamic, and uncached", async () => {
  const response = liveGet();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "alive" });
  assert.equal(liveDynamic, "force-dynamic");
  assert.equal("POST" in await import("@/app/api/health/live/route"), false);
});

test("readiness succeeds when its database check succeeds", async () => {
  const response = await getReadinessResponse(async () => {}, 50);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ready" });
});

test("readiness safely reports dependency failures without leaking details", async () => {
  const response = await getReadinessResponse(async () => {
    throw new Error("DATABASE_URL=secret internal-host stack trace");
  }, 50);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { status: "not_ready" });
  assert.equal(body.includes("secret"), false);
  assert.equal(body.includes("internal-host"), false);
});

test("readiness returns not-ready within its configured timeout", async () => {
  const response = await getReadinessResponse(() => new Promise<void>(() => {}), 5);

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "not_ready" });
});

test("route handlers are dynamic GET-only operational endpoints", async () => {
  assert.equal(readyDynamic, "force-dynamic");
  assert.equal(readyRuntime, "nodejs");
  assert.equal("POST" in await import("@/app/api/health/ready/route"), false);

  const liveResponse = getLivenessResponse();
  assert.equal(liveResponse.headers.get("cache-control"), "no-store");
  assert.equal(typeof readyGet, "function");
});