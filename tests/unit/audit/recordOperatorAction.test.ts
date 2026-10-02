import assert from "node:assert/strict";
import test from "node:test";

import {
  OperatorActionValidationError,
  appendOperatorAction,
  assertValidOperatorAction,
  buildOperatorActionPreview,
  type OperatorActionExecutor,
} from "@/lib/audit/recordOperatorAction";
import type { RecordOperatorActionInput } from "@/types/audit";

function input(overrides: Partial<RecordOperatorActionInput> = {}): RecordOperatorActionInput {
  return {
    actionType: "ANCHOR_RETIRED",
    targetType: "ANCHOR",
    targetId: "9d5b3f7e-0000-0000-0000-000000000000",
    targetLabel: "  zeam  ",
    reasonCode: "REVIEWED_CONFIGURATION_REMOVAL",
    rationale: "  removed from reviewed configuration  ",
    actor: { kind: "human", id: "operator-7" },
    runId: " run-1 ",
    ...overrides,
  };
}

type Captured = Record<string, unknown>;

function executor(captured: Captured[]): OperatorActionExecutor {
  return {
    operatorAction: {
      create: async ({ data }: { data: Captured }) => {
        captured.push(data);
        return {
          id: "row-1",
          actionId: data.actionId,
          actionType: data.actionType,
          mode: "APPLIED",
          targetType: data.targetType,
          targetId: data.targetId,
          targetLabel: data.targetLabel ?? null,
          reasonCode: data.reasonCode,
          rationale: data.rationale ?? null,
          actorType: data.actorType,
          actorId: data.actorId ?? null,
          runId: data.runId ?? null,
          createdAt: data.createdAt instanceof Date
            ? data.createdAt
            : new Date("2026-10-02T00:00:00.000Z"),
        };
      },
    },
  } as unknown as OperatorActionExecutor;
}

test("dry-run previews are deterministic and never applied records", () => {
  const first = buildOperatorActionPreview(input());
  const second = buildOperatorActionPreview(input());

  assert.deepEqual(first, second);
  assert.equal(first.mode, "DRY_RUN");
  assert.equal(first.targetLabel, "zeam");
  assert.equal(first.rationale, "removed from reviewed configuration");
  assert.equal(first.runId, "run-1");
  assert.equal(first.actorType, "HUMAN");
  assert.equal(Object.hasOwn(first, "id"), false);
  assert.equal(Object.hasOwn(first, "createdAt"), false);
});

test("append writes exactly one bounded, sanitized applied row", async () => {
  const captured: Captured[] = [];
  const record = await appendOperatorAction(executor(captured), input(), {
    actionId: "action-9",
    createdAt: new Date("2026-10-02T10:00:00.000Z"),
  });

  assert.equal(captured.length, 1);
  const data = captured[0]!;
  assert.equal(data.mode, "APPLIED");
  assert.equal(data.actionId, "action-9");
  assert.equal(data.actorType, "HUMAN");
  assert.equal(data.actorId, "operator-7");
  assert.equal(record.mode, "APPLIED");
  assert.equal(record.createdAt.toISOString(), "2026-10-02T10:00:00.000Z");

  // The input surface has no place for tokens, headers, payloads, or traces.
  const allowedKeys = new Set([
    "actionId", "actionType", "mode", "targetType", "targetId", "targetLabel",
    "reasonCode", "rationale", "actorType", "actorId", "runId", "createdAt",
  ]);
  for (const key of Object.keys(data)) {
    assert.equal(allowedKeys.has(key), true, key);
  }
  for (const forbidden of ["token", "authorization", "payload", "stack", "headers"]) {
    assert.equal(JSON.stringify(data).toLowerCase().includes(forbidden), false, forbidden);
  }
});

test("invalid input throws a typed validation error and never reaches the database", async () => {
  const captured: Captured[] = [];
  assert.throws(
    () => assertValidOperatorAction(input({ reasonCode: "SOURCE_ERROR" })),
    (error: unknown) => {
      assert.equal(error instanceof OperatorActionValidationError, true);
      assert.equal(
        (error as OperatorActionValidationError).issues.some((issue) => issue.code === "REASON_NOT_ALLOWED"),
        true,
      );
      return true;
    },
  );

  await assert.rejects(() => appendOperatorAction(executor(captured), input({ targetType: "RATE_SNAPSHOT" })));
  assert.equal(captured.length, 0);
});
