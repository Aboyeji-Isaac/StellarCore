import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRegistryReconciliationReport,
  buildRegistryRepairPlan,
  reconcileRegistryWithDatabase,
} from "@/lib/stellar/registryReconciliation";
import { formatRegistryReconciliationReport } from "@/lib/stellar/registryReconciliationReport";
import type {
  PersistedReconciliationState,
  RegistryReconciliationInput,
  ReconciliationIssueCode,
} from "@/types/registryReconciliation";

const MONEYGRAM = Object.freeze({
  slug: "moneygram",
  name: "MoneyGram",
  homeDomain: "mgxanchor.moneygram.com",
});

const COWRIE = Object.freeze({
  slug: "cowrie",
  name: "Cowrie",
  homeDomain: "cowrie.exchange",
});

const USD_CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
});

const NGN_CORRIDOR = Object.freeze({
  slug: "ngnt-ng-ngn-ng",
  assetCodeFrom: "NGNT",
  countryFrom: "NG",
  assetCodeTo: "NGN",
  countryTo: "NG",
});

const REGISTRY_ANCHORS = Object.freeze([MONEYGRAM, COWRIE]);
const REGISTRY_CORRIDORS = Object.freeze([USD_CORRIDOR, NGN_CORRIDOR]);
const REGISTRY_MAPPINGS = Object.freeze([
  Object.freeze({ anchorSlug: "moneygram", corridorSlugs: ["usdc-us-usd-us"] }),
  Object.freeze({ anchorSlug: "cowrie", corridorSlugs: ["ngnt-ng-ngn-ng"] }),
]);

function persistedAnchor(
  slug: string,
  overrides: Partial<{
    name: string;
    homeDomain: string;
    tomlUrl: string;
    status: string;
    corridorCount: number;
    rateSnapshotCount: number;
    transferOutcomeCount: number;
  }> = {},
) {
  const homeDomain = REGISTRY_ANCHORS.find((a) => a.slug === slug)?.homeDomain
    ?? `${slug}.example.com`;
  return Object.freeze({
    slug,
    name: slug,
    homeDomain,
    tomlUrl: `https://${homeDomain}/.well-known/stellar.toml`,
    status: "LIVE",
    corridorCount: 0,
    rateSnapshotCount: 0,
    transferOutcomeCount: 0,
    ...overrides,
  });
}

function persistedCorridor(
  slug: string,
  overrides: Partial<{
    assetCodeFrom: string;
    countryFrom: string;
    assetCodeTo: string;
    countryTo: string;
    anchorCount: number;
    rateSnapshotCount: number;
    transferOutcomeCount: number;
  }> = {},
) {
  const registry = [USD_CORRIDOR, NGN_CORRIDOR].find((c) => c.slug === slug);
  return Object.freeze({
    slug,
    assetCodeFrom: registry?.assetCodeFrom ?? "USDC",
    countryFrom: registry?.countryFrom ?? "US",
    assetCodeTo: registry?.assetCodeTo ?? "USD",
    countryTo: registry?.countryTo ?? "US",
    anchorCount: 0,
    rateSnapshotCount: 0,
    transferOutcomeCount: 0,
    ...overrides,
  });
}

function cleanState(): PersistedReconciliationState {
  return Object.freeze({
    anchors: Object.freeze([
      persistedAnchor("moneygram", { name: "MoneyGram", corridorCount: 1 }),
      persistedAnchor("cowrie", { name: "Cowrie", corridorCount: 1 }),
    ]),
    corridors: Object.freeze([
      persistedCorridor("usdc-us-usd-us", { anchorCount: 1 }),
      persistedCorridor("ngnt-ng-ngn-ng", { anchorCount: 1 }),
    ]),
    associations: Object.freeze([
      Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
      Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
    ]),
  });
}

function input(
  overrides: Partial<{
    anchors: RegistryReconciliationInput["anchors"];
    corridors: RegistryReconciliationInput["corridors"];
    mappings: RegistryReconciliationInput["anchorCorridorMappings"];
    persisted: PersistedReconciliationState;
  }> = {},
): RegistryReconciliationInput {
  return Object.freeze({
    anchors: overrides.anchors ?? REGISTRY_ANCHORS,
    corridors: overrides.corridors ?? REGISTRY_CORRIDORS,
    anchorCorridorMappings: overrides.mappings ?? REGISTRY_MAPPINGS,
    persisted: overrides.persisted ?? cleanState(),
  });
}

function codes(result: { issues: readonly { code: ReconciliationIssueCode }[] }) {
  return result.issues.map(({ code }) => code);
}

