import assert from "node:assert/strict";
import test from "node:test";

import {
  RATE_CAPTURE_EXECUTION_BUDGET_MS,
  RATE_CAPTURE_EXECUTION_HEADROOM_MS,
  RATE_CAPTURE_MAX_INTERVAL_MS,
  RATE_CAPTURE_ROUTE_PATH,
  RATE_CAPTURE_SCHEDULE_CONTRACT,
  RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
  RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
  REPUTATION_EVALUATION_ROUTE_PATH,
} from "@/constants/scheduling";
import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import {
  assertCaptureScheduleIsDeployable,
  auditCaptureSchedule,
  resolveSelectedRateCaptureScheduler,
} from "@/lib/scheduling/captureCadence";
import { intervalMsFromCronExpression } from "@/lib/scheduling/cronExpression";
import {
  auditDeployedCaptureSchedule,
  CAPTURE_SCHEDULER_MANIFESTS,
} from "@/lib/scheduling/deploymentSchedule";
import type {
  CaptureScheduleDeploymentInput,
  CaptureSchedulerManifest,
} from "@/types/scheduling";

const REPUTATION_CRON = Object.freeze({
  path: REPUTATION_EVALUATION_ROUTE_PATH,
  schedule: "0 0 * * *",
});
const CAPTURE_CRON = Object.freeze({
  path: RATE_CAPTURE_ROUTE_PATH,
  schedule: "* * * * *",
});

test("the maximum supported interval is derived, not duplicated", () => {
  assert.equal(
    RATE_CAPTURE_EXECUTION_HEADROOM_MS,
    RATE_CAPTURE_EXECUTION_BUDGET_MS + RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
  );
  assert.equal(
    RATE_CAPTURE_MAX_INTERVAL_MS,
    RATE_FRESHNESS_THRESHOLD_MS - RATE_CAPTURE_EXECUTION_HEADROOM_MS,
  );
  assert.equal(
    RATE_CAPTURE_SCHEDULE_CONTRACT.maxIntervalMs,
    RATE_CAPTURE_MAX_INTERVAL_MS,
  );

  // Worst case age at read time is interval + documented margin.
  assert.ok(
    RATE_CAPTURE_MAX_INTERVAL_MS + RATE_CAPTURE_EXECUTION_HEADROOM_MS
      === RATE_FRESHNESS_THRESHOLD_MS,
  );
  assert.equal(RATE_CAPTURE_SCHEDULE_CONTRACT.executionBudgetMs, RATE_CAPTURE_EXECUTION_BUDGET_MS);
  assert.equal(RATE_CAPTURE_SCHEDULE_CONTRACT.freshnessThresholdMs, RATE_FRESHNESS_THRESHOLD_MS);
  assert.equal(RATE_CAPTURE_SCHEDULE_CONTRACT.version, RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION);
  assert.equal(Object.isFrozen(RATE_CAPTURE_SCHEDULE_CONTRACT), true);
});

test("cron expressions resolve to the largest provable interval between dispatches", () => {
  assert.equal(intervalMsFromCronExpression("* * * * *"), 60_000);
  assert.equal(intervalMsFromCronExpression("*/2 * * * *"), 120_000);
  assert.equal(intervalMsFromCronExpression("*/5 * * * *"), 300_000);
  assert.equal(intervalMsFromCronExpression("0 * * * *"), 3_600_000);
  assert.equal(intervalMsFromCronExpression("0 0,12 * * *"), 43_200_000);
  assert.equal(intervalMsFromCronExpression("0 0 * * *"), 86_400_000);
  assert.equal(intervalMsFromCronExpression("  */3   *  *  *  * "), 180_000);
});

