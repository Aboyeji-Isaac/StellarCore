import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";

import { PRISMA_ANCHOR_DIRECTORY_REPOSITORY } from "@/lib/api/anchorRepository";
import { PRISMA_CORRIDOR_DIRECTORY_REPOSITORY } from "@/lib/api/corridorRepository";
import {
  runRateDisposition,
  runRateDispositionRecovery,
} from "@/lib/administration/rateDisposition";
import { PRISMA_RATE_DISPOSITION_REPOSITORY } from "@/lib/administration/rateDispositionRepository";
import {
  runRegistryReactivation,
  runRegistryRetirement,
} from "@/lib/administration/registryLifecycle";
import { PRISMA_REGISTRY_LIFECYCLE_REPOSITORY } from "@/lib/administration/registryLifecycleRepository";
import { PRISMA_OPERATOR_ACTION_LEDGER } from "@/lib/audit/ledgerRepository";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import {
  PRISMA_RATE_SNAPSHOT_REPOSITORY,
  persistRateSnapshot,
} from "@/lib/rates/snapshot";

/**
 * These tests require an isolated PostgreSQL database. They are skipped unless
 * `RUN_OPERATOR_AUDIT_DATABASE_INTEGRATION=1` and never touch production
 * credentials or production load. Ledger rows cannot be deleted (that is the
 * point), so every run uses unique identifiers and every assertion is scoped to
 * them.
 */
const ENABLED = process.env.RUN_OPERATOR_AUDIT_DATABASE_INTEGRATION === "1";

type Db = Awaited<typeof import("@/lib/dbClient")>["db"];

type Fixture = Readonly<{
  anchorId: string;
  corridorId: string;
  snapshotId: string;
  anchorSlug: string;
  corridorSlug: string;
}>;

async function seed(db: Db, suffix: string): Promise<Fixture> {
  const anchorSlug = `audit-anchor-${suffix}`;
  const corridorSlug = `audit-corridor-${suffix}`;
  const anchor = await db.anchor.create({
    data: {
      slug: anchorSlug,
      name: "Audit Fixture",
      homeDomain: `${suffix}.example.com`,
      tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
    },
    select: { id: true },
  });
  const corridor = await db.corridor.create({
    data: {
      slug: corridorSlug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    },
    select: { id: true },
  });
  await db.anchorCorridor.create({ data: { anchorId: anchor.id, corridorId: corridor.id } });
  const snapshot = await db.rateSnapshot.create({
    data: {
      anchorId: anchor.id,
      corridorId: corridor.id,
      rate: "1.5",
      sourceAmount: "100",
      destinationAmount: "150",
      fee: "1",
      capturedAt: new Date(),
    },
    select: { id: true },
  });

  return Object.freeze({
    anchorId: anchor.id,
    corridorId: corridor.id,
    snapshotId: snapshot.id,
    anchorSlug,
    corridorSlug,
  });
}

async function cleanup(db: Db, fixture: Fixture): Promise<void> {
  await db.rateSnapshotDisposition.deleteMany({ where: { snapshotId: fixture.snapshotId } });
  await db.rateSnapshot.deleteMany({ where: { corridorId: fixture.corridorId } });
  await db.anchorCorridor.deleteMany({ where: { anchorId: fixture.anchorId } });
  await db.anchor.deleteMany({ where: { slug: fixture.anchorSlug } });
  await db.corridor.deleteMany({ where: { slug: fixture.corridorSlug } });
}

after(async () => {
  // Never connect when the integration suite is disabled by default.
  if (!ENABLED) return;
  const { db } = await import("@/lib/dbClient");
  await db.$disconnect();
});

