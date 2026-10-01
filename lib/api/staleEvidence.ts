import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StaleEvidenceMetadata } from "@/types/api/staleEvidence";

export const STALE_EVIDENCE_SCHEMA_VERSION = 1;
export const STALE_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
export const MAX_STALE_EVIDENCE_SNAPSHOTS = 64;
export const MAX_STALE_EVIDENCE_BYTES = 512 * 1024;

type JsonRecord = Readonly<Record<string, unknown>>;

export type VerifiedEvidenceSnapshot = Readonly<{
  payload: JsonRecord;
  generatedAt: string;
  expiresAt: string;
  sourceTimes: readonly string[];
}>;

export type StaleEvidenceStore = Readonly<{
  read: (key: string, now: Date) => Promise<VerifiedEvidenceSnapshot | null>;
  write: (
    key: string,
    payload: JsonRecord,
    sourceTimes: readonly string[],
    generatedAt: Date,
  ) => Promise<void>;
}>;

type SnapshotEnvelope = Readonly<{
  schemaVersion: number;
  key: string;
  generatedAt: string;
  expiresAt: string;
  sourceTimes: readonly string[];
  payload: JsonRecord;
  digest: string;
}>;

export const FILE_STALE_EVIDENCE_STORE = createFileStaleEvidenceStore(
  process.env.STALE_EVIDENCE_DIRECTORY
    ?? join(tmpdir(), "stellarcore-stale-evidence"),
);

export function createFileStaleEvidenceStore(directory: string): StaleEvidenceStore {
  const filenameFor = (key: string) => `${sha256(key)}.json`;

  return Object.freeze({
    async read(key, now) {
      if (!Number.isFinite(now.getTime())) return null;
      try {
        const filePath = join(directory, filenameFor(key));
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_STALE_EVIDENCE_BYTES) return null;
        const text = await readFile(filePath, "utf8");
        const parsed: unknown = JSON.parse(text);
        return verifySnapshot(parsed, key, now);
      } catch {
        return null;
      }
    },

    async write(key, payload, sourceTimes, generatedAt) {
      if (
        !Number.isFinite(generatedAt.getTime())
        || !isJsonRecord(payload)
        || sourceTimes.length === 0
        || sourceTimes.length > 2_048
        || sourceTimes.some((time) => !isCanonicalTimestamp(time))
      ) return;
      let immutablePayload: JsonRecord;
      try {
        const payloadText = JSON.stringify(payload);
        if (Buffer.byteLength(payloadText, "utf8") > MAX_STALE_EVIDENCE_BYTES) return;
        immutablePayload = deepFreeze(JSON.parse(payloadText) as JsonRecord);
      } catch {
        return;
      }
      const payloadSourceTimes = collectSourceTimes(immutablePayload);
      if (!payloadSourceTimes || !sameStrings(payloadSourceTimes, [...new Set(sourceTimes)].sort())) return;

      const filePath = join(directory, filenameFor(key));
      const generatedAtText = generatedAt.toISOString();
      const expiresAt = new Date(generatedAt.getTime() + STALE_EVIDENCE_MAX_AGE_MS).toISOString();
      const orderedSourceTimes = Object.freeze([...new Set(sourceTimes)].sort());

      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const prior = await readFile(filePath, "utf8").then((text) => JSON.parse(text) as unknown).catch(() => null);
        const priorGeneratedAt = isJsonRecord(prior) && typeof prior.generatedAt === "string"
          ? Date.parse(prior.generatedAt)
          : Number.NaN;
        const verifiedPrior = Number.isFinite(priorGeneratedAt)
          ? verifySnapshot(prior, key, new Date(priorGeneratedAt))
          : null;
        if (verifiedPrior && priorGeneratedAt >= generatedAt.getTime()) return;

        const unsigned = {
          schemaVersion: STALE_EVIDENCE_SCHEMA_VERSION,
          key,
          generatedAt: generatedAtText,
          expiresAt,
          sourceTimes: orderedSourceTimes,
          payload: immutablePayload,
        };
        const envelope: SnapshotEnvelope = Object.freeze({ ...unsigned, digest: digest(unsigned) });
        const serialized = JSON.stringify(envelope);
        if (Buffer.byteLength(serialized, "utf8") > MAX_STALE_EVIDENCE_BYTES) return;

        const temporaryPath = join(directory, `${filenameFor(key)}.${process.pid}.${Date.now()}.tmp`);
        await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, filePath);
        await pruneSnapshots(directory, filePath);
      } catch {
        // The primary database response remains authoritative if fallback storage fails.
      }
    },
  });
}

export async function saveLastKnownGoodEvidence(
  store: StaleEvidenceStore,
  key: string,
  payload: JsonRecord,
  sourceTimes: readonly string[],
  generatedAt: Date,
): Promise<void> {
  try {
    await store.write(key, payload, sourceTimes, generatedAt);
  } catch {
    // Snapshot persistence is best effort and never changes the primary response.
  }
}

export async function readStaleEvidence(
  store: StaleEvidenceStore,
  key: string,
  now: Date,
): Promise<Readonly<{ payload: JsonRecord; metadata: StaleEvidenceMetadata }> | null> {
  try {
    const snapshot = await store.read(key, now);
    if (!snapshot) return null;
    const generatedAt = Date.parse(snapshot.generatedAt);
    const expiresAt = Date.parse(snapshot.expiresAt);
    const nowMs = now.getTime();
    if (
      !Number.isFinite(generatedAt)
      || !Number.isFinite(expiresAt)
      || expiresAt !== generatedAt + STALE_EVIDENCE_MAX_AGE_MS
      || nowMs < generatedAt
      || nowMs >= expiresAt
      || !snapshot.sourceTimes.length
      || !snapshot.sourceTimes.every(isCanonicalTimestamp)
      || !sameStrings(collectSourceTimes(snapshot.payload) ?? [], [...new Set(snapshot.sourceTimes)].sort())
    ) return null;
    return Object.freeze({
      payload: snapshot.payload,
      metadata: Object.freeze({
        state: "stale",
        generatedAt: snapshot.generatedAt,
        expiresAt: snapshot.expiresAt,
        sourceTimes: snapshot.sourceTimes,
        snapshotAgeMs: nowMs - generatedAt,
      }),
    });
  } catch {
    return null;
  }
}

