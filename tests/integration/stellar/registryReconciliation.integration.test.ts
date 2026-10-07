import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRegistryReconciliationReport,
} from "@/lib/stellar/registryReconciliation";
import {
  formatRegistryReconciliationReport,
} from "@/lib/stellar/registryReconciliationReport";
import {
  PRISMA_REGISTRY_RECONCILIATION_REPOSITORY,
} from "@/lib/stellar/registryReconciliationRepository";
import type {
  PersistedReconciliationState,
} from "@/types/registryReconciliation";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

/**
 * Integration fixtures for the registry reconciliation auditor.
 *
 * These fixtures simulate a small persisted database with several simultaneous
 * drift classes present at once. They exercise the full pipeline boundary —
 * repository-shaped projections feeding the pure auditor and report formatter —
 * without requiring a live PostgreSQL connection, matching the repo's
 * controlled-integration convention (no network, no writes, deterministic).
 */

const REGISTRY_ANCHORS: readonly AnchorRegistryEntry[] = Object.freeze([
  Object.freeze({
    slug: "moneygram",
    name: "MoneyGram",
    homeDomain: "mgxanchor.moneygram.com",
  }),
  Object.freeze({
    slug: "cowrie",
    name: "Cowrie",
    homeDomain: "cowrie.exchange",
  }),
]);

const REGISTRY_CORRIDORS: readonly CorridorRegistryEntry[] = Object.freeze([
  Object.freeze({
    slug: "usdc-us-usd-us",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "USD",
    countryTo: "US",
  }),
  Object.freeze({
    slug: "ngnt-ng-ngn-ng",
    assetCodeFrom: "NGNT",
    countryFrom: "NG",
    assetCodeTo: "NGN",
    countryTo: "NG",
  }),
  Object.freeze({
    slug: "usdc-us-brl-br",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
  }),
]);

const REGISTRY_MAPPINGS: readonly AnchorCorridorRegistryEntry[] = Object.freeze([
  Object.freeze({
    anchorSlug: "moneygram",
    corridorSlugs: Object.freeze(["usdc-us-usd-us", "usdc-us-brl-br"]),
  }),
  Object.freeze({
    anchorSlug: "cowrie",
    corridorSlugs: Object.freeze(["ngnt-ng-ngn-ng"]),
  }),
]);

/**
 * Simulated persisted state with simultaneous drift:
 * - "cowrie" missing (MISSING_ANCHOR + MISSING_ASSOCIATION);
 * - "usdc-us-brl-br" missing (MISSING_CORRIDOR + MISSING_ASSOCIATION);
 * - "zeam" persisted but unreviewed with rate snapshots (UNEXPECTED_ANCHOR,
 *   STALE_ANCHOR, ORPHANED_RATE_SNAPSHOT);
 * - "xlm-global-usd-us" persisted but unreviewed (UNEXPECTED_CORRIDOR,
 *   ORPHANED_CORRIDOR_LINK via zeam's junction, no evidence);
 * - "moneygram" renamed in the database (ANCHOR_FIELD_MISMATCH);
 * - "usdc-us-usd-us" destination country drift (CORRIDOR_FIELD_MISMATCH);
 * - moneygram holds an unreviewed extra junction (UNEXPECTED_ASSOCIATION).
 */
