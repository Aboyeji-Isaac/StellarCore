-- Manual rollback only. FLOAT8 cannot preserve every DECIMAL(38,18) value;
-- restoring the previous application version may therefore lose precision.
ALTER TABLE "transfer_outcomes"
    DROP CONSTRAINT "transfer_outcomes_fill_rate_domain_check",
    DROP CONSTRAINT "transfer_outcomes_slippage_precision_check";
ALTER TABLE "reputation_scores"
    DROP CONSTRAINT "reputation_scores_fill_rate_domain_check",
    DROP CONSTRAINT "reputation_scores_slippage_precision_check";

ALTER TABLE "transfer_outcomes"
    ALTER COLUMN "fill_rate" TYPE DOUBLE PRECISION USING "fill_rate"::double precision,
    ALTER COLUMN "slippage" TYPE DOUBLE PRECISION USING "slippage"::double precision;
ALTER TABLE "reputation_scores"
    ALTER COLUMN "fill_rate_7d" TYPE DOUBLE PRECISION USING "fill_rate_7d"::double precision,
    ALTER COLUMN "fill_rate_30d" TYPE DOUBLE PRECISION USING "fill_rate_30d"::double precision,
    ALTER COLUMN "fill_rate_90d" TYPE DOUBLE PRECISION USING "fill_rate_90d"::double precision,
    ALTER COLUMN "slippage_p50" TYPE DOUBLE PRECISION USING "slippage_p50"::double precision,
    ALTER COLUMN "slippage_p95" TYPE DOUBLE PRECISION USING "slippage_p95"::double precision;