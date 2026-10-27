import assert from "node:assert/strict";
import test from "node:test";

import {
  ANCHOR_DETERMINISTIC_DOWN_THRESHOLD,
  ANCHOR_RECOVERY_SUCCESS_THRESHOLD,
  ANCHOR_TRANSIENT_DEGRADED_THRESHOLD,
  ANCHOR_TRANSIENT_DOWN_THRESHOLD,
  ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS,
} from "@/constants/anchorHealth";
import {
  applyAnchorHealthObservation,
  initialAnchorHealthState,
} from "@/lib/stellar/anchorHealth";
import type {
  AnchorFailureClass,
  AnchorHealthObservation,
  AnchorHealthState,
  AnchorHealthTransition,
} from "@/types/anchorHealth";

/**
 * #459 — equality at every configured hysteresis boundary.
 *
 * The availability policy is threshold-based, so the values that decide
 * behavior are the exact ones: `threshold - 1`, `threshold`, `threshold + 1`.
 * Every table below is generated from the constants rather than hard-coded
 * counts, and the constants themselves are pinned in the first test. A policy
 * change therefore fails here loudly instead of silently skewing a row.
 *
 * Observations are applied in a fixed, monotonically increasing order from a
 * fixed origin. Nothing reads the wall clock, the network, or the database, so
 * every run is reproducible.
 */

const ORIGIN_MS = Date.parse("2026-10-20T00:00:00.000Z");
const STEP_MS = 60_000;

type Trace = Readonly<{
  beforeStatuses: readonly string[];
  statuses: readonly string[];
  changed: readonly boolean[];
  transitions: readonly AnchorHealthTransition[];
  final: AnchorHealthState;
}>;

function drive(
  from: AnchorHealthState,
  observations: readonly AnchorHealthObservation[],
): Trace {
  let state = from;
  const beforeStatuses: string[] = [];
  const transitions: AnchorHealthTransition[] = [];

  for (const observation of observations) {
    beforeStatuses.push(state.status);
    const transition = applyAnchorHealthObservation(state, observation);
    transitions.push(transition);
    state = transition.next;
  }

  return {
    beforeStatuses,
    statuses: transitions.map(({ status }) => status),
    changed: transitions.map(({ statusChanged }) => statusChanged),
    transitions,
    final: state,
  };
}

function successAt(ms: number): AnchorHealthObservation {
  return { outcome: "SUCCESS", occurredAt: new Date(ms) };
}

function failureAt(
  ms: number,
  failureClass: AnchorFailureClass,
): AnchorHealthObservation {
  return {
    outcome: "FAILURE",
    occurredAt: new Date(ms),
    failure: { failureClass, code: `${failureClass}_FAILURE` },
  };
}

function failures(
  count: number,
  failureClass: AnchorFailureClass,
  startMs: number = ORIGIN_MS,
): AnchorHealthObservation[] {
  return Array.from({ length: count }, (_, index) =>
    failureAt(startMs + index * STEP_MS, failureClass));
}

function successes(count: number, startMs: number = ORIGIN_MS): AnchorHealthObservation[] {
  return Array.from({ length: count }, (_, index) =>
    successAt(startMs + index * STEP_MS));
}

/**
 * A LIVE anchor with no failure history. Built through the policy's own
 * first-ever-success rule rather than by hand, so the starting state is one
 * the state machine can actually produce.
 */
function liveState(): AnchorHealthState {
  return drive(initialAnchorHealthState("anchor-boundary"), [successAt(ORIGIN_MS)]).final;
}

/** DEGRADED carrying one recorded failure (counter is 1, not reset). */
function degradedState(): AnchorHealthState {
  const trace = drive(liveState(), [failureAt(ORIGIN_MS, "DETERMINISTIC")]);

  assert.equal(trace.final.status, "DEGRADED");
  assert.equal(trace.final.consecutiveFailures, 1);

  return trace.final;
}

function downState(): AnchorHealthState {
  const trace = drive(
    liveState(),
    failures(ANCHOR_TRANSIENT_DOWN_THRESHOLD, "TRANSIENT"),
  );

  assert.equal(trace.final.status, "DOWN");

  return trace.final;
}

