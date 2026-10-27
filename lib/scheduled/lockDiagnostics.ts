/**
 * Operator diagnostics: reverse-map raw int8 advisory lock keys to
 * human-readable logical names. Safe for logs and metrics — never exposes
 * payload data, database credentials, or internal error details.
 */

import { LOCK_REGISTRY, resolveKey } from "@/lib/scheduled/advisoryLockKey";

export type LockDiagnosticEntry = Readonly<{
  key: string;
  logicalName: string;
  domainId: number;
  description: string;
}>;

export type UnknownLockEntry = Readonly<{
  key: string;
  logicalName: null;
  domainId: null;
  description: null;
}>;

/**
 * Resolves a raw int8 key to a sanitized diagnostic entry.
 * Returns an unknown-keyed entry when the key is not in the registry.
 */
export function diagnoseLockKey(rawKey: bigint | string | number): LockDiagnosticEntry | UnknownLockEntry {
  const key = BigInt(rawKey);
  const descriptor = resolveKey(key);
  if (!descriptor) {
    return Object.freeze({
      key: key.toString(),
      logicalName: null,
      domainId: null,
      description: null,
    });
  }
  return Object.freeze({
    key: key.toString(),
    logicalName: descriptor.logicalName,
    domainId: descriptor.domainId,
    description: descriptor.description,
  });
}

/**
 * Returns the full registry as sanitized diagnostic entries.
 * Suitable for an operator endpoint or health-check log line.
 */
export function listRegisteredLocks(): readonly LockDiagnosticEntry[] {
  return Object.freeze(
    LOCK_REGISTRY.map((entry) =>
      Object.freeze({
        key: entry.derivedKey.toString(),
        logicalName: entry.logicalName,
        domainId: entry.domainId,
        description: entry.description,
      }),
    ),
  );
}
