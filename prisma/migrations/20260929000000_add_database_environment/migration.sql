-- Environment isolation (#143): every database carries a durable, explicit
-- environment identity that runtimes verify before touching evidence data.
-- The stamp lives in its own table so it can never be confused with anchor
-- evidence, and it is owned by migration tooling: production stamping happens
-- only through the protected migration workflow, never from application code.
CREATE TABLE "database_environment" (
  -- Singleton row: exactly one identity per database.
  id INTEGER NOT NULL,
  -- Explicit identity, not inferred from hostname or DATABASE_URL contents.
  environment TEXT NOT NULL,
  -- Immutable stamp time, informational only.
  stamped_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "database_environment_pkey" PRIMARY KEY ("id")
);

-- Restrict to exactly one row, forever.
ALTER TABLE "database_environment" ADD CONSTRAINT "database_environment_singleton" CHECK ("id" = 1);

-- Environment identity is deployment metadata: bounded, lowercase, secret-free.
ALTER TABLE "database_environment" ADD CONSTRAINT "database_environment_environment_allowed" CHECK (
  "environment" IN ('production', 'preview', 'development', 'test', 'ci')
);

-- The stamp is deployment metadata owned by operators/migration tooling.
-- Application runtimes hold read privilege only; they verify the identity and
-- fail closed on mismatch, but can never rewrite the stamp to make themselves
-- match (which would defeat the guard).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "database_environment" FROM PUBLIC;