test("cron expressions that cannot be bounded fail closed instead of being guessed", () => {
  for (const expression of [
    "",
    "* * * *",
    "* * * * * *",
    "*/0 * * * *",
    "*/61 * * * *",
    "60 * * * *",
    "0 24 * * *",
    "0 0 1 * *",
    "0 0 * 6 *",
    "0 0 * * MON",
    "0 0 * * ?",
    "0 0 L * *",
  ]) {
    assert.equal(intervalMsFromCronExpression(expression), null, expression);
  }
});

test("scheduler selection is explicit and fails closed on unknown values", () => {
  assert.equal(resolveSelectedRateCaptureScheduler({}), "disabled");
  assert.equal(resolveSelectedRateCaptureScheduler({ RATE_CAPTURE_SCHEDULER: "" }), "disabled");
  assert.equal(resolveSelectedRateCaptureScheduler({ RATE_CAPTURE_SCHEDULER: "nonsense" }), "disabled");
  assert.equal(resolveSelectedRateCaptureScheduler({ RATE_CAPTURE_SCHEDULER: "VERCEL-CRON" }), "disabled");
  assert.equal(resolveSelectedRateCaptureScheduler({ RATE_CAPTURE_SCHEDULER: "external" }), "external");
  assert.equal(
    resolveSelectedRateCaptureScheduler({ RATE_CAPTURE_SCHEDULER: " vercel-cron " }),
    "vercel-cron",
  );
});

test("the checked-in repository schedule is deployable and capture is not silently enabled", () => {
  const audit = auditDeployedCaptureSchedule({});
  assert.equal(audit.ok, true);
  assert.equal(audit.selectedScheduler, "disabled");
  assert.equal(audit.intervalMs, null);
  assert.deepEqual(audit.issues.map(({ code }) => code), ["CAPTURE_SCHEDULER_DISABLED"]);
  assert.equal(audit.issues[0]!.severity, "warning");
  assert.equal(Object.isFrozen(audit), true);
});

test("an approved external scheduler cadence inside the freshness budget is accepted", () => {
  const audit = auditDeployedCaptureSchedule({ RATE_CAPTURE_SCHEDULER: "external" });
  assert.equal(audit.ok, true);
  assert.equal(audit.selectedScheduler, "external");
  assert.equal(audit.intervalMs, 60_000);
  assert.ok(audit.intervalMs! <= RATE_CAPTURE_MAX_INTERVAL_MS);
  assert.deepEqual(audit.issues, []);
});

test("an approved Vercel Cron cadence is accepted only when the deployment config matches", () => {
  const input = deployment({
    selectedScheduler: "vercel-cron",
    vercelCrons: [REPUTATION_CRON, CAPTURE_CRON],
  });
  const audit = auditCaptureSchedule(input);
  assert.equal(audit.ok, true);
  assert.equal(audit.intervalMs, 60_000);
  assert.doesNotThrow(() => assertCaptureScheduleIsDeployable(audit));
});

test("a capture cadence that cannot fit the freshness budget is rejected", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "vercel-cron",
    vercelCrons: [REPUTATION_CRON, Object.freeze({
      path: RATE_CAPTURE_ROUTE_PATH,
      schedule: "*/5 * * * *",
    })],
  }));

  assert.equal(audit.ok, false);
  assert.equal(audit.intervalMs, 300_000);
  assert.ok(audit.issues.some(({ code }) => code === "CAPTURE_CADENCE_EXCEEDS_FRESHNESS_BUDGET"));
  assert.throws(() => assertCaptureScheduleIsDeployable(audit), /Incompatible rate-capture schedule/);
});

test("an unbounded capture cron expression is rejected rather than assumed safe", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "vercel-cron",
    vercelCrons: [REPUTATION_CRON, Object.freeze({
      path: RATE_CAPTURE_ROUTE_PATH,
      schedule: "0 0 * * MON",
    })],
  }));

  assert.equal(audit.ok, false);
  assert.equal(audit.intervalMs, null);
  assert.ok(audit.issues.some(({ code }) => code === "UNSUPPORTED_CRON_EXPRESSION"));
});

