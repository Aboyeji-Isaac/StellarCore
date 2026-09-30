/**
 * Shared, transport-level types for the production database target identity
 * guard (see `lib/config/productionDatabaseIdentity.ts`).
 *
 * Every type in this file is deliberately credential-free: a resolved
 * connection target, a server observation, and a reviewed expectation never
 * carry a password, a full connection string, or any other secret. Keeping the
 * vocabulary in one place makes that property auditable.
 */

/** The physical table that stores the non-secret production marker row. */
export type ProductionDatabaseIdentityMarker = Readonly<{
  /** Primary key of the singleton marker row (for example `primary`). */
  rowKey: string;
  /** Non-secret marker value the reviewed registry pins for this target. */
  value: string;
}>;

/**
 * Where a credential claims it will connect, derived only from the parsed
 * connection URL. The password is discarded during parsing and can never be
 * represented here.
 */
export type ResolvedDatabaseTarget = Readonly<{
  /** URL host, lowercased, without brackets or a trailing dot. */
  host: string;
  /** URL port, defaulted to 5432 when the URL omits it. */
  port: number;
  /** URL database name, percent-decoded and lowercased. */
  database: string;
}>;

/**
 * What the server reports about itself after the preflight connects. This is
 * observed through read-only session functions, so it is independent of the
 * mutable URL text and of any DNS name the operator happened to type.
 */
export type ProductionDatabaseServerObservation = Readonly<{
  /** `current_database()`. */
  databaseName: string;
  /** `inet_server_addr()`, or `null` for a Unix-domain socket connection. */
  serverAddress: string | null;
  /** `inet_server_port()`, or `null` when the address is unavailable. */
  serverPort: number | null;
  /** `pg_is_in_recovery()` — `true` on a read replica or standby. */
  inRecovery: boolean;
  /** `current_setting('transaction_read_only')` observed inside the probe. */
  readOnly: boolean;
}>;

/**
 * The complete, credential-free view of a live target: what the URL claimed,
 * what the server reported, and whether the in-database marker agrees.
 */
export type ProductionDatabaseObservation = Readonly<{
  target: ResolvedDatabaseTarget;
  server: ProductionDatabaseServerObservation;
  /** `true` when the marker table exists on this database. */
  identityTablePresent: boolean;
  /** Marker value read from the singleton row, or `null` when absent. */
  marker: string | null;
}>;

/**
 * The reviewed, checked-in, non-secret expectation for one production
 * database. A planned database replacement is expressed as a pull request that
 * edits this record, never as an environment override.
 */
export type ProductionDatabaseTargetIdentity = Readonly<{
  /** Stable key for the target, for example `primary`. */
  id: string;
  /** Reviewed host the connection URL must use. */
  host: string;
  /** Reviewed port the connection URL must use. */
  port: number;
  /** Reviewed database name the connection URL must select. */
  database: string;
  /**
   * Approved cluster fingerprints. More than one entry is only legitimate
   * during a reviewed replacement window, when the outgoing and incoming
   * clusters are both known.
   */
  clusterFingerprints: readonly string[];
  /** Non-secret marker this database must carry once provisioned. */
  marker: ProductionDatabaseIdentityMarker;
  /**
   * Whether this target is still awaiting its first `prisma migrate deploy`.
   *
   * A freshly provisioned approved target has no marker table yet, so the
   * marker check has nothing to read. It is deferred only while this flag is
   * set, which makes the bootstrap allowance a visible, reviewed property of
   * the registry entry rather than a runtime override. Host, database name, and
   * cluster fingerprint stay enforced in full, so it never widens which
   * database is accepted. Set it back to `false` once the target is migrated.
   */
  provisioningAllowed: boolean;
  /** Human-readable justification kept next to the reviewed value. */
  reviewedNote: string;
}>;