type Position = "just below" | "exactly at" | "just above";

const POSITIONS: ReadonlyArray<Readonly<{ position: Position; offset: number }>> = [
  { position: "just below", offset: -1 },
  { position: "exactly at", offset: 0 },
  { position: "just above", offset: 1 },
];

test("hysteresis constants under test are pinned to the documented policy", () => {
  assert.deepEqual(
    {
      transientDegraded: ANCHOR_TRANSIENT_DEGRADED_THRESHOLD,
      transientDown: ANCHOR_TRANSIENT_DOWN_THRESHOLD,
      deterministicDown: ANCHOR_DETERMINISTIC_DOWN_THRESHOLD,
      recoverySuccess: ANCHOR_RECOVERY_SUCCESS_THRESHOLD,
      sustainedWindowMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS,
    },
    {
      transientDegraded: 2,
      transientDown: 3,
      deterministicDown: 2,
      recoverySuccess: 2,
      sustainedWindowMs: 48 * 60 * 60 * 1_000,
    },
  );
});

test("LIVE→DEGRADED boundary: exact equality degrades, one sample earlier does not", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_TRANSIENT_DEGRADED_THRESHOLD + offset;
    const trace = drive(liveState(), failures(samples, "TRANSIENT"));

    return {
      position,
      samples,
      // The status published by the sample that lands on the boundary value.
      status: trace.statuses[trace.statuses.length - 1],
      statusChanged: trace.changed[trace.changed.length - 1],
    };
  });

  assert.deepEqual(rows, [
    { position: "just below", samples: 1, status: "LIVE", statusChanged: false },
    { position: "exactly at", samples: 2, status: "DEGRADED", statusChanged: true },
    // One past the DEGRADED threshold is already the DOWN threshold.
    { position: "just above", samples: 3, status: "DOWN", statusChanged: true },
  ]);
});

test("LIVE→DOWN boundary: exact equality publishes DOWN, one sample earlier does not", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_TRANSIENT_DOWN_THRESHOLD + offset;
    const trace = drive(liveState(), failures(samples, "TRANSIENT"));

    return {
      position,
      samples,
      status: trace.statuses[trace.statuses.length - 1],
      statusChanged: trace.changed[trace.changed.length - 1],
      consecutiveFailures: trace.final.consecutiveFailures,
    };
  });

  assert.deepEqual(rows, [
    {
      position: "just below",
      samples: 2,
      status: "DEGRADED",
      statusChanged: true,
      consecutiveFailures: 2,
    },
    {
      position: "exactly at",
      samples: 3,
      status: "DOWN",
      statusChanged: true,
      consecutiveFailures: 3,
    },
    // DOWN is sticky: an extra identical failure reports no transition.
    {
      position: "just above",
      samples: 4,
      status: "DOWN",
      statusChanged: false,
      consecutiveFailures: 4,
    },
  ]);
});

test("deterministic LIVE→DOWN boundary: exact equality is DOWN, one failure earlier is DEGRADED", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_DETERMINISTIC_DOWN_THRESHOLD + offset;
    const trace = drive(liveState(), failures(samples, "DETERMINISTIC"));

    return {
      position,
      samples,
      status: trace.statuses[trace.statuses.length - 1],
      statusChanged: trace.changed[trace.changed.length - 1],
    };
  });

  assert.deepEqual(rows, [
    { position: "just below", samples: 1, status: "DEGRADED", statusChanged: true },
    { position: "exactly at", samples: 2, status: "DOWN", statusChanged: true },
    { position: "just above", samples: 3, status: "DOWN", statusChanged: false },
  ]);
});