test("clean database and registry state reports no drift", () => {
  const result = reconcileRegistryWithDatabase(input());

  assert.equal(result.drift, false);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.summary.totalIssues, 0);
  assert.deepEqual(result.historicalEvidence, {
    orphanedAnchors: 0,
    orphanedCorridors: 0,
    rateSnapshotsAttachedToOrphanedAnchors: 0,
    rateSnapshotsAttachedToOrphanedCorridors: 0,
    transferOutcomesAttachedToOrphanedAnchors: 0,
    transferOutcomesAttachedToOrphanedCorridors: 0,
  });

  const plan = buildRegistryRepairPlan(result);
  assert.deepEqual(plan.safeActions, []);
  assert.deepEqual(plan.manualReviewActions, []);
  assert.deepEqual(plan.skippedEvidenceDeletions, []);
  assert.equal(plan.appliesWithoutManualAction, true);
});

test("a reviewed anchor missing from the database is classified and planned", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      anchors: Object.freeze(state.anchors.filter(({ slug }) => slug !== "cowrie")),
    }),
  }));

  assert.deepEqual(codes(result), ["MISSING_ANCHOR"]);
  assert.equal(result.summary.missingAnchors, 1);

  const plan = buildRegistryRepairPlan(result);
  assert.deepEqual(plan.safeActions, [Object.freeze({
    kind: "CREATE_ANCHOR",
    entity: "anchor",
    anchorSlug: "cowrie",
    requiresManualReview: false,
    blockedByHistoricalEvidence: false,
  })]);
  assert.equal(plan.appliesWithoutManualAction, true);
});

test("a reviewed corridor missing from the database is classified and planned", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      corridors: Object.freeze(
        state.corridors.filter(({ slug }) => slug !== "ngnt-ng-ngn-ng"),
      ),
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
      ]),
    }),
  }));

  // The dropped junction endpoints are both reviewed rows, so it is a plain
  // MISSING_ASSOCIATION plus the MISSING_CORRIDOR.
  assert.deepEqual(codes(result), ["MISSING_ASSOCIATION", "MISSING_CORRIDOR"]);
  assert.equal(result.summary.missingCorridors, 1);

  const plan = buildRegistryRepairPlan(result);
  const create = plan.safeActions.find(({ kind }) => kind === "CREATE_CORRIDOR");
  assert.ok(create);
  assert.equal(create.corridorSlug, "ngnt-ng-ngn-ng");
  assert.equal(plan.appliesWithoutManualAction, true);
});

test("an unexpected evidence-free anchor is visible and requires manual review", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      anchors: Object.freeze([
        ...state.anchors,
        persistedAnchor("ghost-anchor"),
      ]),
    }),
  }));

  assert.deepEqual(codes(result), ["UNEXPECTED_ANCHOR"]);
  assert.equal(result.summary.unexpectedAnchors, 1);
  assert.equal(result.summary.staleAnchors, 0);
  assert.equal(result.historicalEvidence.orphanedAnchors, 1);
  assert.equal(result.historicalEvidence.rateSnapshotsAttachedToOrphanedAnchors, 0);

  const plan = buildRegistryRepairPlan(result);
  assert.equal(plan.safeActions.length, 0);
  assert.equal(plan.manualReviewActions.length, 1);
  assert.equal(plan.manualReviewActions[0]?.kind, "RETIRE_ANCHOR");
  assert.equal(plan.manualReviewActions[0]?.blockedByHistoricalEvidence, false);
  assert.equal(plan.appliesWithoutManualAction, false);
});

test("an unexpected corridor with evidence blocks automated retirement", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      corridors: Object.freeze([
        ...state.corridors,
        persistedCorridor("legacy-corridor", {
          assetCodeFrom: "EURC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
          rateSnapshotCount: 12,
          transferOutcomeCount: 3,
        }),
      ]),
    }),
  }));

  assert.ok(codes(result).includes("UNEXPECTED_CORRIDOR"));
  assert.ok(codes(result).includes("ORPHANED_RATE_SNAPSHOT"));
  assert.ok(codes(result).includes("ORPHANED_TRANSFER_OUTCOME"));
  assert.ok(codes(result).includes("STALE_CORRIDOR"));
  assert.equal(result.historicalEvidence.orphanedCorridors, 1);
  assert.equal(result.historicalEvidence.rateSnapshotsAttachedToOrphanedCorridors, 12);
  assert.equal(result.historicalEvidence.transferOutcomesAttachedToOrphanedCorridors, 3);

  const plan = buildRegistryRepairPlan(result);
  const retire = plan.skippedEvidenceDeletions.find(
    ({ kind }) => kind === "RETIRE_CORRIDOR",
  );
  assert.ok(retire);
  assert.equal(retire.blockedByHistoricalEvidence, true);
  assert.equal(retire.historicalEvidenceCount, 15);
  assert.equal(plan.appliesWithoutManualAction, false);
});

