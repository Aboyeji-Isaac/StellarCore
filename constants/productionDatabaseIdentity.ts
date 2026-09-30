import type { ProductionDatabaseTargetIdentity } from "@/types/productionDatabaseIdentity";

/**
 * The reviewed, non-secret identity of the StellarCore production database.
 *
 * This registry is the single source of truth that binds privileged production
 * workflows to an intended target. It contains no credentials: only the host,
 * port, and database name a reviewer can read, the SHA-256 fingerprint of the
 * server-reported cluster identity, and the marker constant a provisioned
 * database must carry.
 *
 * Planning a database replacement is a reviewed code change. An operator edits
 * this file in a pull request, the offline `npm run audit:config` validates the
 * new entry, and only then is the GitHub `production` environment's
 * `DATABASE_URL` secret rotated. There is no environment variable that can
 * widen what is approved here; the optional non-secret pins in
 * `lib/config/productionDatabaseIdentity.ts` may only narrow it.
 *
 * See `docs/production-database-identity.md` for the full procedure.
 */
const productionDatabaseIdentities = [
  Object.freeze({
    id: "primary",
    host: "db.stellarcore-production.invalid",
    port: 5432,
    database: "postgres",
    clusterFingerprints: Object.freeze([
      `sha256:${"0".repeat(64)}`,
    ]),
    marker: Object.freeze({
      rowKey: "primary",
      value: "STELLARCORE_PRODUCTION_DATABASE_V1",
    }),
    provisioningAllowed: false,
    reviewedNote:
      "Placeholder pending first-time provisioning. The host uses the reserved " +
      ".invalid TLD so it can never resolve, and the zero fingerprint can never " +
      "be produced by a SHA-256 preimage, so the preflight halts until a " +
      "maintainer replaces both values through review. See " +
      "docs/production-database-identity.md.",
  }),
] as const satisfies readonly ProductionDatabaseTargetIdentity[];

export const PRODUCTION_DATABASE_IDENTITIES = Object.freeze(productionDatabaseIdentities);
