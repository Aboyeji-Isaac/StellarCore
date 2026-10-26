import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRestoreKey,
  type ResolveRestoreKeyInput,
} from "@/lib/backup/restoreKeyResolution";

// Fixed instants so overlap behavior is fully deterministic.
const NOW = new Date("2026-10-20T00:00:00.000Z");
const OVERLAP_UNTIL = new Date("2026-10-25T00:00:00.000Z");
const AFTER_OVERLAP = new Date("2026-10-31T00:00:00.000Z");

// Synthetic key identifiers only — never real secrets.
const CURRENT_KEY = { keyId: "k-2026-current" };
const PREVIOUS_KEY = { keyId: "k-2025-previous" };
const RETIRED_KEY = { keyId: "k-2024-retired" };

function resolve(
  overrides: Partial<ResolveRestoreKeyInput> = {},
) {
  return resolveRestoreKey({
    artifactKeyId: CURRENT_KEY.keyId,
    currentKey: CURRENT_KEY,
    previousKey: PREVIOUS_KEY,
    overlapUntil: OVERLAP_UNTIL,
    now: () => NOW,
    ...overrides,
  });
}

test("an artifact encrypted with the previous supported key restores during the overlap window", () => {
  const decision = resolve({ artifactKeyId: PREVIOUS_KEY.keyId });
  assert.deepEqual(decision, {
    ok: true,
    keyId: PREVIOUS_KEY.keyId,
    slot: "overlap",
  });
});

test("the current key restores immediately, before and after the overlap window", () => {
  assert.deepEqual(resolve({ artifactKeyId: CURRENT_KEY.keyId }), {
    ok: true,
    keyId: CURRENT_KEY.keyId,
    slot: "primary",
  });
  assert.deepEqual(
    resolve({ artifactKeyId: CURRENT_KEY.keyId, now: () => AFTER_OVERLAP }),
    { ok: true, keyId: CURRENT_KEY.keyId, slot: "primary" },
  );
});

test("a backup from a retired key is rejected with a stable, actionable code", () => {
  // Retired = the previous slot exists but its overlap window has closed.
  assert.deepEqual(
    resolve({
      artifactKeyId: PREVIOUS_KEY.keyId,
      now: () => AFTER_OVERLAP,
    }),
    {
      ok: false,
      code: "KEY_RETIRED",
      artifactKeyId: PREVIOUS_KEY.keyId,
    },
  );
  // A key we never supported at all is unknown, never guessed.
  assert.deepEqual(resolve({ artifactKeyId: RETIRED_KEY.keyId }), {
    ok: false,
    code: "KEY_UNKNOWN",
    artifactKeyId: RETIRED_KEY.keyId,
  });
});

test("missing, empty, and malformed artifact key identifiers fail closed", () => {
  assert.deepEqual(resolve({ artifactKeyId: undefined }), {
    ok: false,
    code: "ARTIFACT_KEY_MISSING",
    artifactKeyId: null,
  });
  assert.deepEqual(resolve({ artifactKeyId: "   " }), {
    ok: false,
    code: "ARTIFACT_KEY_EMPTY",
    artifactKeyId: null,
  });
  assert.deepEqual(resolve({ artifactKeyId: "contains spaces and\nnewlines" }), {
    ok: false,
    code: "ARTIFACT_KEY_EMPTY",
    artifactKeyId: null,
  });
});

test("an overlap decision without a current key never opens the previous door", () => {
  assert.deepEqual(
    resolve({ currentKey: undefined }),
    { ok: false, code: "NO_SUPPORTED_KEYS", artifactKeyId: CURRENT_KEY.keyId },
  );
});

test("rejection diagnostics reveal identifiers but never key material or credentials", () => {
  const sentinel = "super-secret-key-material";
  const decision = resolve({
    artifactKeyId: RETIRED_KEY.keyId,
    currentKey: { keyId: sentinel },
  });
  assert.deepEqual(decision, {
    ok: false,
    code: "KEY_UNKNOWN",
    artifactKeyId: RETIRED_KEY.keyId,
  });
  const serialized = JSON.stringify(decision);
  assert.equal(serialized.includes(sentinel), false);
  assert.equal(serialized.includes("postgres://"), false);
  assert.equal(serialized.includes(RETIRED_KEY.keyId), true);
});
