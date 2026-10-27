import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MIGRATION = new URL(
  "../../../prisma/migrations/20260929090000_enforce_evidence_data_invariants/migration.sql",
  import.meta.url,
);
const AUDIT = new URL(
  "../../../prisma/audits/evidence_data_invariants.sql",
  import.meta.url,
);

test("evidence migration stages constraints, audit, and validation in order", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const add = sql.indexOf("NOT VALID");
  const audit = sql.indexOf("DO $$");
  const validate = sql.indexOf("VALIDATE CONSTRAINT");

  assert.ok(add >= 0);
  assert.ok(audit > add);
  assert.ok(validate > audit);
  assert.match(sql, /RAISE EXCEPTION 'Evidence invariant audit failed/);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(sql, /ALTER TABLE "transfer_outcomes"/);
});

test("standalone audit is read-only and reports IDs with categories", async () => {
  const sql = await readFile(AUDIT, "utf8");
  assert.match(sql, /SELECT id, category/);
  assert.match(sql, /ORDER BY category, id/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i);
});

test("migration declares every documented named constraint", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  const names = [
    "rate_snapshots_rate_positive_chk",
    "rate_snapshots_source_amount_positive_chk",
    "rate_snapshots_destination_amount_positive_chk",
    "rate_snapshots_fee_nonnegative_chk",
    "reputation_scores_composite_score_range_chk",
    "reputation_scores_fill_rate_7d_range_chk",
    "reputation_scores_fill_rate_30d_range_chk",
    "reputation_scores_fill_rate_90d_range_chk",
    "reputation_scores_settlement_metrics_nonnegative_chk",
    "reputation_scores_settlement_percentiles_ordered_chk",
    "reputation_scores_slippage_percentiles_ordered_chk",
    "reputation_scores_slippage_metrics_finite_chk",
    "reputation_scores_sample_size_nonnegative_chk",
    "reputation_scores_state_coherence_chk",
    "reputation_scores_score_band_threshold_chk",
  ];

  for (const name of names) {
    assert.equal(sql.match(new RegExp(`"${name}"`, "g"))?.length, 2, name);
  }
});
