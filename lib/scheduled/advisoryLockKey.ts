/**
 * Deterministic 64-bit key derivation for PostgreSQL advisory locks.
 *
 * Schema:  <domain>:<workflow>:<version>:<resource>
 * Hash:    FNV-1a 64-bit over the UTF-8 logical name
 * Output:  BigInt in [-2^63, 2^63) — compatible with pg_advisory_lock(bigint)
 *
 * Domain IDs (upper 16 bits of the hash are NOT used for routing; domain is
 * encoded in the logical name string, not truncated into the key structure).
 * The numeric domain constants exist solely as documentation anchors for the
 * registry and collision test.
 */

// FNV-1a 64-bit constants
const FNV_PRIME = 0x00000100000001b3n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const MASK64 = 0xffffffffffffffffn;
const INT64_RANGE = 2n ** 64n;

/** Reserved domain identifiers — embedded in logical lock names. */
export const LOCK_DOMAIN = Object.freeze({
  REFRESH: 0x01,
  MIGRATION: 0x02,
  MAINTENANCE: 0x03,
  FUTURE_04: 0x04,
  FUTURE_05: 0x05,
} as const);

export type LockDomainId = (typeof LOCK_DOMAIN)[keyof typeof LOCK_DOMAIN];

/**
 * Derives a PostgreSQL-compatible signed int8 key from a logical lock name.
 * Input is never mutated or retained beyond this call.
 *
 * @param logicalName — format: `<domain>:<workflow>:<version>:<resource>`
 */
export function deriveLockKey(logicalName: string): bigint {
  // FNV-1a 64-bit over each UTF-16 code unit (ASCII names stay single-byte clean)
  let hash = FNV_OFFSET;
  for (let i = 0; i < logicalName.length; i++) {
    hash = ((hash ^ BigInt(logicalName.charCodeAt(i))) * FNV_PRIME) & MASK64;
  }
  // Reinterpret unsigned 64-bit as signed int8 for PostgreSQL
  return hash >= 2n ** 63n ? hash - INT64_RANGE : hash;
}

/**
 * Formats a canonical logical lock name from its four components.
 * All arguments must be non-empty ASCII strings; the version segment
 * conventionally uses "v<N>" (e.g., "v1").
 */
export function lockName(
  domain: string,
  workflow: string,
  version: string,
  resource: string,
): string {
  if (!domain || !workflow || !version || !resource) {
    throw new Error("All lock name segments must be non-empty");
  }
  return `${domain}:${workflow}:${version}:${resource}`;
}

/**
 * All declared workflow lock descriptors.
 * Each entry is the single authoritative source for a lock's stable identity.
 * Add new entries here; never change existing `logicalName` values in place.
 */
export type LockDescriptor = Readonly<{
  logicalName: string;
  domainId: LockDomainId;
  description: string;
  derivedKey: bigint;
}>;

function descriptor(
  domain: string,
  workflow: string,
  version: string,
  resource: string,
  domainId: LockDomainId,
  description: string,
): LockDescriptor {
  const logicalName = lockName(domain, workflow, version, resource);
  return Object.freeze({
    logicalName,
    domainId,
    description,
    derivedKey: deriveLockKey(logicalName),
  });
}

/**
 * Authoritative registry of every declared advisory lock.
 * Order is stable but not meaningful; key uniqueness is enforced by tests.
 */
export const LOCK_REGISTRY: readonly LockDescriptor[] = Object.freeze([
  descriptor(
    "refresh",
    "scheduled-refresh",
    "v1",
    "global",
    LOCK_DOMAIN.REFRESH,
    "Prevents concurrent scheduled-refresh cycles",
  ),
  descriptor(
    "migration",
    "schema-migration",
    "v1",
    "global",
    LOCK_DOMAIN.MIGRATION,
    "Serializes manual schema migration runs",
  ),
  descriptor(
    "maintenance",
    "registry-bootstrap",
    "v1",
    "global",
    LOCK_DOMAIN.MAINTENANCE,
    "Serializes registry bootstrap across concurrent invocations",
  ),
  descriptor(
    "maintenance",
    "reputation-backfill",
    "v1",
    "global",
    LOCK_DOMAIN.MAINTENANCE,
    "Serializes one-off reputation backfill operations",
  ),
]);

/**
 * Reverse-maps a raw int8 key to its registered descriptor.
 * Returns undefined when the key is unknown (not a diagnostics error).
 */
export function resolveKey(key: bigint): LockDescriptor | undefined {
  for (const entry of LOCK_REGISTRY) {
    if (entry.derivedKey === key) return entry;
  }
  return undefined;
}
