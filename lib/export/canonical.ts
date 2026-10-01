import { createHash } from "node:crypto";

export function canonicalStringify<T>(value: T): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Map) {
    return Array.from(value.entries())
      .sort(([a], [b]) =>
        String(a).localeCompare(String(b)),
      )
      .map(([key, child]) => [
        canonicalize(key),
        canonicalize(child),
      ]);
  }

  if (value instanceof Set) {
    return Array.from(value)
      .sort((a, b) =>
        String(a).localeCompare(String(b)),
      )
      .map(canonicalize);
  }

  if (Array.isArray(value)) {
    const mapped = value.map(canonicalize);

    const allObjects = mapped.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item),
    );

    if (allObjects) {
      return mapped.sort((a, b) =>
        JSON.stringify(a).localeCompare(
          JSON.stringify(b),
        ),
      );
    }

    return mapped;
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) =>
          left.localeCompare(right),
        )
        .map(([key, child]) => [
          key,
          canonicalize(child),
        ]),
    );
  }

  return value;
}

export function sha256(
  data: string | Uint8Array,
): string {
  return createHash("sha256")
    .update(data)
    .digest("hex");
}

/**
 * Backward-compatible aliases used by existing callers.
 */
export function computeSha256(
  data: string | Uint8Array,
): string {
  return sha256(data);
}

export function computeSha256FromString(
  data: string,
): string {
  return sha256(data);
}

export function computeSha256FromBytes(
  data: Uint8Array,
): string {
  return sha256(data);
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
    .sort((a, b) =>
      a.path.localeCompare(b.path),
    )
    .map(
      ({
        path,
        sha256: digest,
        byteLength,
        recordCount,
      }) => ({
        path,
        sha256: digest,
        byteLength,
        recordCount,
      }),
    );

  return sha256(
    canonicalStringify({
      provenance,
      members: normalized,
    }),
  );
}

export async function* streamJsonArray<T>(
  items: AsyncIterable<T>,
  stringify: (item: T) => string,
): AsyncGenerator<string> {
  yield "[";

  let first = true;

  for await (const item of items) {
    if (!first) {
      yield ",";
    }

    first = false;
    yield stringify(item);
  }

  yield "]";
}

export function serializeToBuffer(
  data: string,
): Uint8Array {
  return new TextEncoder().encode(data);
}

export function serializeToBufferFromObject(
  obj: unknown,
): Uint8Array {
  return serializeToBuffer(
    canonicalStringify(obj),
  );
}