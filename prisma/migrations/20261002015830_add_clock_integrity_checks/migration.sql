-- CreateEnum
CREATE TYPE "clock_integrity_boundary" AS ENUM ('rate_capture', 'reputation_evaluation');

-- CreateEnum
CREATE TYPE "clock_integrity_outcome" AS ENUM ('passed', 'rejected');

-- CreateTable
CREATE TABLE "clock_integrity_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "boundary" "clock_integrity_boundary" NOT NULL,
    "outcome" "clock_integrity_outcome" NOT NULL,
    "code" TEXT,
    "run_id" TEXT,
    "application_time" TIMESTAMPTZ(6),
    "database_time" TIMESTAMPTZ(6),
    "skew_ms" INTEGER,
    "tolerance_ms" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clock_integrity_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clock_integrity_checks_boundary_observed_at_idx" ON "clock_integrity_checks"("boundary", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "clock_integrity_checks_run_id_idx" ON "clock_integrity_checks"("run_id");

-- Bound the persisted metadata so a pathological clock cannot store unbounded
-- values. Bounds mirror constants/clock.ts (CLOCK_SKEW_METADATA_BOUND_MS =
-- 86400000, CLOCK_INTEGRITY_METADATA_LIMITS).
ALTER TABLE "clock_integrity_checks"
    ADD CONSTRAINT "clock_integrity_checks_code_length_check"
        CHECK ("code" IS NULL OR (char_length("code") BETWEEN 1 AND 64)),
    ADD CONSTRAINT "clock_integrity_checks_run_id_length_check"
        CHECK ("run_id" IS NULL OR (char_length("run_id") BETWEEN 1 AND 100)),
    ADD CONSTRAINT "clock_integrity_checks_skew_bound_check"
        CHECK ("skew_ms" IS NULL OR "skew_ms" BETWEEN -86400000 AND 86400000),
    ADD CONSTRAINT "clock_integrity_checks_tolerance_bound_check"
        CHECK ("tolerance_ms" BETWEEN 0 AND 86400000),
    ADD CONSTRAINT "clock_integrity_checks_outcome_code_check"
        CHECK (
            ("outcome" = 'passed' AND "code" IS NULL)
            OR ("outcome" = 'rejected' AND "code" IS NOT NULL)
        ),
    ADD CONSTRAINT "clock_integrity_checks_times_pair_check"
        CHECK (
            ("application_time" IS NULL AND "database_time" IS NULL)
            OR ("application_time" IS NOT NULL AND "database_time" IS NOT NULL)
        );