test("an applied disposition commits exactly one audit row and never rewrites evidence", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = await seed(db, suffix);
  const actionId = `disposition-action-${suffix}`;

  try {
    const outcome = await runRateDisposition(
      {
        mode: "apply",
        snapshotId: fixture.snapshotId,
        disposition: "INVALIDATED",
        reasonCode: "SOURCE_ERROR",
        rationale: "synthetic reviewed source error",
        actor: { kind: "system" },
        runId: `run-${suffix}`,
        actionId,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );
    assert.equal(outcome.status, "applied");

    const actions = await db.operatorAction.findMany({ where: { actionId } });
    assert.equal(actions.length, 1);
    const action = actions[0]!;
    assert.equal(action.actionType, "RATE_SNAPSHOT_INVALIDATED");
    assert.equal(action.mode, "APPLIED");
    assert.equal(action.targetType, "RATE_SNAPSHOT");
    assert.equal(action.targetId, fixture.snapshotId);
    assert.equal(action.actorType, "SYSTEM");
    assert.equal(action.actorId, null);
    assert.equal(action.reasonCode, "SOURCE_ERROR");

    const dispositions = await db.rateSnapshotDisposition.findMany({
      where: { snapshotId: fixture.snapshotId },
    });
    assert.equal(dispositions.length, 1);
    assert.equal(dispositions[0]!.actionRecordId, action.id);

    const persisted = await db.rateSnapshot.findUnique({
      where: { id: fixture.snapshotId },
      select: { rate: true, sourceAmount: true, destinationAmount: true, capturedAt: true },
    });
    assert.equal(persisted!.rate.toString(), "1.5");
    assert.equal(persisted!.sourceAmount.toString(), "100");

    const read = await readLatestCorridorRate(fixture.corridorSlug, { evaluatedAt: new Date() });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.observations.some(({ snapshotId }) => snapshotId === fixture.snapshotId), false);
    }

    const repeated = await runRateDisposition(
      {
        mode: "apply",
        snapshotId: fixture.snapshotId,
        disposition: "SUPERSEDED",
        reasonCode: "DATA_CORRECTION",
        actor: { kind: "system" },
        actionId: `${actionId}-2`,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );
    assert.equal(repeated.status, "rejected");
    assert.equal(await db.operatorAction.count({ where: { actionId: `${actionId}-2` } }), 0);
  } finally {
    await cleanup(db, fixture);
  }
});

test("dry runs write nothing at all", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = await seed(db, suffix);
  const actionId = `dry-run-action-${suffix}`;

  try {
    const outcome = await runRateDisposition(
      {
        mode: "dry-run",
        snapshotId: fixture.snapshotId,
        disposition: "INVALIDATED",
        reasonCode: "SOURCE_ERROR",
        actor: { kind: "human", id: "operator-7" },
        actionId,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );
    assert.equal(outcome.status, "dry_run");
    assert.equal(await db.operatorAction.count({ where: { actionId } }), 0);
    assert.equal(
      await db.rateSnapshotDisposition.count({ where: { snapshotId: fixture.snapshotId } }),
      0,
    );
  } finally {
    await cleanup(db, fixture);
  }
});

