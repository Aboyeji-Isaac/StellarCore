import assert from "node:assert/strict";
import test from "node:test";

import {
  ANOMALY_CONTEMPORANEITY_WINDOW_MS,
  ANOMALY_TOLERANCE_BPS,
  MIN_ANOMALY_PEERS,
  MIN_FRESH_SOURCES,
} from "@/constants/rates";
import { assessRateAnomalies, withinTolerance } from "@/lib/rates/anomaly";
import {
  assessCorridorAnomalies,
  type RateAnomalyAssessmentRepository,
} from "@/lib/rates/anomalyAssessment";
import { parseDatabaseDecimal } from "@/lib/rates/decimal";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
  PersistedRateAnomalyVerdict,
} from "@/types/latestRates";
import type { RateAnomalyAssessment, RateAnomalyObservation } from "@/types/rates";

const CORRIDOR = "usdc-us-brl-br";
const NOW = new Date("2026-09-30T00:00:10.000Z");
const CORRIDOR_RECORD = Object.freeze({
  id: "corridor-id",
  slug: CORRIDOR,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

test("criterion constants keep the documented invariants", () => {
  assert.equal(MIN_ANOMALY_PEERS, 2);
  assert.equal(ANOMALY_TOLERANCE_BPS, 2_000);
  assert.ok(MIN_ANOMALY_PEERS >= MIN_FRESH_SOURCES);
});

test("tolerance boundary is exact, symmetric, and inclusive", () => {
  const d = parseDatabaseDecimal;
  assert.equal(withinTolerance(d("1.2"), d("1")), true);
  assert.equal(withinTolerance(d("1"), d("1.2")), true);
  assert.equal(withinTolerance(d("1.200000000000000001"), d("1")), false);
  assert.equal(withinTolerance(d("0.833333333333333334"), d("1")), true);
  assert.equal(withinTolerance(d("0.8"), d("1")), false);
});

test("extreme outlier among agreeing independent peers is quarantined with a reconstructable reason", () => {
  const verdicts = byId(assessRateAnomalies([
    obs("a", "a", "5.40"),
    obs("b", "b", "5.42"),
    obs("c", "c", "5.38"),
    obs("x", "outlier", "540"),
  ]));

  assert.equal(verdicts.x.status, "quarantined");
  assert.equal(verdicts.x.reason, "deviates_from_peer_consensus");
  assert.equal(verdicts.x.baselineRate, "5.4");
  assert.deepEqual(verdicts.x.peerObservationIds, ["a", "b", "c"]);
  assert.equal(verdicts.x.independentPeerCount, 3);
  assert.equal(verdicts.x.agreeingPeerCount, 3);
  for (const id of ["a", "b", "c"]) assert.equal(verdicts[id]!.status, "consistent");
});

test("the evaluated observation never contributes to its own baseline", () => {
  const verdicts = assessRateAnomalies([
    obs("a", "a", "1"),
    obs("b", "b", "1"),
    obs("x", "x", "100"),
  ]);
  for (const verdict of verdicts) {
    assert.equal(verdict.peerObservationIds.includes(verdict.observationId), false);
  }
});

test("insufficient independent peers never fabricate a verdict", () => {
  const single = assessRateAnomalies([obs("x", "x", "999")]);
  assert.equal(single[0]!.status, "insufficient_peers");
  assert.equal(single[0]!.reason, "fewer_than_minimum_independent_peers");
  assert.equal(single[0]!.baselineRate, null);

  const pair = assessRateAnomalies([obs("a", "a", "1"), obs("x", "x", "999")]);
  assert.deepEqual(pair.map(({ status }) => status), ["insufficient_peers", "insufficient_peers"]);

  const nonContemporaneous = assessRateAnomalies([
    obs("a", "a", "1", -ANOMALY_CONTEMPORANEITY_WINDOW_MS - 1),
    obs("b", "b", "1", -ANOMALY_CONTEMPORANEITY_WINDOW_MS - 1),
    obs("x", "x", "999"),
  ]);
  assert.equal(nonContemporaneous[2]!.status, "insufficient_peers");
});

test("correlated observations sharing an independence key cannot manufacture a baseline", () => {
  const verdicts = byId(assessRateAnomalies([
    obs("honest", "honest", "1"),
    obs("c1", "colluder", "50", -3_000),
    obs("c2", "colluder", "50", -2_000),
    obs("c3", "colluder", "50", -1_000),
  ]));
  assert.equal(verdicts.honest.status, "insufficient_peers");
  assert.equal(verdicts.honest.independentPeerCount, 1);
  assert.deepEqual(verdicts.honest.peerObservationIds, ["c3"]);
});

test("a colluding minority cannot quarantine an honest majority", () => {
  const verdicts = byId(assessRateAnomalies([
    obs("a", "a", "1"),
    obs("b", "b", "1"),
    obs("c", "c", "1"),
    obs("m1", "m1", "5"),
    obs("m2", "m2", "5"),
  ]));
  assert.equal(verdicts.m1.status, "quarantined");
  assert.equal(verdicts.m2.status, "quarantined");
  for (const id of ["a", "b", "c"]) assert.notEqual(verdicts[id]!.status, "quarantined");
  assert.equal(verdicts.a.reason, "no_peer_consensus");
});

test("normal market movement that independent sources agree on is never quarantined", () => {
  const verdicts = assessRateAnomalies([
    obs("a", "a", "7.95"),
    obs("b", "b", "8.00"),
    obs("c", "c", "8.10"),
  ]);
  assert.deepEqual(verdicts.map(({ status }) => status), ["consistent", "consistent", "consistent"]);
});

test("verdicts are independent of input order", () => {
  const input = [obs("a", "a", "1"), obs("b", "b", "1.01"), obs("x", "x", "9"), obs("c", "c", "0.99")];
  const forward = byId(assessRateAnomalies(input));
  const reversed = byId(assessRateAnomalies([...input].reverse()));
  assert.deepEqual(forward, reversed);
});

test("invalid rates and timestamps are unassessable, not anomalous, and never peers", () => {
  const verdicts = byId(assessRateAnomalies([
    obs("zero", "zero", "0"),
    { id: "bad-time", independenceKey: "t", rate: "1", capturedAt: "invalid" },
    obs("a", "a", "1"),
  ]));
  assert.equal(verdicts.zero.status, "unassessable");
  assert.equal(verdicts["bad-time"]!.status, "unassessable");
  assert.equal(verdicts.a.independentPeerCount, 0);
});

test("read model: quarantined outlier stays as evidence but cannot affect the median", async () => {
  const result = await read([
    row("a", "a", "5.40"),
    row("b", "b", "5.42"),
    row("c", "c", "5.38"),
    row("outlier", "x", "540"),
  ]);
  assert.ok(result.ok);
  assert.equal(result.median, "5.4");
  assert.equal(result.freshSourceCount, 3);
  assert.equal(result.totalIndependentSources, 4);
  const outlier = result.observations.find(({ snapshotId }) => snapshotId === "x");
  assert.equal(outlier?.rate, "540");
  assert.equal(outlier?.anchorSlug, "outlier");
  assert.equal(outlier?.included, false);
  assert.equal(outlier?.exclusionReason, "quarantined");
  assert.deepEqual(outlier?.anomaly, {
    status: "quarantined",
    reason: "deviates_from_peer_consensus",
    origin: "evaluated",
  });
});

test("read model: a quarantined observation cannot satisfy the publishable threshold", async () => {
  const result = await read([
    row("a", "a", "1"),
    row("q", "q", "1", { status: "quarantined", reason: "deviates_from_peer_consensus" }),
  ]);
  assert.ok(result.ok);
  assert.equal(result.state, "insufficient_fresh_sources");
  assert.equal(result.median, null);
  assert.equal(result.freshSourceCount, 1);
  assert.equal(result.observations.find(({ snapshotId }) => snapshotId === "q")?.anomaly.origin, "persisted");
});

test("read model: a single source keeps normal publishability rules", async () => {
  const result = await read([row("only", "only", "999")]);
  assert.ok(result.ok);
  assert.equal(result.observations[0]?.included, true);
  assert.equal(result.observations[0]?.anomaly.status, "insufficient_peers");
  assert.equal(result.state, "insufficient_fresh_sources");
  assert.equal(result.median, null);
});

test("read model: agreeing market movement remains publishable", async () => {
  const result = await read([row("a", "a", "8"), row("b", "b", "8.1"), row("c", "c", "7.9")]);
  assert.ok(result.ok);
  assert.equal(result.state, "healthy");
  assert.equal(result.median, "8");
});

test("source authority: the anomaly layer only removes eligibility and never adds a source", async () => {
  const history = [
    row("a", "a1", "1", undefined, -5_000),
    row("a", "a2", "1", undefined, -1_000),
    row("b", "b", "1"),
    row("c", "c", "90"),
    row("d", "d", "1.01", { status: "consistent", reason: null }),
  ];
  const result = await read(history);
  assert.ok(result.ok);
  assert.equal(result.totalIndependentSources, 4);
  assert.deepEqual(result.observations.map(({ snapshotId }) => snapshotId), ["a2", "b", "c", "d"]);
  assert.ok(result.freshSourceCount <= result.totalIndependentSources);
  assert.equal(result.observations.find(({ snapshotId }) => snapshotId === "c")?.included, false);
});

test("supersession: a newer same-anchor snapshot replaces a quarantined one without erasing it", async () => {
  const repo = memory([
    row("a", "a", "1"),
    row("b", "b", "1"),
    row("x", "x-old", "100", undefined, -2_000),
  ]);
  const first = await assessCorridorAnomalies([CORRIDOR], deps(repo));
  assert.deepEqual(first.quarantined.map(({ snapshotId }) => snapshotId), ["x-old"]);

  repo.rows.push(row("x", "x-new", "1.01", undefined, -1_000));
  const second = await assessCorridorAnomalies([CORRIDOR], deps(repo));
  assert.deepEqual(second.quarantined, []);
  assert.ok(repo.appended.some((entry) => entry.observationId === "x-old" && entry.status === "quarantined"));
  assert.equal(repo.rows.find(({ id }) => id === "x-old")?.rate, "100");
  const result = await readLatestCorridorRate(CORRIDOR, { evaluatedAt: NOW, repository: repo.latest });
  assert.ok(result.ok);
  assert.equal(result.median, "1");
  assert.equal(result.freshSourceCount, 3);
});

test("recovery: later contemporaneous evidence appends a new verdict and preserves the quarantine", async () => {
  const repo = memory([
    row("a", "a", "1"),
    row("b", "b", "1.01"),
    row("x", "x", "1.5"),
  ]);
  const first = await assessCorridorAnomalies([CORRIDOR], deps(repo));
  assert.equal(first.quarantined[0]?.snapshotId, "x");
  assert.equal(first.quarantined[0]?.reason, "deviates_from_peer_consensus");
  assert.equal(first.assessmentsAppended, 3);

  const unchanged = await assessCorridorAnomalies([CORRIDOR], deps(repo));
  assert.equal(unchanged.assessmentsAppended, 0);

  // Newer independent evidence shows the market has moved to 1.5.
  repo.rows.push(row("a", "a2", "1.5", undefined, 500), row("b", "b2", "1.49", undefined, 500));
  repo.rows.push(row("c", "c", "1.51", undefined, 500));
  const recovered = await assessCorridorAnomalies([CORRIDOR], deps(repo));
  assert.deepEqual(recovered.quarantined, []);

  const history = repo.appended.filter(({ observationId }) => observationId === "x");
  assert.deepEqual(history.map(({ status }) => status), ["quarantined", "consistent"]);
  assert.equal(repo.rows.find(({ id }) => id === "x")?.rate, "1.5");

  const replay = await assessCorridorAnomalies([CORRIDOR], deps(repo));
  assert.equal(replay.assessmentsAppended, 0);
});

test("assessment failures are isolated per corridor and reported safely", async () => {
  const repo = memory([row("a", "a", "1")]);
  const failing: RateAnomalyAssessmentRepository = {
    appendAssessments: async () => {
      throw new Error("DATABASE_URL=postgres://secret");
    },
  };
  const summary = await assessCorridorAnomalies([CORRIDOR, "missing"], {
    latest: repo.latest,
    assessments: failing,
    now: () => NOW,
  });
  assert.deepEqual(summary.failures.map(({ corridorSlug }) => corridorSlug), ["missing", CORRIDOR]);
  assert.equal(JSON.stringify(summary).includes("secret"), false);
});

function obs(id: string, key: string, rate: string, offsetMs = 0): RateAnomalyObservation {
  return { id, independenceKey: key, rate, capturedAt: new Date(NOW.getTime() - 10_000 + offsetMs) };
}

function byId(verdicts: readonly RateAnomalyAssessment[]): Record<string, RateAnomalyAssessment> {
  return Object.fromEntries(verdicts.map((verdict) => [verdict.observationId, verdict]));
}

function row(
  anchorSlug: string,
  id: string,
  rate: string,
  anomaly?: PersistedRateAnomalyVerdict,
  offsetMs = 0,
): LatestRateRepositoryObservation {
  return {
    id,
    anchorSlug,
    anchorName: anchorSlug,
    rate,
    sourceAmount: "100",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(NOW.getTime() - 10_000 + offsetMs),
    anomaly: anomaly ?? null,
  };
}

function read(rows: LatestRateRepositoryObservation[]) {
  return readLatestCorridorRate(CORRIDOR, { evaluatedAt: NOW, repository: memory(rows).latest });
}

type AppendedRow = RateAnomalyAssessment & { assessedAt: Date };

function memory(rows: LatestRateRepositoryObservation[]) {
  const appended: AppendedRow[] = [];
  const state = { rows, appended };
  const latestVerdict = (id: string): PersistedRateAnomalyVerdict | null => {
    const entries = appended.filter(({ observationId }) => observationId === id);
    const last = entries.at(-1);
    return last ? { status: last.status, reason: last.reason } : null;
  };
  const latest: LatestRateRepository = {
    findCorridorBySlug: async (slug) => (slug === CORRIDOR ? CORRIDOR_RECORD : null),
    findLatestObservations: async () => state.rows.map((entry) => ({
      ...entry,
      anomaly: entry.anomaly ?? latestVerdict(entry.id),
    })),
  };
  const assessments: RateAnomalyAssessmentRepository = {
    appendAssessments: async (entries) => {
      appended.push(...entries.map((entry) => ({ ...entry })));
    },
  };
  return { ...state, latest, assessments };
}

function deps(repo: ReturnType<typeof memory>) {
  return { latest: repo.latest, assessments: repo.assessments, now: () => NOW };
}
