import assert from "node:assert/strict";
import test from "node:test";

import * as route from "@/app/api/internal/cron/refresh/route";
import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import type { ScheduledRefreshResult } from "@/types/scheduled";

const SECRET = "local-test-cron-secret";

test("cron authorization rejects missing, malformed, and incorrect bearer values", () => {
  assert.equal(hasValidCronAuthorization(null, SECRET), false);
  assert.equal(hasValidCronAuthorization("Basic local-test-cron-secret", SECRET), false);
  assert.equal(hasValidCronAuthorization("Bearer wrong-secret", SECRET), false);
  assert.equal(hasValidCronAuthorization("Bearer local-test-cron-secret extra", SECRET), false);
  assert.equal(hasValidCronAuthorization("Bearer local-test-cron-secret", SECRET), true);
  assert.equal(hasValidCronAuthorization("Bearer local-test-cron-secret", ""), false);
});

test("unauthorized scheduled requests do not run jobs and use a safe 401 contract", async () => {
  let runs = 0;
  for (const authorization of [undefined, "Basic anything", "Bearer wrong-secret"]) {
    const headers = new Headers();
    if (authorization) headers.set("authorization", authorization);
    const response = await getScheduledRefreshResponse(
      new Request("http://localhost/api/internal/cron/refresh", { headers }),
      { cronSecret: SECRET, run: async () => { runs += 1; return successfulRun(); } },
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: { code: "unauthorized", message: "Unauthorized." },
    });
  }
  assert.equal(runs, 0);
});

test("authorized scheduled requests return only bounded JSON and preserve partial run status", async () => {
  const result = successfulRun({ ok: false, rates: {
    attempted: 1,
    succeeded: 0,
    failed: 1,
    skipped: 0,
    failures: [{ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" }],
  } });
  const response = await getScheduledRefreshResponse(
    new Request("http://localhost/api/internal/cron/refresh", {
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

test("fatal job failures are a safe 500 and the route stays GET-only dynamic", async () => {
  const response = await getScheduledRefreshResponse(
    new Request("http://localhost/api/internal/cron/refresh", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    {
      cronSecret: SECRET,
      run: async () => { throw new Error("DATABASE_URL=secret"); },
    },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: "internal_error", message: "Unable to run scheduled refresh." },
  });
  assert.equal(route.dynamic, "force-dynamic");
  assert.equal(route.runtime, "nodejs");
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(method in route, false);
  }
  const missing = await route.GET(new Request("http://localhost/api/internal/cron/refresh"));
  assert.equal(missing.status, 401);
});

function successfulRun(overrides: Partial<ScheduledRefreshResult> = {}): ScheduledRefreshResult {
  return Object.freeze({
    ok: true,
    startedAt: "2026-08-31T16:00:00.000Z",
    completedAt: "2026-08-31T16:00:01.000Z",
    rates: Object.freeze({ attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] }),
    reputation: Object.freeze({ attempted: 3, succeeded: 3, failed: 0, failures: [] }),
    ...overrides,
  });
}

test("signed requests: bearer mode ignores signatures, either mode prefers them, signed mode requires them", async () => {
  const { signCronRequest } = await import("@/lib/scheduled/signedCronAuth");
  const now = new Date("2026-09-30T12:00:00.000Z");
  const seen = new Set<string>();
  const nonceStore = { reserve: async (nonce: string) => !seen.has(nonce) && !!seen.add(nonce) };
  const url = "http://localhost/api/internal/cron/refresh";
  const signedHeaders = (nonce: string, secret = SECRET) => signCronRequest({
    method: "GET", pathAndQuery: "/api/internal/cron/refresh", secret,
    timestampSeconds: now.getTime() / 1_000, nonce,
  });
  let runs = 0;
  const call = async (mode: "bearer" | "either" | "signed", headers: Record<string, string>) => {
    const response = await getScheduledRefreshResponse(new Request(url, { headers }), {
      cronSecret: SECRET, authMode: mode, nonceStore, now: () => now,
      run: async () => { runs += 1; return successfulRun(); },
    });
    return response.status;
  };
  const bearer = { authorization: `Bearer ${SECRET}` };

  assert.equal(await call("bearer", bearer), 200);
  assert.equal(await call("bearer", signedHeaders("bearermodenonce012345")), 401);
  assert.equal(await call("signed", bearer), 401);
  assert.equal(await call("signed", signedHeaders("signedmodenonce012345")), 200);
  assert.equal(await call("signed", signedHeaders("signedmodenonce012345")), 401);
  assert.equal(await call("either", bearer), 200);
  assert.equal(await call("either", signedHeaders("eithermodenonce012345")), 200);
  // Signature headers make the request a signed one: a valid bearer cannot rescue a bad signature.
  assert.equal(await call("either", { ...bearer, ...signedHeaders("eitherbadsig0123456789", "wrong-secret") }), 401);
  assert.equal(runs, 4);
});

test("an invalid CRON_AUTH_MODE or an unavailable nonce store fails closed with a safe 500", async () => {
  const { parseCronAuthMode } = await import("@/lib/scheduled/http");
  assert.equal(parseCronAuthMode(undefined), "bearer");
  assert.equal(parseCronAuthMode(""), "bearer");
  assert.throws(() => parseCronAuthMode("sometimes"));

  const { signCronRequest } = await import("@/lib/scheduled/signedCronAuth");
  const now = new Date("2026-09-30T12:00:00.000Z");
  let runs = 0;
  const response = await getScheduledRefreshResponse(
    new Request("http://localhost/api/internal/cron/refresh", {
      headers: signCronRequest({ method: "GET", pathAndQuery: "/api/internal/cron/refresh", secret: SECRET, timestampSeconds: now.getTime() / 1_000, nonce: "unavailablenonce01234" }),
    }),
    {
      cronSecret: SECRET, authMode: "signed", now: () => now,
      nonceStore: { reserve: async () => { throw new Error("connection to db failed: password=hunter2"); } },
      run: async () => { runs += 1; return successfulRun(); },
    },
  );
  assert.equal(response.status, 500);
  assert.equal(JSON.stringify(await response.json()).includes("hunter2"), false);
  assert.equal(runs, 0);
});