test("selecting Vercel Cron without the deployment cron entry is rejected", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "vercel-cron",
    vercelCrons: [REPUTATION_CRON],
  }));

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "CAPTURE_CRON_MISSING"));
});

test("a schedule that disagrees with the approved manifest is rejected", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "vercel-cron",
    vercelCrons: [REPUTATION_CRON, Object.freeze({
      path: RATE_CAPTURE_ROUTE_PATH,
      schedule: "*/1 * * * *",
    })],
  }));

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "SCHEDULER_MANIFEST_MISMATCH"));
});

test("two schedulers pointed at the capture route are mutually exclusive", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "external",
    vercelCrons: [REPUTATION_CRON, CAPTURE_CRON],
  }));

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "CAPTURE_CRON_UNEXPECTED"));
});

test("scheduling the capture route while the scheduler is disabled is rejected", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "disabled",
    vercelCrons: [REPUTATION_CRON, CAPTURE_CRON],
  }));

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "CAPTURE_CRON_UNEXPECTED"));
  assert.ok(audit.issues.some(({ code }) => code === "CAPTURE_SCHEDULER_DISABLED"));
});

test("the independent reputation job must remain scheduled exactly once", () => {
  const audit = auditCaptureSchedule(deployment({
    selectedScheduler: "external",
    vercelCrons: [],
  }));

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "REPUTATION_CRON_MISSING"));
});

test("an external manifest without a declared interval is rejected", () => {
  const audit = auditCaptureSchedule({
    selectedScheduler: "external",
    vercelCrons: [REPUTATION_CRON],
    manifests: [Object.freeze({
      provider: "external",
      route: RATE_CAPTURE_ROUTE_PATH,
      approvalRequired: true,
    })],
  });

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "SCHEDULER_MANIFEST_MISMATCH"));
});

test("an external cadence beyond the maximum supported interval is rejected", () => {
  const audit = auditCaptureSchedule({
    selectedScheduler: "external",
    vercelCrons: [REPUTATION_CRON],
    manifests: [Object.freeze({
      provider: "external",
      route: RATE_CAPTURE_ROUTE_PATH,
      approvalRequired: true,
      intervalSeconds: RATE_CAPTURE_MAX_INTERVAL_MS / 1_000 + 1,
      dispatch: Object.freeze({ method: "GET", authorization: "bearer_cron_secret" }),
    })],
  });

  assert.equal(audit.ok, false);
  assert.ok(audit.issues.some(({ code }) => code === "CAPTURE_CADENCE_EXCEEDS_FRESHNESS_BUDGET"));
});

test("the maximum supported interval itself is still accepted", () => {
  const audit = auditCaptureSchedule({
    selectedScheduler: "external",
    vercelCrons: [REPUTATION_CRON],
    manifests: [Object.freeze({
      provider: "external",
      route: RATE_CAPTURE_ROUTE_PATH,
      approvalRequired: true,
      intervalSeconds: RATE_CAPTURE_MAX_INTERVAL_MS / 1_000,
      dispatch: Object.freeze({ method: "GET", authorization: "bearer_cron_secret" }),
    })],
  });

  assert.equal(audit.ok, true);
  assert.equal(audit.intervalMs, RATE_CAPTURE_MAX_INTERVAL_MS);
});

test("no approved scheduler is ever enabled without a recorded approval flag", () => {
  for (const manifest of CAPTURE_SCHEDULER_MANIFESTS) {
    assert.equal(manifest.approvalRequired, true, manifest.provider);
    assert.equal(manifest.route, RATE_CAPTURE_ROUTE_PATH);
  }
});

function deployment(
  overrides: Partial<CaptureScheduleDeploymentInput>,
): CaptureScheduleDeploymentInput {
  return {
    selectedScheduler: "disabled",
    vercelCrons: [REPUTATION_CRON],
    manifests: CAPTURE_SCHEDULER_MANIFESTS as readonly CaptureSchedulerManifest[],
    ...overrides,
  };
}
