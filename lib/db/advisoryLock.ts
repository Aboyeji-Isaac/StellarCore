import { createHash } from "node:crypto";

/**
 * Reserved functional domains for PostgreSQL advisory locks in StellarCore.
 * Ensures strict namespace isolation across different operational workloads.
 */
export type LockDomain =
  | "REFRESH"
  | "MIGRATION"
  | "MAINTENANCE"
  | "DISCOVERY"
  | "SNAPSHOT";

export const LOCK_DOMAINS: readonly LockDomain[] = [
  "REFRESH",
  "MIGRATION",
  "MAINTENANCE",
  "DISCOVERY",
  "SNAPSHOT",
] as const;

export interface AdvisoryLockDefinition {
  domain: LockDomain;
  name: string;
  version: number;
  description: string;
}

export interface DerivedLockKey {
  canonicalName: string;
  domain: LockDomain;
  version: number;
  key64: bigint; // Signed 64-bit BigInt for pg_try_advisory_lock(bigint)
  classId: number; // Signed 32-bit int for pg_try_advisory_lock(int, int)
  objId: number; // Signed 32-bit int for pg_try_advisory_lock(int, int)
}

/**
 * Official registry of declared PostgreSQL advisory locks across StellarCore.
 * All locks must be registered here with unique logical names and explicit versions.
 */
export const ADVISORY_LOCK_REGISTRY: readonly AdvisoryLockDefinition[] = [
  {
    domain: "REFRESH",
    name: "DAILY_SCHEDULED_REFRESH",
    version: 1,
    description: "Guards daily scheduled background refresh of rates and reputation scores.",
  },
  {
    domain: "REFRESH",
    name: "REPUTATION_REEVALUATION",
    version: 1,
    description: "Prevents concurrent reputation scoring runs from racing.",
  },
  {
    domain: "MIGRATION",
    name: "DATABASE_MIGRATION_DEPLOY",
    version: 1,
    description: "Guards Prisma production migration execution against concurrent deployers.",
  },
  {
    domain: "MIGRATION",
    name: "REGISTRY_BOOTSTRAP",
    version: 1,
    description: "Guards anchor and corridor registry bootstrapping in database.",
  },
  {
    domain: "MAINTENANCE",
    name: "GLOBAL_MAINTENANCE_GATE",
    version: 1,
    description: "Privileged maintenance mode lock preventing mutating workloads.",
  },
  {
    domain: "MAINTENANCE",
    name: "ISOLATED_BACKUP_DRILL",
    version: 1,
    description: "Guards automated sandbox restore drills.",
  },
  {
    domain: "DISCOVERY",
    name: "ANCHOR_SYNC",
    version: 1,
    description: "Prevents concurrent anchor discovery runs from conflicting.",
  },
  {
    domain: "DISCOVERY",
    name: "CORRIDOR_SYNC",
    version: 1,
    description: "Prevents concurrent corridor discovery runs from conflicting.",
  },
  {
    domain: "SNAPSHOT",
    name: "RATE_SNAPSHOT_OBSERVATION",
    version: 1,
    description: "Guards SEP-38 rate snapshot observations against duplicate writes.",
  },
] as const;

/**
 * Derives a deterministic, collision-resistant 64-bit signed BigInt
 * and a pair of 32-bit signed integers for PostgreSQL advisory locking.
 */
export function deriveAdvisoryLockKey(
  domain: LockDomain,
  name: string,
  version = 1,
): DerivedLockKey {
  if (!domain || !name) {
    throw new Error("Advisory lock domain and name are required");
  }

  const cleanDomain = domain.trim().toUpperCase() as LockDomain;
  const cleanName = name.trim().toUpperCase();

  if (!LOCK_DOMAINS.includes(cleanDomain)) {
    throw new Error(`Invalid advisory lock domain: "${domain}"`);
  }

  const canonicalName = `stellarcore:v${version}:${cleanDomain}:${cleanName}`;
  const hash = createHash("sha256").update(canonicalName, "utf-8").digest();

  // Read first 8 bytes as signed 64-bit integer
  const key64 = hash.readBigInt64BE(0);

  // Read two 32-bit signed integers for 2-argument advisory lock forms
  const classId = hash.readInt32BE(0);
  const objId = hash.readInt32BE(4);

  return {
    canonicalName,
    domain: cleanDomain,
    version,
    key64,
    classId,
    objId,
  };
}

export interface LockRegistryVerification {
  ok: boolean;
  totalLocks: number;
  keys64: Record<string, string>;
  collisions: string[];
}

/**
 * Verifies that all registered advisory locks produce strictly unique keys
 * without any collisions across 64-bit or (32, 32) spaces.
 */
export function verifyAdvisoryLockRegistry(
  locks: readonly AdvisoryLockDefinition[] = ADVISORY_LOCK_REGISTRY,
): LockRegistryVerification {
  const seen64 = new Map<string, string>();
  const seen32Pair = new Map<string, string>();
  const collisions: string[] = [];
  const keys64: Record<string, string> = {};

  for (const def of locks) {
    const derived = deriveAdvisoryLockKey(def.domain, def.name, def.version);
    const key64Str = derived.key64.toString();
    const pairStr = `${derived.classId}:${derived.objId}`;

    keys64[derived.canonicalName] = key64Str;

    if (seen64.has(key64Str)) {
      collisions.push(
        `64-bit collision between [${def.name}] and [${seen64.get(key64Str)}] (key: ${key64Str})`,
      );
    } else {
      seen64.set(key64Str, def.name);
    }

    if (seen32Pair.has(pairStr)) {
      collisions.push(
        `32-bit pair collision between [${def.name}] and [${seen32Pair.get(pairStr)}] (pair: ${pairStr})`,
      );
    } else {
      seen32Pair.set(pairStr, def.name);
    }
  }

  return {
    ok: collisions.length === 0,
    totalLocks: locks.length,
    keys64,
    collisions,
  };
}

/**
 * Operator diagnostic helper that identifies an advisory lock key safely
 * without exposing secrets or raw database credentials.
 */
export function describeAdvisoryLock(
  key: bigint | string | number,
  locks: readonly AdvisoryLockDefinition[] = ADVISORY_LOCK_REGISTRY,
): {
  recognized: boolean;
  logicalName?: string;
  domain?: LockDomain;
  version?: number;
  key64: string;
} {
  const keyStr = typeof key === "bigint" ? key.toString() : String(key);

  for (const def of locks) {
    const derived = deriveAdvisoryLockKey(def.domain, def.name, def.version);
    if (derived.key64.toString() === keyStr) {
      return {
        recognized: true,
        logicalName: def.name,
        domain: def.domain,
        version: def.version,
        key64: keyStr,
      };
    }
  }

  return {
    recognized: false,
    key64: keyStr,
  };
}