test("DEGRADED→DOWN boundary: equality is evaluated on the shared failure count across classes", () => {
  const seeded = degradedState();

  const rows = POSITIONS.map(({ position, offset }) => {
    // The seeded state already carries one failure, so the increment that
    // lands exactly on the DOWN threshold is `threshold - seeded failures`.
    const additional = (ANCHOR_TRANSIENT_DOWN_THRESHOLD - seeded.consecutiveFailures)
      + offset;
    const trace = drive(
      seeded,
      failures(additional, "TRANSIENT", ORIGIN_MS + STEP_MS),
    );

    return {
      position,
      additional,
      consecutiveFailures: trace.final.consecutiveFailures,
      status: trace.final.status,
    };
  });

  assert.deepEqual(rows, [
    {
      position: "just below",
      additional: 1,
      consecutiveFailures: 2,
      status: "DEGRADED",
    },
    {
      position: "exactly at",
      additional: 2,
      consecutiveFailures: 3,
      status: "DOWN",
    },
    {
      position: "just above",
      additional: 3,
      consecutiveFailures: 4,
      status: "DOWN",
    },
  ]);
});

test("no-history UNKNOWN→DOWN boundary: equality publishes DOWN, one failure earlier stays UNKNOWN", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_TRANSIENT_DOWN_THRESHOLD + offset;
    const trace = drive(
      initialAnchorHealthState("anchor-boundary"),
      failures(samples, "TRANSIENT"),
    );

    return {
      position,
      samples,
      status: trace.final.status,
      statusChanged: trace.changed[trace.changed.length - 1],
      everDegraded: trace.statuses.includes("DEGRADED"),
    };
  });

  assert.deepEqual(rows, [
    {
      position: "just below",
      samples: 2,
      status: "UNKNOWN",
      statusChanged: false,
      everDegraded: false,
    },
    {
      position: "exactly at",
      samples: 3,
      status: "DOWN",
      statusChanged: true,
      everDegraded: false,
    },
    {
      position: "just above",
      samples: 4,
      status: "DOWN",
      statusChanged: false,
      everDegraded: false,
    },
  ]);
});

test("DOWN→LIVE recovery boundary: exact equality completes recovery, one success earlier does not", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_RECOVERY_SUCCESS_THRESHOLD + offset;
    const trace = drive(downState(), successes(samples, ORIGIN_MS + 10 * STEP_MS));

    return {
      position,
      samples,
      status: trace.statuses[trace.statuses.length - 1],
      statusChanged: trace.changed[trace.changed.length - 1],
    };
  });

  assert.deepEqual(rows, [
    { position: "just below", samples: 1, status: "DEGRADED", statusChanged: true },
    { position: "exactly at", samples: 2, status: "LIVE", statusChanged: true },
    // Extra identical successes keep LIVE without reporting a transition.
    { position: "just above", samples: 3, status: "LIVE", statusChanged: false },
  ]);
});

test("DEGRADED→LIVE recovery boundary uses the same exact success count", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_RECOVERY_SUCCESS_THRESHOLD + offset;
    const trace = drive(degradedState(), successes(samples, ORIGIN_MS + STEP_MS));

    return {
      position,
      samples,
      status: trace.statuses[trace.statuses.length - 1],
      statusChanged: trace.changed[trace.changed.length - 1],
    };
  });

  assert.deepEqual(rows, [
    // The first success on an already-DEGRADED anchor confirms the same
    // status, so it is not a transition.
    { position: "just below", samples: 1, status: "DEGRADED", statusChanged: false },
    { position: "exactly at", samples: 2, status: "LIVE", statusChanged: true },
    { position: "just above", samples: 3, status: "LIVE", statusChanged: false },
  ]);
});

test("UNKNOWN first-success rule stays untouched at the recovery boundary", () => {
  const rows = POSITIONS.map(({ position, offset }) => {
    const samples = ANCHOR_RECOVERY_SUCCESS_THRESHOLD + offset;
    const trace = drive(
      initialAnchorHealthState("anchor-boundary"),
      successes(samples),
    );

    return {
      position,
      samples,
      status: trace.final.status,
      statusChanged: trace.changed[0],
    };
  });

  // Documented exception: with no healthy claim established there is nothing
  // to protect from flapping, so the first-ever success publishes LIVE even
  // though it is below the recovery threshold. The threshold still governs
  // DOWN/DEGRADED recovery above.
  assert.deepEqual(rows, [
    { position: "just below", samples: 1, status: "LIVE", statusChanged: true },
    { position: "exactly at", samples: 2, status: "LIVE", statusChanged: true },
    { position: "just above", samples: 3, status: "LIVE", statusChanged: true },
  ]);
});