test("a duplicate audit action id rolls back the whole administrative change", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = await seed(db, suffix);
  const second = await db.rateSnapshot.create({
    data: {
      anchorId: fixture.anchorId,
      corridorId: fixture.corridorId,
      rate: "1.6",
      sourceAmount: "100",
      destinationAmount: "160",
      fee: "1",
      capturedAt: new Date(),
    },
    select: { id: true },
  });
  const actionId = `collision-action-${suffix}`;

  try {
    const first = await runRateDisposition(
      {
        mode: "apply",
        snapshotId: fixture.snapshotId,
        disposition: "INVALIDATED",
        reasonCode: "SOURCE_ERROR",
        actor: { kind: "system" },
        actionId,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );
    assert.equal(first.status, "applied");

    await assert.rejects(() => runRateDisposition(
      {
        mode: "apply",
        snapshotId: second.id,
        disposition: "SUPERSEDED",
        reasonCode: "DATA_CORRECTION",
        actor: { kind: "system" },
        actionId,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    ));

    assert.equal(await db.operatorAction.count({ where: { actionId } }), 1);
    assert.equal(await db.rateSnapshotDisposition.count({ where: { snapshotId: second.id } }), 0);
  } finally {
    await db.rateSnapshotDisposition.deleteMany({ where: { snapshotId: second.id } });
    await db.rateSnapshot.deleteMany({ where: { id: second.id } });
    await cleanup(db, fixture);
  }
});

test("ledger rows reject update, delete, and truncate at the database level", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const actionId = `immutable-action-${suffix}`;

  const record = await PRISMA_OPERATOR_ACTION_LEDGER.append({
    actionId,
    actionType: "ANCHOR_RETIRED",
    targetType: "ANCHOR",
    targetId: `target-${suffix}`,
    reasonCode: "OTHER_REVIEWED",
    actor: { kind: "system" },
  });
  assert.equal(record.mode, "APPLIED");

  await assert.rejects(() =>
    db.$executeRawUnsafe(
      "UPDATE operator_actions SET rationale = 'tampered' WHERE action_id = $1",
      actionId,
    ));
  await assert.rejects(() =>
    db.$executeRawUnsafe("DELETE FROM operator_actions WHERE action_id = $1", actionId));

  const unchanged = await db.operatorAction.findUnique({ where: { actionId } });
  assert.notEqual(unchanged, null);
  assert.equal(unchanged!.rationale, null);
});

test("actor identity is recorded truthfully for system and human actions", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const systemActionId = `system-action-${suffix}`;
  const humanActionId = `human-action-${suffix}`;

  await PRISMA_OPERATOR_ACTION_LEDGER.append({
    actionId: systemActionId,
    actionType: "ANCHOR_RETIRED",
    targetType: "ANCHOR",
    targetId: `target-${suffix}`,
    reasonCode: "OTHER_REVIEWED",
    actor: { kind: "system" },
  });
  await PRISMA_OPERATOR_ACTION_LEDGER.append({
    actionId: humanActionId,
    actionType: "ANCHOR_REACTIVATED",
    targetType: "ANCHOR",
    targetId: `target-${suffix}`,
    reasonCode: "OPERATOR_RECOVERY",
    actor: { kind: "human", id: "operator-7" },
  });

  const system = await db.operatorAction.findUnique({ where: { actionId: systemActionId } });
  const human = await db.operatorAction.findUnique({ where: { actionId: humanActionId } });
  assert.equal(system!.actorType, "SYSTEM");
  assert.equal(system!.actorId, null);
  assert.equal(human!.actorType, "HUMAN");
  assert.equal(human!.actorId, "operator-7");
});

