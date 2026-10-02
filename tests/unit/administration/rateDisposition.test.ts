import assert from "node:assert/strict";
import test from "node:test";

import {
  runRateDisposition,
  runRateDispositionRecovery,
  type RateDispositionRepository,
} from "@/lib/administration/rateDisposition";
import type {
  RateDispositionRecoveryRequest,
  RateDispositionRequest,
  RateSnapshotDispositionKind,
  RateSnapshotTarget,
} from "@/types/administration";
import type { OperatorActionRecord } from "@/types/audit";

const SNAPSHOT: RateSnapshotTarget = Object.freeze({
  snapshotId: "snap-1",
  anchorSlug: "zeam",
  corridorSlug: "usdc-us-brl-br",
  capturedAt: new Date("2026-10-02T00:00:00.000Z"),
});

type State = {
  snapshot: RateSnapshotTarget | null;
  disposition: RateSnapshotDispositionKind | null;
  applyCalls: number;
  clearCalls: number;
  failApply: boolean;
  repository: RateDispositionRepository;
};

function makeState(overrides: Partial<State> = {}): State {
  const state: State = {
    snapshot: SNAPSHOT,
    disposition: null,
    applyCalls: 0,
    clearCalls: 0,
    failApply: false,
    repository: undefined as unknown as RateDispositionRepository,
    ...overrides,
  };
  state.repository = {
    findSnapshot: async () => state.snapshot,
    findDisposition: async () => state.disposition,
    applyDisposition: async (input) => {
      state.applyCalls += 1;
      if (state.failApply) throw new Error("simulated persistence failure");
      state.disposition = input.disposition;
      return { ok: true, disposition: input.disposition, action: actionRecord() };
    },
    clearDisposition: async () => {
      state.clearCalls += 1;
      state.disposition = null;
      return { ok: true, action: actionRecord({ actionType: "RATE_DISPOSITION_RECOVERED" }) };
    },
  };
  return state;
}

function request(overrides: Partial<RateDispositionRequest> = {}): RateDispositionRequest {
  return {
    mode: "dry-run",
    snapshotId: "snap-1",
    disposition: "INVALIDATED",
    reasonCode: "SOURCE_ERROR",
    actor: { kind: "human", id: "operator-7" },
    ...overrides,
  };
}

function recoveryRequest(
  overrides: Partial<RateDispositionRecoveryRequest> = {},
): RateDispositionRecoveryRequest {
  return {
    mode: "dry-run",
    snapshotId: "snap-1",
    reasonCode: "OPERATOR_RECOVERY",
    actor: { kind: "system" },
    ...overrides,
  };
}

function actionRecord(overrides: Partial<OperatorActionRecord> = {}): OperatorActionRecord {
  return Object.freeze({
    id: "row-1",
    actionId: "action-1",
    actionType: "RATE_SNAPSHOT_INVALIDATED",
    mode: "APPLIED",
    targetType: "RATE_SNAPSHOT",
    targetId: "snap-1",
    targetLabel: "zeam/usdc-us-brl-br",
    reasonCode: "SOURCE_ERROR",
    rationale: null,
    actorType: "SYSTEM",
    actorId: null,
    runId: null,
    createdAt: new Date("2026-10-02T00:00:00.000Z"),
    ...overrides,
  });
}

test("dry runs preview without writing and never apply", async () => {
  const state = makeState();
  const outcome = await runRateDisposition(request(), { repository: state.repository });

  assert.equal(outcome.status, "dry_run");
  if (outcome.status !== "dry_run") return;
  assert.equal(outcome.action.mode, "DRY_RUN");
  assert.equal(outcome.action.actionType, "RATE_SNAPSHOT_INVALIDATED");
  assert.equal(state.applyCalls, 0);
  assert.equal(state.disposition, null);
});

test("apply performs exactly one repository mutation", async () => {
  const state = makeState();
  const outcome = await runRateDisposition(request({ mode: "apply" }), { repository: state.repository });

  assert.equal(outcome.status, "applied");
  if (outcome.status !== "applied") return;
  assert.equal(outcome.disposition, "INVALIDATED");
  assert.equal(outcome.action.mode, "APPLIED");
  assert.equal(state.applyCalls, 1);
});

test("unknown snapshots and already-disposed snapshots are rejected truthfully", async () => {
  const missing = makeState({ snapshot: null });
  assert.equal(
    (await runRateDisposition(request({ mode: "apply" }), { repository: missing.repository })).status,
    "rejected",
  );
  assert.equal(missing.applyCalls, 0);

  const disposed = makeState({ disposition: "SUPERSEDED" });
  const dry = await runRateDisposition(request(), { repository: disposed.repository });
  assert.equal(dry.status, "rejected");
  if (dry.status === "rejected") assert.equal(dry.code, "ALREADY_DISPOSED");
  assert.equal(disposed.applyCalls, 0);
});

test("an unreviewed reason for the action is rejected before any write", async () => {
  const state = makeState();
  const outcome = await runRateDisposition(
    request({ mode: "apply", reasonCode: "OPERATOR_RECOVERY" }),
    { repository: state.repository },
  );
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.code, "INVALID_INPUT");
  assert.equal(state.applyCalls, 0);
});

test("a failed apply never masquerades as applied", async () => {
  const state = makeState({ failApply: true });
  await assert.rejects(
    () => runRateDisposition(request({ mode: "apply" }), { repository: state.repository }),
  );
  assert.equal(state.applyCalls, 1);
  assert.equal(state.disposition, null);
});

test("recovery requires and clears an existing disposition", async () => {
  const absent = makeState();
  const rejected = await runRateDispositionRecovery(recoveryRequest(), { repository: absent.repository });
  assert.equal(rejected.status, "rejected");
  if (rejected.status === "rejected") assert.equal(rejected.code, "NOT_DISPOSED");
  assert.equal(absent.clearCalls, 0);

  const disposed = makeState({ disposition: "INVALIDATED" });
  const dry = await runRateDispositionRecovery(recoveryRequest(), { repository: disposed.repository });
  assert.equal(dry.status, "dry_run");
  assert.equal(disposed.clearCalls, 0);

  const applied = await runRateDispositionRecovery(
    recoveryRequest({ mode: "apply" }),
    { repository: disposed.repository },
  );
  assert.equal(applied.status, "applied");
  assert.equal(disposed.clearCalls, 1);
  assert.equal(disposed.disposition, null);
});