test("sustained-window boundary is inclusive to the millisecond", () => {
  // A success resets the failure counter but keeps `lastFailureAt`, so a later
  // isolated failure is decided by elapsed time alone.
  const baseline = drive(liveState(), [
    failureAt(ORIGIN_MS, "TRANSIENT"),
    successAt(ORIGIN_MS + STEP_MS),
  ]).final;

  assert.equal(baseline.status, "LIVE");
  assert.equal(baseline.consecutiveFailures, 0);
  assert.equal(baseline.lastFailureAt?.getTime(), ORIGIN_MS);

  const rows = [
    {
      position: "just below (1 ms short)",
      elapsedMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS - 1,
      expected: "LIVE",
    },
    {
      position: "exactly at",
      elapsedMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS,
      expected: "DEGRADED",
    },
    {
      position: "just above (1 ms over)",
      elapsedMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS + 1,
      expected: "DEGRADED",
    },
  ].map(({ position, elapsedMs, expected }) => {
    const trace = drive(baseline, [failureAt(ORIGIN_MS + elapsedMs, "TRANSIENT")]);

    return {
      position,
      elapsedMs,
      consecutiveFailures: trace.final.consecutiveFailures,
      status: trace.final.status,
      expected,
    };
  });

  assert.deepEqual(rows, [
    {
      position: "just below (1 ms short)",
      elapsedMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS - 1,
      consecutiveFailures: 1,
      status: "LIVE",
      expected: "LIVE",
    },
    {
      position: "exactly at",
      elapsedMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS,
      consecutiveFailures: 1,
      status: "DEGRADED",
      expected: "DEGRADED",
    },
    {
      position: "just above (1 ms over)",
      elapsedMs: ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS + 1,
      consecutiveFailures: 1,
      status: "DEGRADED",
      expected: "DEGRADED",
    },
  ]);
});