test("field mismatches are distinguished per field with expected and actual values", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      anchors: Object.freeze([
        persistedAnchor("moneygram", {
          name: "MoneyGram International",
          corridorCount: 1,
        }),
        persistedAnchor("cowrie", { name: "Cowrie", corridorCount: 1 }),
      ]),
      corridors: Object.freeze([
        persistedCorridor("usdc-us-usd-us", { anchorCount: 1, countryTo: "CA" }),
        persistedCorridor("ngnt-ng-ngn-ng", { anchorCount: 1 }),
      ]),
    }),
  }));

  assert.ok(codes(result).includes("ANCHOR_FIELD_MISMATCH"));
  assert.ok(codes(result).includes("CORRIDOR_FIELD_MISMATCH"));

  const anchorMismatch = result.issues.find(
    ({ code }) => code === "ANCHOR_FIELD_MISMATCH",
  );
  assert.equal(anchorMismatch?.field, "name");
  assert.equal(anchorMismatch?.expected, "MoneyGram");
  assert.equal(anchorMismatch?.actual, "MoneyGram International");

  const corridorMismatch = result.issues.find(
    ({ code }) => code === "CORRIDOR_FIELD_MISMATCH",
  );
  assert.equal(corridorMismatch?.field, "countryTo");
  assert.equal(corridorMismatch?.expected, "US");
  assert.equal(corridorMismatch?.actual, "CA");

  const plan = buildRegistryRepairPlan(result);
  assert.equal(plan.safeActions.length, 2);
  assert.ok(plan.safeActions.every(({ kind }) => kind.startsWith("UPDATE_")));
  assert.equal(plan.appliesWithoutManualAction, true);
});

test("a stale tomlUrl mismatch is detected against the canonical discovery URL", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      anchors: Object.freeze([
        persistedAnchor("moneygram", {
          name: "MoneyGram",
          corridorCount: 1,
          tomlUrl: "https://mgxanchor.moneygram.com/stellar.toml",
        }),
        persistedAnchor("cowrie", { name: "Cowrie", corridorCount: 1 }),
      ]),
    }),
  }));

  const mismatch = result.issues.find(
    ({ code }) => code === "ANCHOR_FIELD_MISMATCH",
  );
  assert.equal(mismatch?.field, "tomlUrl");
  assert.equal(
    mismatch?.expected,
    "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
  );
});

test("association drift separates missing, unexpected, and orphaned links", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    // moneygram loses its reviewed junction (MISSING_ASSOCIATION);
    // cowrie gains an extra junction to a reviewed corridor (UNEXPECTED_ASSOCIATION);
    // a ghost anchor keeps a junction (ORPHANED_ANCHOR_LINK).
    persisted: Object.freeze({
      ...state,
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "ghost-anchor", corridorSlug: "usdc-us-usd-us" }),
      ]),
    }),
  }));

  assert.ok(codes(result).includes("MISSING_ASSOCIATION"));
  assert.ok(codes(result).includes("UNEXPECTED_ASSOCIATION"));
  assert.ok(codes(result).includes("ORPHANED_ANCHOR_LINK"));
  assert.equal(result.summary.orphanedAnchorLinks, 1);

  // The dangling junction references a registry-unlisted slug, so it is an
  // orphaned link; no anchor row exists for it, so no UNEXPECTED_ANCHOR fires.
  assert.equal(codes(result).includes("UNEXPECTED_ANCHOR"), false);
});

test("orphaned corridor links are classified separately from orphaned anchor links", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      corridors: Object.freeze([
        persistedCorridor("usdc-us-usd-us", { anchorCount: 1 }),
        persistedCorridor("ngnt-ng-ngn-ng", { anchorCount: 1 }),
        persistedCorridor("ghost-corridor", {
          assetCodeFrom: "XLM",
          countryFrom: "US",
          assetCodeTo: "USD",
          countryTo: "US",
        }),
      ]),
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "ghost-corridor" }),
      ]),
    }),
  }));

  assert.ok(codes(result).includes("ORPHANED_CORRIDOR_LINK"));
  assert.equal(result.summary.orphanedCorridorLinks, 1);
  assert.equal(result.summary.orphanedAnchorLinks, 0);
});

