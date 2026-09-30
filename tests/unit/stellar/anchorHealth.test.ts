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
  classifyAnchorFailure,
  initialAnchorHealthState,
} from "@/lib/stellar/anchorHealth";
import { Sep1DiscoveryError } from "@/lib/stellar/sep1";
import type {
  AnchorFailureClass,
  AnchorHealthState,
} from "@/types/anchorHealth";

function state(overrides: Partial<AnchorHealthState> = {}): AnchorHealthState {
  return {
    anchorSlug: "moneygram",
    status: "LIVE",
    consecutiveFailures: 0,
    lastFailureClass: null,
    lastFailureCode: null,
    consecutiveSuccesses: 0,
    lastObservedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastTransitionAt: null,
    ...overrides,
  };
}

function failure(classification: AnchorFailureClass, code = "TIMEOUT") {
  return {
    outcome: "FAILURE" as const,
    occurredAt: new Date("2026-09-30T00:00:00Z"),
    failure: { failureClass: classification, code },
  };
}

function success() {
  return { outcome: "SUCCESS" as const, occurredAt: new Date("2026-09-30T00:00:00Z") };
}

test("failure taxonomy separates transport, protocol/configuration, and unknown classes", () => {
  const transientCodes = [
    new Sep1DiscoveryError("TIMEOUT", "t", "u"),
    new Sep1DiscoveryError("NETWORK_FAILURE", "n", "u"),
    new Sep1DiscoveryError("RESPONSE_TOO_LARGE", "r", "u"),
    new Sep1DiscoveryError("HTTP_FAILURE", "h", "u", { status: 503 }),
    new Sep1DiscoveryError("HTTP_FAILURE", "h", "u"),
  ];

  for (const error of transientCodes) {
    assert.equal(classifyAnchorFailure(error), "TRANSIENT", error.code);
  }

  const deterministicCodes = [
    new Sep1DiscoveryError("INVALID_TOML", "i", "u"),
    new Sep1DiscoveryError("INVALID_DATA", "i", "u"),
    new Sep1DiscoveryError("MISSING_REQUIRED_DATA", "m", "u"),
    new Sep1DiscoveryError("INVALID_HOME_DOMAIN", "d", "u"),
    new Sep1DiscoveryError("HTTP_FAILURE", "h", "u", { status: 404 }),
  ];

  for (const error of deterministicCodes) {
    assert.equal(classifyAnchorFailure(error), "DETERMINISTIC", error.code);
  }

  assert.equal(classifyAnchorFailure(new Error("boom")), "UNKNOWN");
  assert.equal(classifyAnchorFailure(undefined), "UNKNOWN");
});

test("a single transient timeout on a LIVE anchor keeps the status LIVE", () => {
  const transition = applyAnchorHealthObservation(state(), failure("TRANSIENT"));

  assert.equal(transition.status, "LIVE");
  assert.equal(transition.statusChanged, false);
  assert.equal(transition.next.consecutiveFailures, 1);
  assert.equal(transition.next.lastFailureClass, "TRANSIENT");
});

test("transient failures escalate LIVE -> DEGRADED -> DOWN at the documented thresholds", () => {
  assert.ok(ANCHOR_TRANSIENT_DEGRADED_THRESHOLD < ANCHOR_TRANSIENT_DOWN_THRESHOLD);

  let current = state();

  for (let index = 1; index <= ANCHOR_TRANSIENT_DOWN_THRESHOLD; index += 1) {
    const transition = applyAnchorHealthObservation(current, failure("TRANSIENT"));

    if (index < ANCHOR_TRANSIENT_DEGRADED_THRESHOLD) {
      assert.equal(transition.status, "LIVE");
    } else if (index < ANCHOR_TRANSIENT_DOWN_THRESHOLD) {
      assert.equal(transition.status, "DEGRADED");
    } else {
      assert.equal(transition.status, "DOWN");
    }

    current = transition.next;
  }
});

test("deterministic failures escalate to DOWN faster than transient evidence", () => {
  assert.ok(ANCHOR_DETERMINISTIC_DOWN_THRESHOLD <= ANCHOR_TRANSIENT_DEGRADED_THRESHOLD);

  let current = state();
  const statuses: string[] = [];

  for (let index = 0; index < ANCHOR_DETERMINISTIC_DOWN_THRESHOLD; index += 1) {
    const transition = applyAnchorHealthObservation(current, failure("DETERMINISTIC", "INVALID_TOML"));
    statuses.push(transition.status);
    current = transition.next;
  }

  assert.equal(statuses[statuses.length - 1], "DOWN");
});

test("unknown-class failures follow the transient path and never escalate faster", () => {
  let current = state();

  const first = applyAnchorHealthObservation(current, failure("UNKNOWN", "UNEXPECTED_ERROR"));
  assert.equal(first.status, "LIVE");
  current = first.next;

  const second = applyAnchorHealthObservation(current, failure("UNKNOWN", "UNEXPECTED_ERROR"));
  assert.equal(second.status, "DEGRADED");
});

