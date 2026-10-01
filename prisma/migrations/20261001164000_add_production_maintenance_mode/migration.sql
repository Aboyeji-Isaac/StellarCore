CREATE TABLE "maintenance_state" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "reason" TEXT NOT NULL,
  "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_by" TEXT NOT NULL,
  "deactivated_at" TIMESTAMPTZ(6),
  "deactivated_by" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_state_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "maintenance_state_active_idx"
  ON "maintenance_state" ("active");

CREATE UNIQUE INDEX "maintenance_state_single_active_idx"
  ON "maintenance_state" ((active))
  WHERE active = true;

CREATE OR REPLACE FUNCTION stellarcore_block_mutation_during_maintenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "maintenance_state" WHERE "active" = true
  ) THEN
    RAISE EXCEPTION 'STELLARCORE_MAINTENANCE_ACTIVE'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "maintenance_guard_anchors"
BEFORE INSERT OR UPDATE OR DELETE ON "anchors"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();

CREATE TRIGGER "maintenance_guard_corridors"
BEFORE INSERT OR UPDATE OR DELETE ON "corridors"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();

CREATE TRIGGER "maintenance_guard_anchor_corridors"
BEFORE INSERT OR UPDATE OR DELETE ON "anchor_corridors"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();

CREATE TRIGGER "maintenance_guard_rate_snapshots"
BEFORE INSERT OR UPDATE OR DELETE ON "rate_snapshots"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();

CREATE TRIGGER "maintenance_guard_transfer_outcomes"
BEFORE INSERT OR UPDATE OR DELETE ON "transfer_outcomes"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();

CREATE TRIGGER "maintenance_guard_reputation_scores"
BEFORE INSERT OR UPDATE OR DELETE ON "reputation_scores"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();

CREATE TRIGGER "maintenance_guard_scheduled_source_suppressions"
BEFORE INSERT OR UPDATE OR DELETE ON "scheduled_source_suppressions"
FOR EACH STATEMENT EXECUTE FUNCTION stellarcore_block_mutation_during_maintenance();
