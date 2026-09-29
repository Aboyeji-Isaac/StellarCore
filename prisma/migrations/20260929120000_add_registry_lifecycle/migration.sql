-- Existing rows represent the reviewed registry at migration time. Lifecycle
-- reconciliation runs only after the complete source registry validates.
ALTER TABLE "anchors"
  ADD COLUMN "registry_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "registry_activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "registry_retired_at" TIMESTAMPTZ(6),
  ADD COLUMN "registry_retirement_reason" TEXT;

ALTER TABLE "corridors"
  ADD COLUMN "registry_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "registry_activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "registry_retired_at" TIMESTAMPTZ(6),
  ADD COLUMN "registry_retirement_reason" TEXT;

ALTER TABLE "anchor_corridors"
  ADD COLUMN "registry_active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "registry_activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "registry_retired_at" TIMESTAMPTZ(6),
  ADD COLUMN "registry_retirement_reason" TEXT;

ALTER TABLE "anchors" ADD CONSTRAINT "anchors_registry_lifecycle_coherent"
  CHECK ((registry_active AND registry_retired_at IS NULL AND registry_retirement_reason IS NULL)
    OR (NOT registry_active AND registry_retired_at IS NOT NULL AND registry_retirement_reason IS NOT NULL));
ALTER TABLE "corridors" ADD CONSTRAINT "corridors_registry_lifecycle_coherent"
  CHECK ((registry_active AND registry_retired_at IS NULL AND registry_retirement_reason IS NULL)
    OR (NOT registry_active AND registry_retired_at IS NOT NULL AND registry_retirement_reason IS NOT NULL));
ALTER TABLE "anchor_corridors" ADD CONSTRAINT "anchor_corridors_registry_lifecycle_coherent"
  CHECK ((registry_active AND registry_retired_at IS NULL AND registry_retirement_reason IS NULL)
    OR (NOT registry_active AND registry_retired_at IS NOT NULL AND registry_retirement_reason IS NOT NULL));

CREATE INDEX "anchors_registry_active_idx" ON "anchors"("registry_active");
CREATE INDEX "corridors_registry_active_idx" ON "corridors"("registry_active");
CREATE INDEX "anchor_corridors_registry_active_idx" ON "anchor_corridors"("registry_active");
