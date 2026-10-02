import assert from "node:assert/strict";
import test from "node:test";

import {
  runRegistryReactivation,
  runRegistryRetirement,
  type RegistryLifecycleRepository,
} from "@/lib/administration/registryLifecycle";
import type {
  AnchorLifecycleState,
  AnchorLifecycleTarget,
  RegistryLifecycleRequest,
} from "@/types/administration";
import type { OperatorActionRecord } from "@/types/audit";

type State = {
  lifecycleState: AnchorLifecycleState | null;
  applyCalls: number;
  repository: RegistryLifecycleRepository;
};

function target(lifecycleState: AnchorLifecycleState | null): AnchorLifecycleTarget | null {
  if (lifecycleState === null) return null;
  return { anchorId: "anchor-1", slug: "zeam", lifecycleState };
}

function makeState(lifecycleState: AnchorLifecycleState | null): State {
  const state: State = {
    lifecycleState,
    applyCalls: 0,
    repository: undefined as unknown as RegistryLifecycleRepository,
  };
  const current = (): AnchorLifecycleTarget | null => target(state.lifecycleState);
  state.repository = {
    findAnchor: async () => current(),
    applyLifecycleChange: async (input) => {
      state.applyCalls += 1;
      state.lifecycleState = input.nextState;
      const anchor = current()!;
      return { ok: true, anchor, action: actionRecord(anchor.lifecycleState) };
    },
  };
  return state;
}

function request(overrides: Partial<RegistryLifecycleRequest> = {}): RegistryLifecycleRequest {
  return {
    mode: "dry-run",
    anchorSlug: "zeam",
    reasonCode: "REVIEWED_CONFIGURATION_REMOVAL",
    actor: { kind: "human", id: "operator-7" },
    ...overrides,
  };
}

function actionRecord(nextState: AnchorLifecycleState): OperatorActionRecord {
  return Object.freeze({
    id: "row-1",
    actionId: "action-1",
    actionType: nextState === "RETIRED" ? "ANCHOR_RETIRED" : "ANCHOR_REACTIVATED",
    mode: "APPLIED",
    targetType: "ANCHOR",
    targetId: "anchor-1",
    targetLabel: "zeam",
    reasonCode: "REVIEWED_CONFIGURATION_REMOVAL",
    rationale: null,
    actorType: "HUMAN",
    actorId: "operator-7",
    runId: null,
    createdAt: new Date("2026-10-02T00:00:00.000Z"),
  });
}

test("retirement previews without writing and applies atomically", async () => {
  const state = makeState("ACTIVE");
  const dry = await runRegistryRetirement(request(), { repository: state.repository });
  assert.equal(dry.status, "dry_run");
  if (dry.status === "dry_run") assert.equal(dry.action.mode, "DRY_RUN");
  assert.equal(state.applyCalls, 0);
  assert.equal(state.lifecycleState, "ACTIVE");

  const applied = await runRegistryRetirement(request({ mode: "apply" }), { repository: state.repository });
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.equal(applied.anchor.lifecycleState, "RETIRED");
  assert.equal(applied.action.mode, "APPLIED");
  assert.equal(state.applyCalls, 1);
});

test("retiring and reactivating in the wrong state are rejected", async () => {
  const retired = makeState("RETIRED");
  const retire = await runRegistryRetirement(request({ mode: "apply" }), { repository: retired.repository });
  assert.equal(retire.status, "rejected");
  if (retire.status === "rejected") assert.equal(retire.code, "ALREADY_RETIRED");
  assert.equal(retired.applyCalls, 0);

  const active = makeState("ACTIVE");
  const reactivate = await runRegistryReactivation(
    request({ mode: "apply", reasonCode: "OPERATOR_RECOVERY" }),
    { repository: active.repository },
  );
  assert.equal(reactivate.status, "rejected");
  if (reactivate.status === "rejected") assert.equal(reactivate.code, "NOT_RETIRED");
  assert.equal(active.applyCalls, 0);
});

test("reactivation recovers a retired anchor", async () => {
  const state = makeState("RETIRED");
  const applied = await runRegistryReactivation(
    request({ mode: "apply", reasonCode: "OPERATOR_RECOVERY" }),
    { repository: state.repository },
  );
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.equal(applied.anchor.lifecycleState, "ACTIVE");
  assert.equal(applied.action.actionType, "ANCHOR_REACTIVATED");
});

test("unknown anchors are rejected without a write", async () => {
  const state = makeState(null);
  const outcome = await runRegistryRetirement(request({ mode: "apply" }), { repository: state.repository });
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.code, "TARGET_NOT_FOUND");
  assert.equal(state.applyCalls, 0);
});
