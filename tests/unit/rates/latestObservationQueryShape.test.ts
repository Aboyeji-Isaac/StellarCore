import assert from "node:assert/strict";
import test from "node:test";

import { latestObservationsQuery } from "@/lib/rates/latestRateRepository";
import { latestCorridorRatesQuery } from "@/lib/reputation/repository";

const ID = "11111111-1111-4111-8111-111111111111";

// These pin the shape that makes the newest-row read independent of history
// depth. They cannot prove the planner honours it (the database test and the
// benchmark do), but they stop a well-meant rewrite from quietly reintroducing
// a scan of every historical row.

const queries = [
  ["latestObservationsQuery", latestObservationsQuery(ID), "anchors"],
  ["latestCorridorRatesQuery", latestCorridorRatesQuery(ID), "corridors"],
] as const;

for (const [name, query, groupTable] of queries) {
  test(`${name} takes the newest row per group with a bounded lateral lookup`, () => {
    const sql = query.text;
    assert.match(sql, /CROSS JOIN LATERAL/i);
    assert.match(sql, /ORDER BY snapshot\.captured_at DESC, snapshot\.id DESC\s+LIMIT 1/i);
    assert.doesNotMatch(sql, /DISTINCT ON/i);
  });

  test(`${name} enumerates groups from ${groupTable}, not from snapshot history`, () => {
    const outer = query.text.split(/CROSS JOIN LATERAL/i)[0]!;
    assert.match(outer, new RegExp(`FROM ${groupTable} AS`, "i"));
    assert.doesNotMatch(outer, /rate_snapshots/i);
  });

  test(`${name} binds its id as the only parameter and never restricts by freshness`, () => {
    assert.deepEqual(query.values, [ID]);
    assert.doesNotMatch(query.text, /captured_at\s*[<>]/i);
    assert.doesNotMatch(query.text, /now\(\)|interval/i);
  });
}

// The anomaly-assessment variant (#186) must not change the latest-per-anchor
// selection: the same bounded lateral lookup decides the row, and the newest
// verdict arrives through one extra bounded probe per selected snapshot, never
// a scan of assessment or snapshot history.
const anomalyQuery = latestObservationsQuery(ID, { withAnomalyAssessment: true });

test("latestObservationsQuery anomaly variant keeps the bounded latest-per-anchor selection", () => {
  assert.match(anomalyQuery.text, /CROSS JOIN LATERAL/i);
  assert.match(anomalyQuery.text, /ORDER BY snapshot\.captured_at DESC, snapshot\.id DESC\s+LIMIT 1/i);
  assert.doesNotMatch(anomalyQuery.text, /DISTINCT ON/i);
});

test("latestObservationsQuery anomaly variant probes assessments per selected row only", () => {
  const outer = anomalyQuery.text.split(/CROSS JOIN LATERAL/i)[0]!;
  assert.match(outer, /FROM anchors AS/i);
  assert.doesNotMatch(outer, /rate_snapshots/i);
  assert.match(anomalyQuery.text, /FROM rate_anomaly_assessments AS candidate/i);
  assert.match(anomalyQuery.text, /WHERE candidate\.snapshot_id = latest\.id/i);
  assert.match(anomalyQuery.text, /LIMIT 1/i);
  assert.doesNotMatch(anomalyQuery.text, /rate_anomaly_assessments[\s\S]*rate_anomaly_assessments/i);
});

test("latestObservationsQuery anomaly variant binds its id as the only parameter", () => {
  assert.deepEqual(anomalyQuery.values, [ID]);
});