const DRIFTED_STATE: PersistedReconciliationState = Object.freeze({
  anchors: Object.freeze([
    Object.freeze({
      slug: "moneygram",
      name: "MoneyGram International",
      homeDomain: "mgxanchor.moneygram.com",
      tomlUrl: "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
      status: "LIVE",
      corridorCount: 2,
      rateSnapshotCount: 0,
      transferOutcomeCount: 0,
    }),
    Object.freeze({
      slug: "zeam",
      name: "Zeam",
      homeDomain: "zeam.money",
      tomlUrl: "https://zeam.money/.well-known/stellar.toml",
      status: "DEGRADED",
      corridorCount: 1,
      rateSnapshotCount: 7,
      transferOutcomeCount: 4,
    }),
  ]),
  corridors: Object.freeze([
    Object.freeze({
      slug: "usdc-us-usd-us",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "CA",
      anchorCount: 2,
      rateSnapshotCount: 0,
      transferOutcomeCount: 0,
    }),
    Object.freeze({
      slug: "ngnt-ng-ngn-ng",
      assetCodeFrom: "NGNT",
      countryFrom: "NG",
      assetCodeTo: "NGN",
      countryTo: "NG",
      anchorCount: 0,
      rateSnapshotCount: 0,
      transferOutcomeCount: 0,
    }),
    Object.freeze({
      slug: "xlm-global-usd-us",
      assetCodeFrom: "XLM",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "US",
      anchorCount: 1,
      rateSnapshotCount: 0,
      transferOutcomeCount: 0,
    }),
  ]),
  associations: Object.freeze([
    Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
    Object.freeze({ anchorSlug: "moneygram", corridorSlug: "xlm-global-usd-us" }),
    Object.freeze({ anchorSlug: "moneygram", corridorSlug: "ngnt-ng-ngn-ng" }),
    Object.freeze({ anchorSlug: "zeam", corridorSlug: "xlm-global-usd-us" }),
  ]),
});

type ReconciliationRepositoryStub = Pick<
  typeof PRISMA_REGISTRY_RECONCILIATION_REPOSITORY,
  "loadPersistedState"
>;

function repositoryFrom(
  state: PersistedReconciliationState,
): ReconciliationRepositoryStub {
  return {
    loadPersistedState: async () => state,
  };
}

async function buildReport(
  repository: ReconciliationRepositoryStub,
) {
  const persisted = await repository.loadPersistedState();
  return buildRegistryReconciliationReport({
    anchors: REGISTRY_ANCHORS,
    corridors: REGISTRY_CORRIDORS,
    anchorCorridorMappings: REGISTRY_MAPPINGS,
    persisted,
  });
}

test("integration fixture with several drift classes classifies each independently", async () => {
  const report = await buildReport(repositoryFrom(DRIFTED_STATE));
  const { result } = report;

  const present = new Set(result.issues.map(({ code }) => code));
  for (const expected of [
    "MISSING_ANCHOR",
    "MISSING_CORRIDOR",
    "UNEXPECTED_ANCHOR",
    "UNEXPECTED_CORRIDOR",
    "ANCHOR_FIELD_MISMATCH",
    "CORRIDOR_FIELD_MISMATCH",
    "MISSING_ASSOCIATION",
    "UNEXPECTED_ASSOCIATION",
    "ORPHANED_CORRIDOR_LINK",
    "ORPHANED_RATE_SNAPSHOT",
    "ORPHANED_TRANSFER_OUTCOME",
    "STALE_ANCHOR",
  ] as const) {
    assert.ok(present.has(expected), `expected issue ${expected}`);
  }

  assert.equal(result.summary.missingAnchors, 1);
  assert.equal(result.summary.missingCorridors, 1);
  assert.equal(result.summary.unexpectedAnchors, 1);
  assert.equal(result.summary.unexpectedCorridors, 1);
  assert.equal(result.summary.anchorFieldMismatches, 1);
  assert.equal(result.summary.corridorFieldMismatches, 1);
  assert.equal(result.summary.missingAssociations, 2);
  assert.equal(result.summary.unexpectedAssociations, 1);
  assert.equal(result.summary.orphanedCorridorLinks, 1);
  assert.equal(result.historicalEvidence.orphanedAnchors, 1);
  assert.equal(result.historicalEvidence.rateSnapshotsAttachedToOrphanedAnchors, 7);
  assert.equal(result.historicalEvidence.transferOutcomesAttachedToOrphanedAnchors, 4);
  assert.equal(result.drift, true);
});