export async function restoreStaleEvidence(
  store: StaleEvidenceStore,
  key: string,
  now: Date,
): Promise<Readonly<{ body: JsonRecord & { degraded: StaleEvidenceMetadata }; metadata: StaleEvidenceMetadata }> | null> {
  const snapshot = await readStaleEvidence(store, key, now);
  if (!snapshot) return null;
  const body = deepFreeze({ ...snapshot.payload, degraded: snapshot.metadata });
  return Object.freeze({ body, metadata: snapshot.metadata });
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function staleEvidenceHeaders(
  metadata?: StaleEvidenceMetadata,
): Readonly<Record<string, string>> {
  if (!metadata) return Object.freeze({ "Cache-Control": "no-store" });
  return Object.freeze({
    "Cache-Control": "no-store",
    "X-Evidence-State": "stale",
    "X-Evidence-Generated-At": metadata.generatedAt,
    "X-Evidence-Expires-At": metadata.expiresAt,
    ...(metadata.sourceTimes.length > 0
      ? { "X-Evidence-Source-Time": metadata.sourceTimes[metadata.sourceTimes.length - 1]! }
      : {}),
    Warning: '110 - "Response is stale"',
  });
}

function verifySnapshot(
  value: unknown,
  expectedKey: string,
  now: Date,
): VerifiedEvidenceSnapshot | null {
  if (!isJsonRecord(value)) return null;
  const envelope = value as Partial<SnapshotEnvelope>;
  if (
    envelope.schemaVersion !== STALE_EVIDENCE_SCHEMA_VERSION
    || envelope.key !== expectedKey
    || typeof envelope.generatedAt !== "string"
    || typeof envelope.expiresAt !== "string"
    || !Array.isArray(envelope.sourceTimes)
    || !envelope.sourceTimes.length
    || envelope.sourceTimes.length > 2_048
    || !envelope.sourceTimes.every(isCanonicalTimestamp)
    || !isJsonRecord(envelope.payload)
    || typeof envelope.digest !== "string"
  ) return null;

  const generatedAt = Date.parse(envelope.generatedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  if (
    !Number.isFinite(generatedAt)
    || !Number.isFinite(expiresAt)
    || !Number.isFinite(now.getTime())
    || generatedAt > now.getTime()
    || expiresAt !== generatedAt + STALE_EVIDENCE_MAX_AGE_MS
    || now.getTime() >= expiresAt
  ) return null;

  const unsigned = {
    schemaVersion: envelope.schemaVersion,
    key: envelope.key,
    generatedAt: envelope.generatedAt,
    expiresAt: envelope.expiresAt,
    sourceTimes: envelope.sourceTimes,
    payload: envelope.payload,
  };
  if (digest(unsigned) !== envelope.digest) return null;
  const payloadSourceTimes = collectSourceTimes(envelope.payload);
  if (!payloadSourceTimes || !sameStrings(payloadSourceTimes, [...new Set(envelope.sourceTimes)].sort())) return null;
  return Object.freeze({
    payload: deepFreeze(envelope.payload),
    generatedAt: envelope.generatedAt,
    expiresAt: envelope.expiresAt,
    sourceTimes: Object.freeze([...envelope.sourceTimes]),
  });
}

async function pruneSnapshots(directory: string, keepPath: string): Promise<void> {
  const candidates: { path: string; modifiedAt: number }[] = [];
  const staleTemps: { path: string; modifiedAt: number }[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    try {
      const fileStat = await stat(path);
      if (/^[a-f0-9]{64}\.json$/.test(name)) {
        candidates.push({ path, modifiedAt: fileStat.mtimeMs });
      } else if (name.endsWith(".tmp") && Date.now() - fileStat.mtimeMs > 60_000) {
        staleTemps.push({ path, modifiedAt: fileStat.mtimeMs });
      }
    } catch {
      // Ignore files concurrently removed by another request.
    }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const retained = candidates
    .filter(({ path }) => path !== keepPath)
    .slice(0, MAX_STALE_EVIDENCE_SNAPSHOTS - 1)
    .map(({ path }) => path);
  for (const candidate of candidates) {
    if (candidate.path === keepPath || retained.includes(candidate.path)) continue;
    await unlink(candidate.path).catch(() => undefined);
  }
  staleTemps.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const tempCutoff = 16;
  await Promise.all(staleTemps.slice(tempCutoff).map(({ path }) => unlink(path).catch(() => undefined)));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function collectSourceTimes(value: JsonRecord): readonly string[] | null {
  const collected = new Set<string>();
  const visit = (current: unknown): boolean => {
    if (Array.isArray(current)) return current.every(visit);
    if (typeof current !== "object" || current === null) return true;
    for (const [key, child] of Object.entries(current)) {
      if (key === "capturedAt" || key === "computedAt") {
        if (child === null && key === "computedAt") continue;
        if (!isCanonicalTimestamp(child)) return false;
        collected.add(child);
      }
      if (!visit(child)) return false;
    }
    return true;
  };
  if (!visit(value)) return null;
  return Object.freeze([...collected].sort());
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digest(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
