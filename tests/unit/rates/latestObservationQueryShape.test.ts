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
