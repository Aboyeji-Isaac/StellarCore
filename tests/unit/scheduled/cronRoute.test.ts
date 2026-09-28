import assert from "node:assert/strict";
import test from "node:test";

import * as captureRoute from "@/app/api/internal/cron/capture-rates/route";
import * as refreshRoute from "@/app/api/internal/cron/refresh/route";
import * as healthRoute from "@/app/api/internal/capture-health/route";
import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import {
  getCaptureCadenceHealthResponse,
  getRateCaptureResponse,
  getScheduledRefreshResponse,
} from "@/lib/scheduled/http";
import type { CaptureCadenceHealth, RateCaptureRunResult } from "@/types/scheduling";
import type { ScheduledReputationEvaluationResult } from "@/types/scheduled";

const SECRET = "local-test-cron-secret";

const ROUTES = Object.freeze({
  refresh: {
    route: refreshRoute,
    path: "/api/internal/cron/refresh",
    respond: (request: Request, run?: () => Promise<unknown>) =>
      getScheduledRefreshResponse(
        request,
        { cronSecret: SECRET, ...(run ? { run: run as () => Promise<ScheduledReputationEvaluationResult> } : {}) },
      ),
    failureMessage: "Unable to run scheduled reputation evaluation.",
  },
  capture: {
    route: captureRoute,
    path: "/api/internal/cron/capture-rates",
    respond: (request: Request, run?: () => Promise<unknown>) =>
      getRateCaptureResponse(request, {
        cronSecret: SECRET,
        ...(run ? { run: run as () => Promise<RateCaptureRunResult> } : {}),
      }),
    failureMessage: "Unable to run reviewed rate capture.",
  },
  health: {
    route: healthRoute,
    path: "/api/internal/capture-health",
    respond: (request: Request, run?: () => Promise<unknown>) =>
      getCaptureCadenceHealthResponse(
        request,
        { cronSecret: SECRET, ...(run ? { run: run as () => Promise<CaptureCadenceHealth> } : {}) },
      ),
    failureMessage: "Unable to read capture cadence health.",
  },
});

test("cron authorization rejects missing, malformed, and incorrect bearer values", () => {
  assert.equal(hasValidCronAuthorization(null, SECRET), false);
  assert.equal(hasValidCronAuthorization("Basic local-test-cron-secret", SECRET), false);
  assert.equal(hasValidCronAuthorization("Bearer wrong-secret", SECRET), false);
  assert.equal(hasValidCronAuthorization("Bearer local-test-cron-secret extra", SECRET), false);
  assert.equal(hasValidCronAuthorization("Bearer local-test-cron-secret", SECRET), true);
  assert.equal(hasValidCronAuthorization("Bearer local-test-cron-secret", ""), false);
});

test("every authenticated boundary rejects unauthorized requests without running work", async () => {
  for (const entry of Object.values(ROUTES)) {
    let runs = 0;
    for (const authorization of [undefined, "Basic anything", "Bearer wrong-secret"]) {
      const headers = new Headers();
      if (authorization) headers.set("authorization", authorization);
      const response = await entry.respond(
        new Request(`http://localhost${entry.path}`, { headers }),
        async () => {
          runs += 1;
          return {};
        },
      );
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        error: { code: "unauthorized", message: "Unauthorized." },
      });
    }
    assert.equal(runs, 0);
  }
});

test("authorized boundaries return bounded no-store JSON and never echo the secret", async () => {
  const result = reputationResult();
  const response = await getScheduledRefreshResponse(
    new Request(`http://localhost${ROUTES.refresh.path}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    { cronSecret: SECRET, run: async () => result },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, result);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

test("a capture overlap is a successful, truthful 200 rather than an error", async () => {
  const response = await ROUTES.capture.respond(
    new Request(`http://localhost${ROUTES.capture.path}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    async () => ({
      ok: true,
      state: "already_running",
      scheduler: "external",
      contractVersion: 1,
      runId: null,
      configurationFingerprint: "fingerprint",
      scheduledIntervalMs: 60_000,
      lineageRecorded: false,
      errorCode: "ALREADY_RUNNING",
      startedAt: "2026-08-31T16:00:00.000Z",
      completedAt: "2026-08-31T16:00:00.000Z",
      rates: { attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: [], skippedSources: [] },
    }),
  );

  assert.equal(response.status, 200);
  const body = await response.json() as { state: string; rates: { attempted: number } };
  assert.equal(body.state, "already_running");
  assert.equal(body.rates.attempted, 0);
});

test("cadence health is published with its own scope and is never presented as rate evidence", async () => {
  const response = await ROUTES.health.respond(
    new Request(`http://localhost${ROUTES.health.path}`, {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    async () => cadenceHealth(),
  );

  assert.equal(response.status, 200);
  const body = await response.json() as CaptureCadenceHealth;
  assert.equal(body.signalScope, "stellarcore_capture_process");
  assert.equal(body.state, "delayed");
  assert.equal(body.notEvidenceOf.includes("anchor_reachability"), true);
  assert.equal(body.notEvidenceOf.includes("rate_freshness_or_median_eligibility"), true);
  assert.equal(JSON.stringify(body).includes("medianRate"), false);
});

test("fatal failures are safe 500 responses for every boundary", async () => {
  for (const entry of Object.values(ROUTES)) {
    const response = await entry.respond(
      new Request(`http://localhost${entry.path}`, {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      async () => { throw new Error("DATABASE_URL=secret"); },
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: { code: "internal_error", message: entry.failureMessage },
    });
  }
});

test("each boundary is GET-only, dynamic, and Node.js runtime", () => {
  for (const entry of Object.values(ROUTES)) {
    assert.equal(entry.route.dynamic, "force-dynamic");
    assert.equal(entry.route.runtime, "nodejs");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(method in entry.route, false);
    }
  }
});

test("unauthenticated route handlers fail closed without an exposed secret", async () => {
  const previous = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  try {
    assert.equal((await refreshRoute.GET(new Request("http://localhost/x"))).status, 401);
    assert.equal((await captureRoute.GET(new Request("http://localhost/x"))).status, 401);
    assert.equal((await healthRoute.GET(new Request("http://localhost/x"))).status, 401);
  } finally {
    if (previous !== undefined) process.env.CRON_SECRET = previous;
  }
});

function reputationResult(): ScheduledReputationEvaluationResult {
  return Object.freeze({
    job: "reputation-evaluation",
    ok: true,
    startedAt: "2026-08-31T16:00:00.000Z",
    completedAt: "2026-08-31T16:00:01.000Z",
    reputation: { attempted: 3, succeeded: 3, failed: 0, failures: [] },
  });
}

function cadenceHealth(): CaptureCadenceHealth {
  return Object.freeze({
    state: "delayed",
    scheduledIntervalMs: 60_000,
    lastCompletedRunAt: "2026-08-31T16:00:00.000Z",
    ageMs: 90_000,
    missedIntervals: 0,
    contractVersion: 1,
    signalScope: "stellarcore_capture_process",
    notEvidenceOf: Object.freeze([
      "anchor_reachability",
      "price_or_quote_availability",
      "transfer_execution_success",
      "rate_freshness_or_median_eligibility",
    ]),
  });
}
