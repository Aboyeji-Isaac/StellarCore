import { createHash } from "node:crypto";

export function canonicalStringify<T>(value: T): string {
  return JSON.stringify(value, canonicalReplacer);
}

function canonicalReplacer(_key: string, value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Map) {
    return Array.from(value.entries()).sort(([a], [b]) => String(a).localeCompare(String(b)));
  }
  if (value instanceof Set) {
    return Array.from(value).sort((a, b) => String(a).localeCompare(String(b)));
  }
  if (Array.isArray(value)) {
    const mapped = value.map((v) => canonicalReplacer("", v));
    const allObjects = mapped.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    if (allObjects) {
      return mapped.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    return mapped;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalReplacer(key, obj[key]);
    }
    return result;
  }
  return value;
}

export function computeSha256(data: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(data);
  return hash.digest("hex");
}

export function computeSha256FromString(data: string): string {
  return computeSha256(data);
}

export function computeSha256FromBytes(data: Uint8Array): string {
  return computeSha256(data);
}

export function computeRootHash(entries: ReadonlyArray<{ sha256: string }>): string {
  const combined = entries.map((e) => e.sha256).sort().join("");
  return computeSha256(combined);
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

export function serializeToBuffer(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

export function serializeToBufferFromObject(obj: unknown): Uint8Array {
  return serializeToBuffer(canonicalStringify(obj));
}