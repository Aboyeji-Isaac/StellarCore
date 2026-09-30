-- Issue #143: durable database-environment identity.
--
-- Exactly one row (enforced by the single-row CHECK constraint) records the
-- environment this database belongs to. It is written once by the environment
-- provisioning step that created the database (or by the documented marking
-- script) and is read at runtime before any evidence mutation. It is
-- deployment metadata about the database itself, not evidence about anchors,
-- and it intentionally contains no credentials.
--
-- The nullable-marked-unknown representation is deliberate: an unmarked
-- database (no row) and a row whose environment is NULL both mean "identity
-- unknown". Guardrails fail closed for incompatible pairings while allowing
-- explicitly non-production runtimes to operate on databases explicitly
-- marked for their environment. Migrations run only against databases the
-- operator has explicitly marked (migration tooling has its own boundary —
-- see docs/DEPLOYMENT.md).

CREATE TABLE "environment_identity" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT,
    "marked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "note" TEXT,
    CONSTRAINT "environment_identity_pkey" PRIMARY KEY ("id")
);

-- At most one identity row can ever exist.
ALTER TABLE "environment_identity"
  ADD CONSTRAINT "environment_identity_single_row" CHECK ("id" = 1);

-- Restrict the stored identity to the defined runtime environments; NULL is
-- allowed and means the database's identity has not been established.
ALTER TABLE "environment_identity"
  ADD CONSTRAINT "environment_identity_environment_allowed"
  CHECK ("environment" IS NULL OR "environment" IN
    ('production', 'preview', 'development', 'test', 'ci'));
