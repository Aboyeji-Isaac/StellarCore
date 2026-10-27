import { createHash } from "node:crypto";

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function computeRootHash(
  entries: readonly Readonly<{
    path: string;
    sha256: string;
    byteLength: number;
    recordCount: number;
  }>[],
  provenance: unknown,
): string {
  const normalized = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(({ path, sha256: digest, byteLength, recordCount }) => ({
      path,
      sha256: digest,
      byteLength,
      recordCount,
    }));
  return sha256(
    canonicalStringify({
      provenance,
      members: normalized,
    }),
  );
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  if (value === undefined) return null;
  return value;
}
