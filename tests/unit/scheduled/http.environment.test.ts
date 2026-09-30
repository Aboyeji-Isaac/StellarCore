import assert from "node:assert/strict";
import test from "node:test";

import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import type { ScheduledRefreshResult } from "@/types/scheduled";

const SECRET = "test-cron-secret";

function refreshResult(): ScheduledRefreshResult {
  return Object.freeze({
    ok: true,
    startedAt: "2026-09-30T00:00:00.000Z",
    completedAt: "2026-09-30T00:00:01.000Z",
    rates: {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      failures: [],
    },
    reputation: { attempted: 0, succeeded: 0, failed: 0, failures: [] },
  });
}

function request(): Request {
  return new Request("https://stellarcore.example/api/internal/cron/refresh", {
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

test("a failing environment identity check fails the refresh closed with a bounded error", async () => {
  const response = await getScheduledRefreshResponse(request(), {
    cronSecret: SECRET,
    assertEnvironment: async () => ({
      ok: false,
      code: "DATABASE_ENVIRONMENT_MISMATCH",
      message: "Refusing to connect: the runtime environment and the durable database environment identity are incompatible.",
    }),
    run: async () => {
      throw new Error("refresh must not run when the environment guard fails");
    },
  });

  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  assert.equal(body.error.code, "environment_identity_failure");
  assert.equal(body.error.message.includes("postgres"), false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("a passing environment identity check lets the scheduled refresh run", async () => {
  let ran = false;
  const response = await getScheduledRefreshResponse(request(), {
    cronSecret: SECRET,
    assertEnvironment: async () => ({ ok: true }),
    run: async () => {
      ran = true;
      return refreshResult();
    },
  });

  assert.equal(response.status, 200);
  assert.equal(ran, true);
});

test("the environment guard runs after authorization so unauthenticated probes learn nothing", async () => {
  let guardCalled = false;
  const response = await getScheduledRefreshResponse(
    new Request("https://stellarcore.example/api/internal/cron/refresh"),
    {
      cronSecret: SECRET,
      assertEnvironment: async () => {
        guardCalled = true;
        return { ok: true };
      },
      run: async () => refreshResult(),
    },
  );
  assert.equal(response.status, 401);
  assert.equal(guardCalled, false);
});