test("repeated identical samples do not oscillate the published status", () => {
  const escalation = drive(liveState(), failures(10, "TRANSIENT"));

  assert.deepEqual(escalation.statuses, [
    "LIVE",
    "DEGRADED",
    "DOWN",
    "DOWN",
    "DOWN",
    "DOWN",
    "DOWN",
    "DOWN",
    "DOWN",
    "DOWN",
  ]);
  assert.deepEqual(escalation.changed, [
    false,
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);

  const recovery = drive(
    downState(),
    successes(10, ORIGIN_MS + 10 * STEP_MS),
  );

  assert.deepEqual(recovery.statuses, [
    "DEGRADED",
    "LIVE",
    "LIVE",
    "LIVE",
    "LIVE",
    "LIVE",
    "LIVE",
    "LIVE",
    "LIVE",
    "LIVE",
  ]);
  assert.deepEqual(recovery.changed, [
    true,
    true,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    false,
  ]);

  // Once a terminal status is published, identical repeat samples are inert.
  const steadyLive = drive(liveState(), successes(5, ORIGIN_MS + STEP_MS));
  assert.deepEqual(steadyLive.statuses, ["LIVE", "LIVE", "LIVE", "LIVE", "LIVE"]);
  assert.deepEqual(steadyLive.changed, [false, false, false, false, false]);

  const steadyDown = drive(
    downState(),
    failures(5, "DETERMINISTIC", ORIGIN_MS + 10 * STEP_MS),
  );
  assert.deepEqual(steadyDown.statuses, ["DOWN", "DOWN", "DOWN", "DOWN", "DOWN"]);
  assert.deepEqual(steadyDown.changed, [false, false, false, false, false]);
});

test("statusChanged and lastTransitionAt agree at every boundary step", () => {
  const scenarios: ReadonlyArray<Readonly<{
    from: AnchorHealthState;
    observations: readonly AnchorHealthObservation[];
  }>> = [
    {
      from: liveState(),
      observations: failures(ANCHOR_TRANSIENT_DOWN_THRESHOLD + 1, "TRANSIENT"),
    },
    {
      from: baselineAfterOneFailure(),
      observations: [failureAt(ORIGIN_MS + ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS, "TRANSIENT")],
    },
    {
      from: downState(),
      observations: successes(ANCHOR_RECOVERY_SUCCESS_THRESHOLD + 1, ORIGIN_MS + 10 * STEP_MS),
    },
  ];

  for (const { from, observations } of scenarios) {
    const trace = drive(from, observations);
    let previous = from;

    trace.transitions.forEach((transition, index) => {
      assert.equal(
        transition.statusChanged,
        transition.status !== previous.status,
        `statusChanged must mirror the status move at step ${index}`,
      );
      assert.equal(
        transition.next.lastTransitionAt?.getTime() ?? null,
        transition.statusChanged
          ? observations[index]!.occurredAt.getTime()
          : previous.lastTransitionAt?.getTime() ?? null,
        `lastTransitionAt must only move on a real transition at step ${index}`,
      );
      previous = transition.next;
    });
  }
});

test("behavior outside the boundary is unchanged and the state machine stays pure", () => {
  const start = liveState();
  const snapshot = structuredClone(start);

  const trace = drive(start, [
    failureAt(ORIGIN_MS, "TRANSIENT"),
    successAt(ORIGIN_MS + STEP_MS),
  ]);

  // No input mutation: the machine is state-in/state-out.
  assert.deepEqual(start, snapshot);

  const afterFailure = trace.transitions[0]!.next;
  assert.equal(afterFailure.consecutiveFailures, 1);
  assert.equal(afterFailure.consecutiveSuccesses, 0);
  assert.equal(afterFailure.lastFailureClass, "TRANSIENT");
  assert.equal(afterFailure.lastFailureCode, "TRANSIENT_FAILURE");
  assert.equal(afterFailure.lastFailureAt?.getTime(), ORIGIN_MS);
  // A below-threshold failure is recorded as evidence, not published.
  assert.equal(afterFailure.status, "LIVE");
  assert.equal(
    afterFailure.lastTransitionAt?.getTime(),
    start.lastTransitionAt?.getTime(),
  );

  const afterSuccess = trace.transitions[1]!.next;
  assert.equal(afterSuccess.consecutiveFailures, 0);
  assert.equal(afterSuccess.consecutiveSuccesses, 1);
  assert.equal(afterSuccess.lastFailureClass, null);
  assert.equal(afterSuccess.lastFailureCode, null);
  // History is preserved even though the counter reset.
  assert.equal(afterSuccess.lastFailureAt?.getTime(), ORIGIN_MS);
  assert.equal(afterSuccess.lastSuccessAt?.getTime(), ORIGIN_MS + STEP_MS);
  assert.equal(afterSuccess.status, "LIVE");
});

test("transition traces are deterministic in both directions", () => {
  const escalation = failures(ANCHOR_TRANSIENT_DOWN_THRESHOLD + 1, "TRANSIENT");
  const firstEscalation = drive(liveState(), escalation);
  const secondEscalation = drive(liveState(), escalation);

  assert.deepEqual(secondEscalation.statuses, firstEscalation.statuses);
  assert.deepEqual(secondEscalation.changed, firstEscalation.changed);
  // Includes timestamps and counters, not just the published status.
  assert.deepEqual(secondEscalation.final, firstEscalation.final);

  const recovery = successes(
    ANCHOR_RECOVERY_SUCCESS_THRESHOLD + 1,
    ORIGIN_MS + 10 * STEP_MS,
  );
  const firstRecovery = drive(downState(), recovery);
  const secondRecovery = drive(downState(), recovery);

  assert.deepEqual(secondRecovery.statuses, firstRecovery.statuses);
  assert.deepEqual(secondRecovery.changed, firstRecovery.changed);
  assert.deepEqual(secondRecovery.final, firstRecovery.final);
});

function baselineAfterOneFailure(): AnchorHealthState {
  return drive(liveState(), [
    failureAt(ORIGIN_MS, "TRANSIENT"),
    successAt(ORIGIN_MS + STEP_MS),
  ]).final;
}
