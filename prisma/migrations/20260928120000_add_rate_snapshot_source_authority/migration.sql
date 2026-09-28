-- Persist the reviewed source-authority identity (issue #122) with every
-- observation. Both columns are nullable because legacy rows are migrated as
-- "authority unknown": the reviewed mapping is durable reviewed evidence that
-- applies to observations captured after review, so history is never
-- backfilled from current configuration and is never counted as independent
-- from a reviewed authority.
ALTER TABLE "rate_snapshots" ADD COLUMN "authority_id" TEXT;
ALTER TABLE "rate_snapshots" ADD COLUMN "authority_configuration_version" INTEGER;

-- Known authority and reviewed configuration version are all-or-nothing, and
-- the identifier keeps the same opaque reviewed shape enforced by the offline
-- configuration audit. The pattern is intentionally not derived from anchor
-- slugs, home domains, or endpoint hostnames.
ALTER TABLE "rate_snapshots"
  ADD CONSTRAINT "rate_snapshots_authority_provenance_check"
  CHECK (
    ("authority_id" IS NULL AND "authority_configuration_version" IS NULL)
    OR (
      "authority_id" ~ '^auth-[0-9]{4}$'
      AND "authority_configuration_version" IS NOT NULL
      AND "authority_configuration_version" > 0
    )
  );

-- Recreate the covering index for findLatestObservations so the newly selected
-- authority provenance stays part of the ordered index-only scan instead of
-- forcing a heap visit per latest observation.
DROP INDEX "rate_snapshots_latest_observation_idx";
CREATE INDEX "rate_snapshots_latest_observation_idx" ON "rate_snapshots"("corridor_id", "anchor_id", "captured_at" DESC, "id" DESC, "rate", "source_amount", "destination_amount", "fee", "authority_id", "authority_configuration_version");