test("a failure spaced beyond the sustained window escalates even after an intervening success", () => {
  const firstFailureAt = new Date("2026-09-28T00:00:00Z");
  const seeded = state({
    // A success reset the consecutive counter but the last failure timestamp
    // remains, so the evidence window spans a long period.
    consecutiveFailures: 0,
    lastFailureClass: "TRANSIENT",
    lastFailureCode: "TIMEOUT",
    lastFailureAt: firstFailureAt,
  });

  const justOutside = new Date(firstFailureAt.getTime() + ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS);
  const transition = applyAnchorHealthObservation(seeded, {
    outcome: "FAILURE",
    occurredAt: justOutside,
    failure: { failureClass: "TRANSIENT", code: "TIMEOUT" },
  });

  assert.equal(transition.status, "DEGRADED");
  assert.equal(transition.statusChanged, true);
});

test("a failure inside the sustained window does not escalate on its own", () => {
  const firstFailureAt = new Date("2026-09-28T00:00:00Z");
  const seeded = state({
    consecutiveFailures: 0,
    lastFailureClass: "TRANSIENT",
    lastFailureCode: "TIMEOUT",
    lastFailureAt: firstFailureAt,
  });

  const justInside = new Date(firstFailureAt.getTime() + ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS - 1);
  const transition = applyAnchorHealthObservation(seeded, {
    outcome: "FAILURE",
    occurredAt: justInside,
    failure: { failureClass: "TRANSIENT", code: "TIMEOUT" },
  });

  assert.equal(transition.status, "LIVE");
});

test("an UNKNOWN anchor never publishes DEGRADED from failures alone", () => {
  let current = initialAnchorHealthState("new-anchor");

  const first = applyAnchorHealthObservation(current, failure("TRANSIENT"));
  assert.equal(first.status, "UNKNOWN");
  current = first.next;

  const second = applyAnchorHealthObservation(current, failure("TRANSIENT"));
  assert.equal(second.status, "UNKNOWN");
  current = second.next;

  const third = applyAnchorHealthObservation(current, failure("TRANSIENT"));
  assert.equal(third.status, "DOWN");
});

test("recovery from DOWN requires repeated successful evidence", () => {
  assert.ok(ANCHOR_RECOVERY_SUCCESS_THRESHOLD >= 2);

  const down = state({ status: "DOWN", consecutiveFailures: 5 });
  const first = applyAnchorHealthObservation(down, success());

  assert.equal(first.status, "DEGRADED");
  assert.equal(first.statusChanged, true);
  assert.equal(first.next.consecutiveFailures, 0);
  assert.equal(first.next.lastFailureClass, null);

  const second = applyAnchorHealthObservation(first.next, success());
  assert.equal(second.status, "LIVE");
  assert.equal(second.statusChanged, true);
});

test("recovery from DEGRADED requires the same repeated evidence", () => {
  const degraded = state({ status: "DEGRADED", consecutiveFailures: 2 });
  const first = applyAnchorHealthObservation(degraded, success());

  assert.equal(first.status, "DEGRADED");

  const second = applyAnchorHealthObservation(first.next, success());
  assert.equal(second.status, "LIVE");
});

test("an isolated failure on a LIVE anchor clears on the next success without a round trip", () => {
  const afterFailure = applyAnchorHealthObservation(state(), failure("TRANSIENT"));
  assert.equal(afterFailure.status, "LIVE");

  const afterRecovery = applyAnchorHealthObservation(afterFailure.next, success());
  assert.equal(afterRecovery.status, "LIVE");
  assert.equal(afterRecovery.next.consecutiveFailures, 0);
  assert.equal(afterRecovery.next.lastFailureClass, null);
});

test("a first-ever success for an anchor with no history publishes LIVE directly", () => {
  const neverObserved = initialAnchorHealthState("new-anchor");
  const transition = applyAnchorHealthObservation(neverObserved, success());

  assert.equal(transition.status, "LIVE");
  assert.equal(transition.statusChanged, true);
});

test("an anchor already DOWN stays DOWN on further failures", () => {
  const down = state({ status: "DOWN", consecutiveFailures: 9 });
  const transition = applyAnchorHealthObservation(down, failure("TRANSIENT"));

  assert.equal(transition.status, "DOWN");
  assert.equal(transition.statusChanged, false);
  assert.equal(transition.next.consecutiveFailures, 10);
});

test("transitions are deterministic: identical inputs produce identical outputs", () => {
  const base = state({ consecutiveFailures: 1, lastFailureClass: "TRANSIENT", lastFailureCode: "TIMEOUT", lastFailureAt: new Date("2026-09-29T00:00:00Z") });
  const observation = failure("TRANSIENT");

  const a = applyAnchorHealthObservation(base, observation);
  const b = applyAnchorHealthObservation(base, observation);

  assert.deepEqual(a, b);
});

test("the state machine performs no I/O and the next state is a plain frozen object", () => {
  const transition = applyAnchorHealthObservation(state(), failure("TRANSIENT"));

  assert.equal(Object.isFrozen(transition.next), true);
});
