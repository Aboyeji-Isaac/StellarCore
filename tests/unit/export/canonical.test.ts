import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalStringify,
  computeSha256FromString,
  computeSha256FromBytes,
  computeRootHash,
  serializeToBuffer,
  serializeToBufferFromObject,
} from "@/lib/export/canonical";

test("canonicalStringify sorts object keys", () => {
  const input = { z: 1, a: 2, m: 3 };
  const result = canonicalStringify(input);
  assert.equal(result, '{"a":2,"m":3,"z":1}');
});

test("canonicalStringify sorts nested object keys", () => {
  const input = { outer: { z: 1, a: 2 } };
  const result = canonicalStringify(input);
  assert.equal(result, '{"outer":{"a":2,"z":1}}');
});

test("canonicalStringify sorts array elements that are objects", () => {
  const input = [{ z: 1 }, { a: 2 }];
  const result = canonicalStringify(input);
  assert.equal(result, '[{"a":2},{"z":1}]');
});

test("canonicalStringify handles Date objects", () => {
  const date = new Date("2026-01-15T12:30:45.000Z");
  const result = canonicalStringify({ timestamp: date });
  assert.equal(result, '{"timestamp":"2026-01-15T12:30:45.000Z"}');
});

test("canonicalStringify handles Map", () => {
  const map = new Map([
    ["z", 1],
    ["a", 2],
  ]);
  const result = canonicalStringify(map);
  assert.equal(result, '[["a",2],["z",1]]');
});

test("canonicalStringify handles Set", () => {
  const set = new Set(["z", "a", "m"]);
  const result = canonicalStringify(set);
  assert.equal(result, '["a","m","z"]');
});

test("canonicalStringify converts undefined to null", () => {
  const result = canonicalStringify({ a: undefined });
  assert.equal(result, '{"a":null}');
});

test("computeSha256FromString produces consistent hash", () => {
  const hash1 = computeSha256FromString("hello world");
  const hash2 = computeSha256FromString("hello world");
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test("computeSha256FromString produces different hash for different input", () => {
  const hash1 = computeSha256FromString("hello world");
  const hash2 = computeSha256FromString("hello world!");
  assert.notEqual(hash1, hash2);
});

test("computeSha256FromBytes produces consistent hash", () => {
  const bytes = new TextEncoder().encode("hello world");
  const hash1 = computeSha256FromBytes(bytes);
  const hash2 = computeSha256FromBytes(bytes);
  assert.equal(hash1, hash2);
});

test("computeRootHash combines hashes deterministically", () => {
  const entries = [
    { sha256: "a".repeat(64) },
    { sha256: "b".repeat(64) },
    { sha256: "c".repeat(64) },
  ];
  const root = computeRootHash(entries);
  assert.equal(root.length, 64);
});

test("computeRootHash is order-independent", () => {
  const entries1 = [{ sha256: "a".repeat(64) }, { sha256: "b".repeat(64) }];
  const entries2 = [{ sha256: "b".repeat(64) }, { sha256: "a".repeat(64) }];
  assert.equal(computeRootHash(entries1), computeRootHash(entries2));
});

test("serializeToBuffer encodes string to UTF-8 bytes", () => {
  const buffer = serializeToBuffer("hello");
  assert.deepEqual(Array.from(buffer), [104, 101, 108, 108, 111]);
});

test("serializeToBufferFromObject combines canonicalStringify and serializeToBuffer", () => {
  const buffer = serializeToBufferFromObject({ b: 1, a: 2 });
  const str = new TextDecoder().decode(buffer);
  assert.equal(str, '{"a":2,"b":1}');
});

test("canonicalStringify produces deterministic output for complex nested structures", () => {
  const input = {
    anchors: [
      { slug: "zeam", name: "Zeam" },
      { slug: "moneygram", name: "MoneyGram" },
    ],
    metadata: {
      version: "1.0",
      exportedAt: new Date("2026-01-15T12:00:00.000Z"),
    },
  };

  const result1 = canonicalStringify(input);
  const result2 = canonicalStringify(input);
  assert.equal(result1, result2);
  assert.ok(result1.includes("moneygram"));
  assert.ok(result1.includes("zeam"));
});