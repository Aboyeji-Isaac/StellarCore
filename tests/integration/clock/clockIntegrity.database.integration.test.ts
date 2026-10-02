import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { CLOCK_MAXIMUM_SKEW_MS } from "@/constants/clock";
import { createControlledClock } from "@/lib/clock/clock";
import {
  PRISMA_CLOCK_INTEGRITY_RECORDER,
  PRISMA_DATABASE_CLOCK_READER,
} from "@/lib/clock/clockIntegrityRepository";
import {
  checkClockIntegrity,
  createClockIntegrityGuard,
} from "@/lib/clock/integrity";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";

const ENABLED = process.env.RUN_CLOCK_INTEGRITY_DATABASE_INTEGRATION === "1";

test("PostgreSQL returns an authoritative clock comparable to the application clock", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const databaseTime = await PRISMA_DATABASE_CLOCK_READER.readDatabaseTime();
  assert.equal(databaseTime instanceof Date, true);
  assert.equal(Number.isFinite(databaseTime.getTime()), true);
  // A real database clock is within the reviewed tolerance of the app clock.
  const skewMs = Math.abs(Date.now() - databaseTime.getTime());
  assert.ok(skewMs <= CLOCK_MAXIMUM_SKEW_MS, `unexpected skew of ${skewMs}ms`);
});

test("a real database round trip passes the gate and persists one bounded row", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const runId = `clock-ok-${randomUUID()}`;

  try {
    const databaseTime = await PRISMA_DATABASE_CLOCK_READER.readDatabaseTime();
    const guard = createClockIntegrityGuard("RATE_CAPTURE", {
      clock: createControlledClock(databaseTime),
      reader: PRISMA_DATABASE_CLOCK_READER,
      recorder: PRISMA_CLOCK_INTEGRITY_RECORDER,
      runId,
    });

    const verdict = await guard.check();
    assert.equal(verdict.outcome, "PASSED");

    const rows = await db.clockIntegrityCheck.findMany({ where: { runId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, "PASSED");
    assert.equal(rows[0]?.code, null);
    assert.equal(rows[0]?.toleranceMs, CLOCK_MAXIMUM_SKEW_MS);
    assert.equal(rows[0]?.boundary, "RATE_CAPTURE");
    assert.equal(rows[0]?.applicationTime?.toISOString(), databaseTime.toISOString());
    assert.equal(rows[0]?.databaseTime instanceof Date, true);
  } finally {
    await db.clockIntegrityCheck.deleteMany({ where: { runId } });
    await db.$disconnect();
  }
});

test("excessive positive skew is rejected against the real database clock and quarantined", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const runId = `clock-skew-${randomUUID()}`;

  try {
    const databaseTime = await PRISMA_DATABASE_CLOCK_READER.readDatabaseTime();
    const verdict = await checkClockIntegrity("REPUTATION_EVALUATION", {
      clock: createControlledClock(
        new Date(databaseTime.getTime() + CLOCK_MAXIMUM_SKEW_MS + 60_000),
      ),
      reader: PRISMA_DATABASE_CLOCK_READER,
      recorder: PRISMA_CLOCK_INTEGRITY_RECORDER,
      runId,
    });

    assert.equal(verdict.outcome, "REJECTED");
    assert.equal(verdict.code, "CLOCK_SKEW_EXCEEDED");
    assert.equal(verdict.direction, "POSITIVE");

    const rows = await db.clockIntegrityCheck.findMany({ where: { runId } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.outcome, "REJECTED");
    assert.equal(rows[0]?.code, "CLOCK_SKEW_EXCEEDED");
    assert.equal(rows[0]?.boundary, "REPUTATION_EVALUATION");
  } finally {
    await db.clockIntegrityCheck.deleteMany({ where: { runId } });
    await db.$disconnect();
  }
});

test("a clock check never rewrites existing persisted timestamps", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-clock-anchor-${suffix}`;
  const corridorSlug = `test-clock-corridor-${suffix}`;
  const capturedAt = new Date("2026-08-01T00:00:00.000Z");
  const runId = `clock-immutable-${suffix}`;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Clock Integrity Fixture",
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
        assetCodeTo: "USD",
        countryTo: "US",
      },
      select: { id: true },
    });
    const snapshot = await db.rateSnapshot.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridor.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt,
      },
      select: { id: true, capturedAt: true },
    });

    const before = snapshot.capturedAt.toISOString();
    const databaseTime = await PRISMA_DATABASE_CLOCK_READER.readDatabaseTime();
    await createClockIntegrityGuard("RATE_CAPTURE", {
      clock: createControlledClock(databaseTime),
      reader: PRISMA_DATABASE_CLOCK_READER,
      recorder: PRISMA_CLOCK_INTEGRITY_RECORDER,
      runId,
    }).check();

    const after = await db.rateSnapshot.findUniqueOrThrow({
      where: { id: snapshot.id },
      select: { capturedAt: true },
    });
    assert.equal(after.capturedAt.toISOString(), before);
    assert.equal(after.capturedAt.toISOString(), capturedAt.toISOString());
  } finally {
    await db.clockIntegrityCheck.deleteMany({ where: { runId } });
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});

test("a persisted future timestamp is never treated as fresh", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-clock-future-anchor-${suffix}`;
  const corridorSlug = `test-clock-future-corridor-${suffix}`;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Future Clock Fixture",
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
        assetCodeTo: "USD",
        countryTo: "US",
      },
      select: { id: true },
    });
    const databaseTime = await PRISMA_DATABASE_CLOCK_READER.readDatabaseTime();
    await db.rateSnapshot.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridor.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt: new Date(databaseTime.getTime() + 60 * 60 * 1_000),
      },
    });

    const read = await readLatestCorridorRate(corridorSlug, {
      evaluatedAt: databaseTime,
    });
    assert.equal(read.ok, true);
    if (read.ok) {
      assert.equal(read.observations[0]?.freshnessState, "future");
      assert.equal(read.observations[0]?.included, false);
      assert.equal(read.state, "insufficient_fresh_sources");
    }
  } finally {
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});
