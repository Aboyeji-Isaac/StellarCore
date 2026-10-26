import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createFileStaleEvidenceStore,
  MAX_STALE_EVIDENCE_BYTES,
  MAX_STALE_EVIDENCE_SNAPSHOTS,
  readStaleEvidence,
  restoreStaleEvidence,
  STALE_EVIDENCE_MAX_AGE_MS,
  staleEvidenceHeaders,
} from "@/lib/api/staleEvidence";

const GENERATED_AT = new Date("2026-09-15T12:00:00.000Z");
const SOURCE_TIME = "2026-09-15T11:59:00.000Z";

test("file snapshots preserve provenance and restore an explicitly stale immutable body", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-evidence-test-"));
  const store = createFileStaleEvidenceStore(directory);
  const payload = Object.freeze({ result: Object.freeze({ value: 42, capturedAt: SOURCE_TIME }) });

  try {
    await store.write("rates:v1:test", payload, [SOURCE_TIME], GENERATED_AT);
    const restored = await restoreStaleEvidence(
      store,
      "rates:v1:test",
      new Date(GENERATED_AT.getTime() + 2_000),
    );

    assert.deepEqual(restored?.body, {
      result: { value: 42, capturedAt: SOURCE_TIME },
      degraded: {
        state: "stale",
        generatedAt: GENERATED_AT.toISOString(),
        expiresAt: new Date(GENERATED_AT.getTime() + STALE_EVIDENCE_MAX_AGE_MS).toISOString(),
        sourceTimes: [SOURCE_TIME],
        snapshotAgeMs: 2_000,
      },
    });
    assert.equal(Object.isFrozen(restored?.body), true);
    assert.deepEqual(staleEvidenceHeaders(restored?.metadata), {
      "Cache-Control": "no-store",
      "X-Evidence-State": "stale",
      "X-Evidence-Generated-At": GENERATED_AT.toISOString(),
      "X-Evidence-Expires-At": new Date(GENERATED_AT.getTime() + STALE_EVIDENCE_MAX_AGE_MS).toISOString(),
      "X-Evidence-Source-Time": SOURCE_TIME,
      Warning: '110 - "Response is stale"',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expired, corrupt, wrong-key, and oversized snapshots fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-evidence-test-"));
  const store = createFileStaleEvidenceStore(directory);

  try {
    await store.write("key", { value: 1, capturedAt: SOURCE_TIME }, [SOURCE_TIME], GENERATED_AT);
    assert.equal(await store.read("key", new Date(GENERATED_AT.getTime() + STALE_EVIDENCE_MAX_AGE_MS)), null);
    assert.equal(await store.read("different-key", new Date(GENERATED_AT.getTime() + 1)), null);

    const filename = (await readdir(directory)).find((name) => name.endsWith(".json"));
    assert.ok(filename);
    const path = join(directory, filename);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace('"value":1', '"value":2'));
    assert.equal(await store.read("key", new Date(GENERATED_AT.getTime() + 1)), null);

    const largePayload = { value: "x".repeat(MAX_STALE_EVIDENCE_BYTES), capturedAt: SOURCE_TIME };
    await store.write("too-large", largePayload, [SOURCE_TIME], GENERATED_AT);
    assert.equal(await store.read("too-large", new Date(GENERATED_AT.getTime() + 1)), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot writes are bounded and require at least one source evidence time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stellar-evidence-test-"));
  const store = createFileStaleEvidenceStore(directory);

  try {
    await store.write("without-provenance", { value: 1 }, [], GENERATED_AT);
    assert.deepEqual(await readdir(directory), []);

    for (let index = 0; index <= MAX_STALE_EVIDENCE_SNAPSHOTS; index += 1) {
      await store.write(`key-${index}`, { value: index, capturedAt: SOURCE_TIME }, [SOURCE_TIME], new Date(GENERATED_AT.getTime() + index));
    }
    assert.ok((await readdir(directory)).filter((name) => name.endsWith(".json")).length <= MAX_STALE_EVIDENCE_SNAPSHOTS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("snapshot reads reject invalid evaluation times", async () => {
  const store = createFileStaleEvidenceStore(join(tmpdir(), "unused-stellar-evidence"));
  assert.equal(await readStaleEvidence(store, "key", new Date(Number.NaN)), null);
});
