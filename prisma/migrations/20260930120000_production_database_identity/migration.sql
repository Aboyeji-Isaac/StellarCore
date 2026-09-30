-- Non-secret marker that proves this database is the reviewed StellarCore
-- production target.
--
-- The read-only preflight in `lib/config/productionDatabasePreflight.ts` checks
-- this row, together with the server-reported cluster fingerprint, before the
-- production migration and registry-bootstrap workflows are allowed to mutate
-- anything. The value is a public constant rather than a credential, so it is
-- committed here and in `constants/productionDatabaseIdentity.ts`; the offline
-- `npm run audit:config` validates that both copies agree.
--
-- There is intentionally no production code path that updates or deletes this
-- row. Correcting it is a reviewed, forward-only migration.
CREATE TABLE "production_database_identity" (
    "row_key" TEXT NOT NULL,
    "marker" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "production_database_identity_pkey" PRIMARY KEY ("row_key"),
    CONSTRAINT "production_database_identity_marker_length" CHECK (char_length("marker") BETWEEN 8 AND 200)
);

INSERT INTO "production_database_identity" ("row_key", "marker")
VALUES ('primary', 'STELLARCORE_PRODUCTION_DATABASE_V1');