test("integration fixture repair plan separates safe, manual, and blocked actions", async () => {
  const report = await buildReport(repositoryFrom(DRIFTED_STATE));
  const { plan } = report;
  const safeKinds = plan.safeActions.map(({ kind }) => kind);
  assert.deepEqual([...safeKinds].sort(), [
    "CREATE_ANCHOR",
    "CREATE_ASSOCIATION",
    "CREATE_ASSOCIATION",
    "CREATE_CORRIDOR",
    "UPDATE_ANCHOR",
    "UPDATE_CORRIDOR",
  ].sort());
  assert.ok(plan.safeActions.every(({ kind }) => kind !== "REMOVE_ASSOCIATION"));
  assert.ok(plan.safeActions.every(({ kind }) => kind !== "RETIRE_ANCHOR"));
  assert.ok(plan.safeActions.every(({ kind }) => kind !== "RETIRE_CORRIDOR"));

  const manualKinds = plan.manualReviewActions.map(({ kind }) => kind);
  assert.ok(manualKinds.includes("REMOVE_ASSOCIATION"));
  assert.ok(manualKinds.includes("RETIRE_ANCHOR"));
  assert.ok(manualKinds.includes("RETIRE_CORRIDOR"));

  // Zeam carries 11 historical evidence rows: its retirement is blocked.
  const blocked = plan.skippedEvidenceDeletions.find(
    ({ kind }) => kind === "RETIRE_ANCHOR",
  );
  assert.ok(blocked);
  assert.equal(blocked.anchorSlug, "zeam");
  assert.equal(blocked.historicalEvidenceCount, 11);
  assert.equal(plan.appliesWithoutManualAction, false);
});

test("integration fixture report stays machine-readable and deterministic", async () => {
  const repository = repositoryFrom(DRIFTED_STATE);
  const first = await buildReport(repository);
  const second = await buildReport(repository);

  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);

  const text = formatRegistryReconciliationReport(first);
  assert.match(text, /Drift detected: \d+ issue\(s\)\./);
  assert.match(text, /"moneygram <-> ngnt-ng-ngn-ng"/);
  assert.match(text, /"zeam" holds 7 rate snapshot\(s\)/);
  assert.match(text, /"zeam" holds 4 transfer outcome\(s\)/);
  assert.match(text, /historical evidence rows: 11/);
  assert.match(text, /This plan is NOT applied/);
});

test("clean simulated database reconciles with no drift through the repository boundary", async () => {
  const cleanState: PersistedReconciliationState = Object.freeze({
    anchors: Object.freeze([
      Object.freeze({
        slug: "moneygram",
        name: "MoneyGram",
        homeDomain: "mgxanchor.moneygram.com",
        tomlUrl: "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
        status: "LIVE",
        corridorCount: 2,
        rateSnapshotCount: 3,
        transferOutcomeCount: 1,
      }),
      Object.freeze({
        slug: "cowrie",
        name: "Cowrie",
        homeDomain: "cowrie.exchange",
        tomlUrl: "https://cowrie.exchange/.well-known/stellar.toml",
        status: "LIVE",
        corridorCount: 1,
        rateSnapshotCount: 0,
        transferOutcomeCount: 0,
      }),
    ]),
    corridors: Object.freeze([
      Object.freeze({
        slug: "usdc-us-usd-us",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "USD",
        countryTo: "US",
        anchorCount: 1,
        rateSnapshotCount: 3,
        transferOutcomeCount: 1,
      }),
      Object.freeze({
        slug: "ngnt-ng-ngn-ng",
        assetCodeFrom: "NGNT",
        countryFrom: "NG",
        assetCodeTo: "NGN",
        countryTo: "NG",
        anchorCount: 1,
        rateSnapshotCount: 0,
        transferOutcomeCount: 0,
      }),
      Object.freeze({
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
        anchorCount: 1,
        rateSnapshotCount: 0,
        transferOutcomeCount: 0,
      }),
    ]),
    associations: Object.freeze([
      Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
      Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-brl-br" }),
      Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
    ]),
  });

  const report = await buildReport(repositoryFrom(cleanState));

  assert.equal(report.result.drift, false);
  assert.deepEqual(report.result.issues, []);
  assert.equal(report.plan.appliesWithoutManualAction, true);
  assert.equal(report.plan.safeActions.length, 0);
  assert.equal(
    formatRegistryReconciliationReport(report).includes("No drift"),
    true,
  );
});
