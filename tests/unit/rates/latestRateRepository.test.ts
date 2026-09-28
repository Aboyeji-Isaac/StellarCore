import assert from "node:assert/strict";
import test from "node:test";

import { Prisma } from "@/app/generated/prisma/client";
import { toRepositoryObservation } from "@/lib/rates/latestRateRepository";

const CAPTURED_AT = new Date("2026-09-28T12:00:00.000Z");

test("repository rows map to string decimals and preserve captured instants", () => {
  const observation = toRepositoryObservation({
    id: "snapshot-1",
    anchorSlug: "zeam",
    anchorName: "Zeam",
    authorityId: "auth-0001",
    authorityConfigurationVersion: 1,
    rate: new Prisma.Decimal("0.170000000000000001"),
    sourceAmount: new Prisma.Decimal("100.000000000000000001"),
    destinationAmount: new Prisma.Decimal("17.000000000000000001"),
    fee: new Prisma.Decimal("1"),
    capturedAt: CAPTURED_AT,
  });

  assert.deepEqual(observation, {
    id: "snapshot-1",
    anchorSlug: "zeam",
    anchorName: "Zeam",
    authorityId: "auth-0001",
    authorityConfigurationVersion: 1,
    rate: "0.170000000000000001",
    sourceAmount: "100.000000000000000001",
    destinationAmount: "17.000000000000000001",
    fee: "1",
    capturedAt: new Date(CAPTURED_AT.getTime()),
  });
  assert.notEqual(observation.capturedAt, CAPTURED_AT);
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(typeof observation.rate, "string");
});

test("legacy rows without authority provenance map to unknown authority", () => {
  const observation = toRepositoryObservation({
    id: "snapshot-legacy",
    anchorSlug: "zeam",
    anchorName: "Zeam",
    authorityId: null,
    authorityConfigurationVersion: null,
    rate: new Prisma.Decimal("0.17"),
    sourceAmount: new Prisma.Decimal("100"),
    destinationAmount: new Prisma.Decimal("17"),
    fee: new Prisma.Decimal("0"),
    capturedAt: CAPTURED_AT,
  });

  assert.equal(observation.authorityId, null);
  assert.equal(observation.authorityConfigurationVersion, null);
});