test("unexpected association removal requires explicit maintainer review", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...state,
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "usdc-us-usd-us" }),
      ]),
    }),
  }));

  const plan = buildRegistryRepairPlan(result);
  assert.equal(plan.safeActions.length, 0);
  assert.equal(plan.manualReviewActions.length, 1);
  assert.equal(plan.manualReviewActions[0]?.kind, "REMOVE_ASSOCIATION");
  assert.equal(plan.manualReviewActions[0]?.anchorSlug, "cowrie");
  assert.equal(plan.manualReviewActions[0]?.corridorSlug, "usdc-us-usd-us");
  assert.equal(plan.appliesWithoutManualAction, false);
});

test("multiple simultaneous drift classes are distinguished in one run", () => {
  const result = reconcileRegistryWithDatabase(input({
    anchors: [...REGISTRY_ANCHORS, Object.freeze({
      slug: "zeam",
      name: "Zeam",
      homeDomain: "zeam.money",
    })],
    corridors: [...REGISTRY_CORRIDORS, Object.freeze({
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    })],
    persisted: Object.freeze({
      anchors: Object.freeze([
        persistedAnchor("moneygram", {
          name: "MoneyGram Renamed",
          corridorCount: 1,
        }),
        persistedAnchor("cowrie", { name: "Cowrie", corridorCount: 1 }),
        persistedAnchor("ghost-anchor", { rateSnapshotCount: 5 }),
      ]),
      corridors: Object.freeze([
        persistedCorridor("usdc-us-usd-us", { anchorCount: 1 }),
        persistedCorridor("ngnt-ng-ngn-ng", {
          anchorCount: 1,
          countryTo: "GH",
        }),
        persistedCorridor("ghost-corridor", {
          assetCodeFrom: "XLM",
          countryFrom: "US",
          assetCodeTo: "USD",
          countryTo: "US",
          transferOutcomeCount: 2,
        }),
      ]),
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
        Object.freeze({ anchorSlug: "ghost-anchor", corridorSlug: "ghost-corridor" }),
      ]),
    }),
  }));

  const present = new Set(codes(result));
  for (const expected of [
    "MISSING_ASSOCIATION",
    "UNEXPECTED_ASSOCIATION",
    "ANCHOR_FIELD_MISMATCH",
    "CORRIDOR_FIELD_MISMATCH",
    "UNEXPECTED_ANCHOR",
    "UNEXPECTED_CORRIDOR",
    "STALE_ANCHOR",
    "STALE_CORRIDOR",
    // ghost-anchor <-> ghost-corridor junction: anchor endpoint wins the
    // orphan classification when both endpoints are registry-unlisted.
    "ORPHANED_ANCHOR_LINK",
    "ORPHANED_RATE_SNAPSHOT",
    "ORPHANED_TRANSFER_OUTCOME",
    "MISSING_ANCHOR",
    "MISSING_CORRIDOR",
  ] as const) {
    assert.ok(present.has(expected), `expected issue ${expected}`);
  }

  assert.equal(result.summary.totalIssues, result.issues.length);
  assert.equal(result.summary.missingAnchors, 1);
  assert.equal(result.summary.missingCorridors, 1);
  assert.equal(result.summary.orphanedAnchorLinks, 1);
  assert.equal(result.summary.orphanedCorridorLinks, 0);
  assert.equal(result.historicalEvidence.orphanedAnchors, 1);
  assert.equal(result.historicalEvidence.orphanedCorridors, 1);
  assert.equal(result.historicalEvidence.rateSnapshotsAttachedToOrphanedAnchors, 5);
  assert.equal(result.historicalEvidence.transferOutcomesAttachedToOrphanedCorridors, 2);

  const plan = buildRegistryRepairPlan(result);
  const kinds = plan.safeActions.map(({ kind }) => kind);
  assert.ok(kinds.includes("CREATE_ANCHOR"));
  assert.ok(kinds.includes("CREATE_CORRIDOR"));
  assert.ok(kinds.includes("CREATE_ASSOCIATION"));
  assert.ok(kinds.includes("UPDATE_ANCHOR"));
  assert.ok(kinds.includes("UPDATE_CORRIDOR"));
  assert.equal(plan.manualReviewActions.length > 0, true);
  assert.equal(plan.skippedEvidenceDeletions.length, 2);
  assert.equal(plan.appliesWithoutManualAction, false);
});

