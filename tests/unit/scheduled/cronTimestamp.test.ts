import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CRON_TIMESTAMP_SKEW_MS,
  evaluateCronTimestamp,
} from "@/lib/scheduled/cronTimestamp";
import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import type { ScheduledRefreshResult } from "@/types/scheduled";

// Fixed clock: behavior at the boundaries is deterministic, no sleeps.
const NOW = new Date("2026-10-20T12:00:00.000Z");
const SKEW = DEFAULT_CRON_TIMESTAMP_SKEW_MS; // 5 minutes
const SECRET = "local-test-cron-secret";

function at(msOffsetFromNow: number): string {
  return new Date(NOW.getTime() + msOffsetFromNow).toISOString();
}

function evaluate(timestamp: string | undefined) {
  return evaluateCronTimestamp({ timestamp, now: () => NOW });
}

test("timestamps inside the allowed clock-skew window are accepted as documented", () => {
  assert.deepEqual(evaluate(at(0)), { ok: true, code: "WITHIN_WINDOW" });
  assert.deepEqual(evaluate(at(-SKEW / 2)), { ok: true, code: "WITHIN_WINDOW" });
  assert.deepEqual(evaluate(at(SKEW / 2)), { ok: true, code: "WITHIN_WINDOW" });
  // Inclusive bounds: exactly at the edges is still inside.
  assert.deepEqual(evaluate(at(-SKEW)), { ok: true, code: "WITHIN_WINDOW" });
  assert.deepEqual(evaluate(at(SKEW)), { ok: true, code: "WITHIN_WINDOW" });
});

test("expired timestamps are rejected outside the lower boundary", () => {
  assert.deepEqual(evaluate(at(-SKEW - 1)), {
    ok: false,
    code: "TIMESTAMP_EXPIRED",
  });
  assert.deepEqual(evaluate(at(-2 * SKEW)), {
    ok: false,
    code: "TIMESTAMP_EXPIRED",
  });
});

test("future-dated timestamps are rejected outside the upper boundary", () => {
  assert.deepEqual(evaluate(at(SKEW + 1)), {
    ok: false,
    code: "TIMESTAMP_FUTURE",
  });
  assert.deepEqual(evaluate(at(2 * SKEW)), {
    ok: false,
    code: "TIMESTAMP_FUTURE",
  });
});

test("missing, blank, and malformed timestamps are rejected as invalid", () => {
  assert.deepEqual(evaluate(undefined), { ok: false, code: "TIMESTAMP_INVALID" });
  assert.deepEqual(evaluate(""), { ok: false, code: "TIMESTAMP_INVALID" });
  assert.deepEqual(evaluate("   "), { ok: false, code: "TIMESTAMP_INVALID" });
  assert.deepEqual(evaluate("not-a-timestamp"), {
    ok: false,
    code: "TIMESTAMP_INVALID",
  });
  assert.deepEqual(evaluate("2026-13-45T99:99:99Z"), {
    ok: false,
    code: "TIMESTAMP_INVALID",
  });
});

test("a negative or non-integer skew never widens the window", () => {
  assert.deepEqual(
    evaluateCronTimestamp({ timestamp: at(-SKEW - 1), now: () => NOW, allowedSkewMs: -1 }),
    { ok: false, code: "TIMESTAMP_INVALID" },
  );
  assert.deepEqual(
    evaluateCronTimestamp({ timestamp: at(0), now: () => NOW, allowedSkewMs: 1.5 }),
    { ok: false, code: "TIMESTAMP_INVALID" },
  );
});

test("rejected windowed requests never invoke the scheduled refresh", async () => {
  let runs = 0;
  const run = async (): Promise<ScheduledRefreshResult> => {
    runs += 1;
    return Object.freeze({
      ok: true,
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      rates: Object.freeze({ attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [], skippedSources: [] }),
      reputation: Object.freeze({ attempted: 0, succeeded: 0, failed: 0, failures: [] }),
    });
  };

  const signature = "signature-material";
  const outOfWindow = await getScheduledRefreshResponse(
    new Request("http://localhost/api/internal/cron/refresh", {
      headers: {
        authorization: `Bearer ${SECRET}`,
        "x-cron-timestamp": at(-SKEW - 1),
        "x-cron-signature": signature,
      },
    }),
    {
      cronSecret: SECRET,
      cronTimestampNow: () => NOW,
      run,
    },
  );
  assert.equal(outOfWindow.status, 401);
  assert.equal(runs, 0);
});

test("a timestamp inside the window passes the HTTP boundary and runs the job", async () => {
  let runs = 0;
  const response = await getScheduledRefreshResponse(
    new Request("http://localhost/api/internal/cron/refresh", {
      headers: {
        authorization: `Bearer ${SECRET}`,
        "x-cron-timestamp": at(0),
      },
    }),
    {
      cronSecret: SECRET,
      cronTimestampNow: () => NOW,
      run: async () => {
        runs += 1;
        return Object.freeze({
          ok: true,
          startedAt: NOW.toISOString(),
          completedAt: NOW.toISOString(),
          rates: Object.freeze({ attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [], skippedSources: [] }),
          reputation: Object.freeze({ attempted: 0, succeeded: 0, failed: 0, failures: [] }),
        });
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(runs, 1);
});

test("rejection error responses reveal no signing material", async () => {
  const sentinel = "super-secret-signature";
  const response = await getScheduledRefreshResponse(
    new Request("http://localhost/api/internal/cron/refresh", {
      headers: {
        authorization: `Bearer ${SECRET}`,
        "x-cron-timestamp": at(SKEW + 5),
        "x-cron-signature": sentinel,
      },
    }),
    {
      cronSecret: SECRET,
      cronTimestampNow: () => NOW,
      run: async () => {
        throw new Error("must not run");
      },
    },
  );

  const body = await response.text();
  assert.equal(response.status, 401);
  assert.equal(body.includes(sentinel), false);
  assert.equal(body.includes(SECRET), false);
  assert.deepEqual(JSON.parse(body), {
    error: { code: "unauthorized", message: "Unauthorized." },
  });
});