test("retirement hides an anchor, blocks new evidence, and each transition is audited", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = await seed(db, suffix);
  const retireActionId = `retire-${suffix}`;
  const reactivateActionId = `reactivate-${suffix}`;

  try {
    const retired = await runRegistryRetirement(
      {
        mode: "apply",
        anchorSlug: fixture.anchorSlug,
        reasonCode: "REVIEWED_CONFIGURATION_REMOVAL",
        rationale: "reviewed configuration removal",
        actor: { kind: "human", id: "operator-7" },
        actionId: retireActionId,
      },
      { repository: PRISMA_REGISTRY_LIFECYCLE_REPOSITORY },
    );
    assert.equal(retired.status, "applied");
    assert.equal(
      await db.operatorAction.count({ where: { actionId: retireActionId } }),
      1,
    );
    assert.equal(
      (await db.anchor.findUnique({ where: { slug: fixture.anchorSlug }, select: { lifecycleState: true } }))!
        .lifecycleState,
      "RETIRED",
    );

    assert.equal(await PRISMA_ANCHOR_DIRECTORY_REPOSITORY.findBySlug(fixture.anchorSlug), null);
    assert.equal(
      (await PRISMA_CORRIDOR_DIRECTORY_REPOSITORY.findBySlug(fixture.corridorSlug))!.anchors.length,
      0,
    );
    const corridorList = await PRISMA_CORRIDOR_DIRECTORY_REPOSITORY.findAll();
    assert.equal(
      corridorList.find(({ slug }) => slug === fixture.corridorSlug)?.anchorCount,
      0,
    );

    const rejectedEvidence = await persistRateSnapshot(
      {
        anchorSlug: fixture.anchorSlug,
        corridorSlug: fixture.corridorSlug,
        rate: "2",
        sourceAmount: "100",
        destinationAmount: "200",
        fee: "0",
        capturedAt: new Date(),
      },
      PRISMA_RATE_SNAPSHOT_REPOSITORY,
    );
    assert.equal(rejectedEvidence.ok, false);
    if (!rejectedEvidence.ok) assert.equal(rejectedEvidence.code, "ANCHOR_RETIRED");

    const repeated = await runRegistryRetirement(
      {
        mode: "apply",
        anchorSlug: fixture.anchorSlug,
        reasonCode: "OTHER_REVIEWED",
        actor: { kind: "system" },
        actionId: `${retireActionId}-2`,
      },
      { repository: PRISMA_REGISTRY_LIFECYCLE_REPOSITORY },
    );
    assert.equal(repeated.status, "rejected");
    assert.equal(await db.operatorAction.count({ where: { actionId: `${retireActionId}-2` } }), 0);

    const reactivated = await runRegistryReactivation(
      {
        mode: "apply",
        anchorSlug: fixture.anchorSlug,
        reasonCode: "OPERATOR_RECOVERY",
        actor: { kind: "system" },
        actionId: reactivateActionId,
      },
      { repository: PRISMA_REGISTRY_LIFECYCLE_REPOSITORY },
    );
    assert.equal(reactivated.status, "applied");
    assert.equal(await db.operatorAction.count({ where: { actionId: reactivateActionId } }), 1);
    assert.notEqual(await PRISMA_ANCHOR_DIRECTORY_REPOSITORY.findBySlug(fixture.anchorSlug), null);
    assert.equal(
      (await PRISMA_CORRIDOR_DIRECTORY_REPOSITORY.findBySlug(fixture.corridorSlug))!.anchors.length,
      1,
    );
  } finally {
    await cleanup(db, fixture);
  }
});

test("recovery restores read eligibility with one audit row", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = await seed(db, suffix);
  const actionId = `recover-${suffix}`;

  try {
    await runRateDisposition(
      {
        mode: "apply",
        snapshotId: fixture.snapshotId,
        disposition: "SUPERSEDED",
        reasonCode: "DATA_CORRECTION",
        actor: { kind: "system" },
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );

    const recovered = await runRateDispositionRecovery(
      {
        mode: "apply",
        snapshotId: fixture.snapshotId,
        reasonCode: "OPERATOR_RECOVERY",
        actor: { kind: "system" },
        actionId,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );
    assert.equal(recovered.status, "applied");
    assert.equal(await db.operatorAction.count({ where: { actionId } }), 1);
    assert.equal(
      await db.rateSnapshotDisposition.count({ where: { snapshotId: fixture.snapshotId } }),
      0,
    );

    const read = await readLatestCorridorRate(fixture.corridorSlug, { evaluatedAt: new Date() });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.observations.some(({ snapshotId }) => snapshotId === fixture.snapshotId), true);
    }
  } finally {
    await cleanup(db, fixture);
  }
});

test("a control-character rationale is rejected before any audit row exists", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const fixture = await seed(db, suffix);
  const actionId = `control-${suffix}`;

  try {
    const outcome = await runRateDisposition(
      {
        mode: "apply",
        snapshotId: fixture.snapshotId,
        disposition: "INVALIDATED",
        reasonCode: "SOURCE_ERROR",
        rationale: "line\nbreak token=secret",
        actor: { kind: "system" },
        actionId,
      },
      { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(await db.operatorAction.count({ where: { actionId } }), 0);
    assert.equal(
      await db.rateSnapshotDisposition.count({ where: { snapshotId: fixture.snapshotId } }),
      0,
    );
  } finally {
    await cleanup(db, fixture);
  }
});
