const ISO_8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function isIsoTimestampString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!ISO_8601_UTC_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  const date = new Date(parsed);
  const parts = value.slice(0, 10).split("-").map(Number);
  if (
    parts.length !== 3 ||
    date.getUTCFullYear() !== parts[0] ||
    date.getUTCMonth() + 1 !== parts[1] ||
    date.getUTCDate() !== parts[2]
  ) {
    return false;
  }
  return true;
}

export function normalizePayload(
  value: unknown,
  keyContext?: string,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    if (value === "<ISO_TIMESTAMP>") {
      return value;
    }
    if (isIsoTimestampString(value)) {
      return "<ISO_TIMESTAMP>";
    }
    return value;
  }

  if (typeof value === "number") {
    if (keyContext === "ageMs" && Number.isInteger(value) && value >= 0) {
      return "<AGE_MS>";
    }
    return value;
  }

  if (typeof value === "string" && keyContext === "ageMs" && value === "<AGE_MS>") {
    return value;
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => normalizePayload(item, keyContext)));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      normalized[key] = normalizePayload(record[key], key);
    }
    return Object.freeze(normalized);
  }

  return value;
}
