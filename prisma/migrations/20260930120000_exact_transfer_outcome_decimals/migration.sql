-- Use PostgreSQL's shortest round-trip FLOAT8 text to avoid its lower-precision
-- direct float-to-NUMERIC cast, then round half away from zero to target scale.
-- Out-of-domain and non-finite rows abort.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "transfer_outcomes"
        WHERE "fill_rate"::text IN ('NaN', 'Infinity', '-Infinity')
           OR "fill_rate" < 0 OR "fill_rate" > 1
    ) THEN
        RAISE EXCEPTION 'transfer_outcomes.fill_rate contains a value outside [0,1]';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "transfer_outcomes"
          WHERE "slippage"::text IN ('NaN', 'Infinity', '-Infinity')
              OR abs("slippage"::text::numeric) > 99999999999999999999.999999999999999999
    ) THEN
        RAISE EXCEPTION 'transfer_outcomes.slippage cannot be represented as NUMERIC(38,18)';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "reputation_scores"
        WHERE "fill_rate_7d"::text IN ('NaN', 'Infinity', '-Infinity')
           OR "fill_rate_30d"::text IN ('NaN', 'Infinity', '-Infinity')
           OR "fill_rate_90d"::text IN ('NaN', 'Infinity', '-Infinity')
           OR "fill_rate_7d" < 0 OR "fill_rate_7d" > 1
           OR "fill_rate_30d" < 0 OR "fill_rate_30d" > 1
           OR "fill_rate_90d" < 0 OR "fill_rate_90d" > 1
    ) THEN
        RAISE EXCEPTION 'reputation_scores fill-rate metric contains a value outside [0,1]';
    END IF;

    IF EXISTS (
        SELECT 1 FROM "reputation_scores"
        WHERE "slippage_p50"::text IN ('NaN', 'Infinity', '-Infinity')
           OR "slippage_p95"::text IN ('NaN', 'Infinity', '-Infinity')
           OR abs("slippage_p50"::text::numeric) > 99999999999999999999.999999999999999999
           OR abs("slippage_p95"::text::numeric) > 99999999999999999999.999999999999999999
    ) THEN
        RAISE EXCEPTION 'reputation_scores slippage metric cannot be represented as NUMERIC(38,18)';
    END IF;
END $$;

ALTER TABLE "transfer_outcomes"
    ALTER COLUMN "fill_rate" TYPE DECIMAL(19,18)
        USING round("fill_rate"::text::numeric, 18)::DECIMAL(19,18),
    ALTER COLUMN "slippage" TYPE DECIMAL(38,18)
        USING round("slippage"::text::numeric, 18)::DECIMAL(38,18);

ALTER TABLE "reputation_scores"
    ALTER COLUMN "fill_rate_7d" TYPE DECIMAL(5,4)
        USING round("fill_rate_7d"::text::numeric, 4)::DECIMAL(5,4),
    ALTER COLUMN "fill_rate_30d" TYPE DECIMAL(5,4)
        USING round("fill_rate_30d"::text::numeric, 4)::DECIMAL(5,4),
    ALTER COLUMN "fill_rate_90d" TYPE DECIMAL(5,4)
        USING round("fill_rate_90d"::text::numeric, 4)::DECIMAL(5,4),
    ALTER COLUMN "slippage_p50" TYPE DECIMAL(38,18)
        USING round("slippage_p50"::text::numeric, 18)::DECIMAL(38,18),
    ALTER COLUMN "slippage_p95" TYPE DECIMAL(38,18)
        USING round("slippage_p95"::text::numeric, 18)::DECIMAL(38,18);

ALTER TABLE "transfer_outcomes"
    ADD CONSTRAINT "transfer_outcomes_fill_rate_domain_check"
        CHECK ("fill_rate" >= 0 AND "fill_rate" <= 1),
    ADD CONSTRAINT "transfer_outcomes_slippage_precision_check"
        CHECK ("slippage" BETWEEN -99999999999999999999.999999999999999999
          AND 99999999999999999999.999999999999999999);

ALTER TABLE "reputation_scores"
    ADD CONSTRAINT "reputation_scores_fill_rate_domain_check"
        CHECK (("fill_rate_7d" IS NULL OR "fill_rate_7d" BETWEEN 0 AND 1)
          AND ("fill_rate_30d" IS NULL OR "fill_rate_30d" BETWEEN 0 AND 1)
          AND ("fill_rate_90d" IS NULL OR "fill_rate_90d" BETWEEN 0 AND 1)),
    ADD CONSTRAINT "reputation_scores_slippage_precision_check"
        CHECK (("slippage_p50" IS NULL OR "slippage_p50" BETWEEN -99999999999999999999.999999999999999999
          AND 99999999999999999999.999999999999999999)
          AND ("slippage_p95" IS NULL OR "slippage_p95" BETWEEN -99999999999999999999.999999999999999999
          AND 99999999999999999999.999999999999999999));