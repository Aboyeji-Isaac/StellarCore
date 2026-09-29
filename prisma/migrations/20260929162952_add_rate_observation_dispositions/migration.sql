-- CreateEnum
CREATE TYPE "rate_observation_disposition_action" AS ENUM ('QUARANTINE', 'INVALIDATE', 'SUPERSEDE', 'RELEASE');

-- CreateEnum
CREATE TYPE "rate_observation_disposition_reason" AS ENUM ('SUSPECTED_INCORRECT_VALUE', 'SUSPECTED_SOURCE_COMPROMISE', 'SUSPECTED_INVALID_CONFIGURATION', 'SEMANTICALLY_INCORRECT', 'SOURCE_COMPROMISED', 'INVALID_CONFIGURATION', 'NORMALIZATION_DEFECT', 'REVIEW_CLEARED');

-- CreateTable
CREATE TABLE "rate_observation_dispositions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action" "rate_observation_disposition_action" NOT NULL,
    "reason_code" "rate_observation_disposition_reason" NOT NULL,
    "review_reference" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT,
    "superseded_by_snapshot_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_observation_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_observation_dispositions_superseded_by_idx" ON "rate_observation_dispositions"("superseded_by_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "rate_observation_dispositions_snapshot_sequence_key" ON "rate_observation_dispositions"("snapshot_id", "sequence");

-- AddForeignKey
ALTER TABLE "rate_observation_dispositions" ADD CONSTRAINT "rate_observation_dispositions_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "rate_observation_dispositions" ADD CONSTRAINT "rate_observation_dispositions_superseded_by_snapshot_id_fkey" FOREIGN KEY ("superseded_by_snapshot_id") REFERENCES "rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Bounded audit metadata. Free text is length-limited and may not contain
-- control characters; review references are token-like identifiers or URLs.
ALTER TABLE "rate_observation_dispositions"
  ADD CONSTRAINT "rate_observation_dispositions_sequence_check" CHECK ("sequence" >= 1),
  ADD CONSTRAINT "rate_observation_dispositions_review_reference_check"
    CHECK ("review_reference" ~ '^[A-Za-z0-9#._:/?=&%+-]{1,200}$'),
  ADD CONSTRAINT "rate_observation_dispositions_actor_check"
    CHECK ("actor" ~ '^[A-Za-z0-9_.@-]{1,100}$'),
  ADD CONSTRAINT "rate_observation_dispositions_note_check"
    CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" !~ '[[:cntrl:]]')),
  ADD CONSTRAINT "rate_observation_dispositions_supersession_check"
    CHECK (("action" = 'SUPERSEDE') = ("superseded_by_snapshot_id" IS NOT NULL)
      AND ("superseded_by_snapshot_id" IS NULL OR "superseded_by_snapshot_id" <> "snapshot_id")),
  ADD CONSTRAINT "rate_observation_dispositions_reason_check" CHECK (
    ("action" = 'QUARANTINE' AND "reason_code" IN (
      'SUSPECTED_INCORRECT_VALUE', 'SUSPECTED_SOURCE_COMPROMISE', 'SUSPECTED_INVALID_CONFIGURATION'))
    OR ("action" = 'INVALIDATE' AND "reason_code" IN (
      'SEMANTICALLY_INCORRECT', 'SOURCE_COMPROMISED', 'INVALID_CONFIGURATION', 'NORMALIZATION_DEFECT'))
    OR ("action" = 'SUPERSEDE' AND "reason_code" IN (
      'SEMANTICALLY_INCORRECT', 'INVALID_CONFIGURATION', 'NORMALIZATION_DEFECT'))
    OR ("action" = 'RELEASE' AND "reason_code" = 'REVIEW_CLEARED'));

-- Disposition events are append-only: no UPDATE, DELETE, or TRUNCATE.
CREATE FUNCTION "rate_observation_dispositions_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'rate observation dispositions are append-only'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "rate_observation_dispositions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "rate_observation_dispositions"
  FOR EACH ROW EXECUTE FUNCTION "rate_observation_dispositions_append_only"();

CREATE TRIGGER "rate_observation_dispositions_no_truncate"
  BEFORE TRUNCATE ON "rate_observation_dispositions"
  FOR EACH STATEMENT EXECUTE FUNCTION "rate_observation_dispositions_append_only"();

-- Defense in depth for the reviewed state machine (lib/rates/disposition.ts):
--   active      -> QUARANTINE | INVALIDATE | SUPERSEDE
--   quarantined -> RELEASE | INVALIDATE | SUPERSEDE
--   invalidated, superseded -> terminal
-- Events are numbered 1, 2, ... per snapshot. A replacement must be a
-- different, currently active snapshot for the same anchor and corridor,
-- captured strictly later, which also makes supersession cycles impossible.
CREATE FUNCTION "rate_observation_dispositions_validate"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_action "rate_observation_disposition_action";
  previous_sequence integer;
  target record;
  replacement record;
  replacement_action "rate_observation_disposition_action";
BEGIN
  SELECT "action", "sequence" INTO previous_action, previous_sequence
    FROM "rate_observation_dispositions"
   WHERE "snapshot_id" = NEW."snapshot_id"
   ORDER BY "sequence" DESC LIMIT 1;

  IF NEW."sequence" <> COALESCE(previous_sequence, 0) + 1 THEN
    RAISE EXCEPTION 'disposition sequence must be contiguous' USING ERRCODE = 'check_violation';
  END IF;

  IF previous_action IN ('INVALIDATE', 'SUPERSEDE') THEN
    RAISE EXCEPTION 'disposition is terminal' USING ERRCODE = 'check_violation';
  END IF;
  IF previous_action = 'QUARANTINE' AND NEW."action" = 'QUARANTINE' THEN
    RAISE EXCEPTION 'snapshot is already quarantined' USING ERRCODE = 'check_violation';
  END IF;
  IF (previous_action IS NULL OR previous_action = 'RELEASE') AND NEW."action" = 'RELEASE' THEN
    RAISE EXCEPTION 'only a quarantined snapshot can be released' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."action" = 'SUPERSEDE' THEN
    SELECT "anchor_id", "corridor_id", "captured_at" INTO target
      FROM "rate_snapshots" WHERE "id" = NEW."snapshot_id";
    SELECT "anchor_id", "corridor_id", "captured_at" INTO replacement
      FROM "rate_snapshots" WHERE "id" = NEW."superseded_by_snapshot_id";
    IF replacement."anchor_id" IS DISTINCT FROM target."anchor_id"
      OR replacement."corridor_id" IS DISTINCT FROM target."corridor_id" THEN
      RAISE EXCEPTION 'replacement must share anchor and corridor' USING ERRCODE = 'check_violation';
    END IF;
    IF replacement."captured_at" <= target."captured_at" THEN
      RAISE EXCEPTION 'replacement must be captured later' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "action" INTO replacement_action
      FROM "rate_observation_dispositions"
     WHERE "snapshot_id" = NEW."superseded_by_snapshot_id"
     ORDER BY "sequence" DESC LIMIT 1;
    IF replacement_action IS NOT NULL AND replacement_action <> 'RELEASE' THEN
      RAISE EXCEPTION 'replacement must be an active observation' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "rate_observation_dispositions_validate_insert"
  BEFORE INSERT ON "rate_observation_dispositions"
  FOR EACH ROW EXECUTE FUNCTION "rate_observation_dispositions_validate"();

-- Existing snapshots receive no rows: absence of a disposition means "never
-- reviewed", not "reviewed and accepted". No existing row is modified.