test("repair plans are deterministic across repeated builds", () => {
  const state = cleanState();
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      anchors: Object.freeze([
        persistedAnchor("cowrie", { name: "Cowrie", corridorCount: 1 }),
        persistedAnchor("moneygram", { name: "MoneyGram", corridorCount: 1 }),
        persistedAnchor("ghost-anchor", { rateSnapshotCount: 1 }),
      ]),
      corridors: Object.freeze(state.corridors),
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
      ]),
    }),
  }));

  assert.deepEqual(buildRegistryRepairPlan(result), buildRegistryRepairPlan(result));
  assert.deepEqual(reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      anchors: Object.freeze([
        persistedAnchor("cowrie", { name: "Cowrie", corridorCount: 1 }),
        persistedAnchor("moneygram", { name: "MoneyGram", corridorCount: 1 }),
        persistedAnchor("ghost-anchor", { rateSnapshotCount: 1 }),
      ]),
      corridors: Object.freeze(state.corridors),
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
      ]),
    }),
  })), result);
});

test("issue ordering is deterministic regardless of input order", () => {
  const forward = reconcileRegistryWithDatabase(input());
  const flipped = reconcileRegistryWithDatabase(input({
    anchors: Object.freeze([COWRIE, MONEYGRAM]),
    corridors: Object.freeze([NGN_CORRIDOR, USD_CORRIDOR]),
    mappings: Object.freeze([
      Object.freeze({ anchorSlug: "cowrie", corridorSlugs: ["ngnt-ng-ngn-ng"] }),
      Object.freeze({ anchorSlug: "moneygram", corridorSlugs: ["usdc-us-usd-us"] }),
    ]),
    persisted: cleanState(),
  }));

  assert.deepEqual(flipped.issues, forward.issues);
});

test("results, issues, summaries, and plans are deeply frozen", () => {
  const result = reconcileRegistryWithDatabase(input({
    persisted: Object.freeze({
      ...cleanState(),
      anchors: Object.freeze([
        persistedAnchor("moneygram", { name: "MoneyGram", corridorCount: 1 }),
        persistedAnchor("ghost-anchor", { rateSnapshotCount: 2 }),
      ]),
    }),
  }));

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issues), true);
  assert.equal(Object.isFrozen(result.summary), true);
  assert.equal(Object.isFrozen(result.historicalEvidence), true);
  assert.equal(Object.isFrozen(result.issues[0]), true);

  const plan = buildRegistryRepairPlan(result);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.safeActions), true);
  assert.equal(Object.isFrozen(plan.safeActions[0]), true);
  assert.throws(() => {
    (result.issues as unknown as unknown[]).push({});
  }, TypeError);
});

test("the human-readable report renders drift, evidence, and plan sections", () => {
  const state = cleanState();
  const report = buildRegistryReconciliationReport(input({
    persisted: Object.freeze({
      anchors: Object.freeze([
        persistedAnchor("moneygram", { name: "MoneyGram", corridorCount: 1 }),
        persistedAnchor("ghost-anchor", { rateSnapshotCount: 4 }),
      ]),
      corridors: Object.freeze(state.corridors),
      associations: Object.freeze([
        Object.freeze({ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }),
        Object.freeze({ anchorSlug: "cowrie", corridorSlug: "ngnt-ng-ngn-ng" }),
      ]),
    }),
  }));

  const text = formatRegistryReconciliationReport(report);

  assert.match(text, /StellarCore registry-to-database reconciliation/);
  assert.match(text, /Drift detected: \d+ issue\(s\)\./);
  assert.match(text, /\[unexpected-anchor\] "ghost-anchor"/);
  assert.match(text, /\[orphaned-rate-snapshot\] "ghost-anchor" holds 4/);
  assert.match(text, /\[stale\] "ghost-anchor" carries 4/);
  assert.match(text, /Proposed repair plan \(not applied\)/);
  assert.match(text, /Refused automatically \(historical evidence would be destroyed\)/);
  assert.match(text, /This plan is NOT applied/);
  assert.match(text, /never delete historical evidence automatically/);
});

test("the human-readable report renders a clean state as no drift", () => {
  const report = buildRegistryReconciliationReport(input());
  const text = formatRegistryReconciliationReport(report);

  assert.match(text, /No drift\. Persisted configuration matches/);
  assert.match(text, /\(none\)/);
  assert.match(text, /\(no actions required\)/);
  assert.equal(text.includes("NOT applied"), false);
});

test("report formatting is deterministic", () => {
  const report = buildRegistryReconciliationReport(input());
  assert.equal(
    formatRegistryReconciliationReport(report),
    formatRegistryReconciliationReport(report),
  );
});
