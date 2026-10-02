import assert from "node:assert/strict";
import test from "node:test";

import {
  createProof,
  generateChallenge,
  hashCanonicalEntry,
  verifyProof,
  verifyProofAsync,
  type DomainControlProof,
} from "@/lib/stellar/domainControl";
import type { AnchorRegistryEntry } from "@/types/anchor";

const MONEYGRAM: AnchorRegistryEntry = Object.freeze({
  slug: "moneygram",
  name: "MoneyGram",
  homeDomain: "mgxanchor.moneygram.com",
});

const COWRIE: AnchorRegistryEntry = Object.freeze({
  slug: "cowrie",
  name: "Cowrie",
  homeDomain: "cowrie.exchange",
});

const FIXED_TIME = new Date("2026-06-15T12:00:00.000Z");

function createFixedClock(fixedTime: Date) {
  return Object.freeze({
    now: () => new Date(fixedTime.getTime()),
  });
}

function createInMemoryNonceStore() {
  const usedNonces = new Set<string>();
  return Object.freeze({
    isNonceUsed: async (nonce: string) => usedNonces.has(nonce),
    markNonceUsed: async (nonce: string) => { usedNonces.add(nonce); },
  });
}

test("generateChallenge produces deterministic challenge bound to homeDomain and entry", () => {
  const challenge1 = generateChallenge(MONEYGRAM);
  const challenge2 = generateChallenge(MONEYGRAM);
  assert.equal(challenge1, challenge2);
  assert.ok(challenge1.includes("mgxanchor.moneygram.com"));
  assert.ok(challenge1.startsWith("stellarcore-domain-control:v1|"));
});

test("generateChallenge differs for different homeDomains", () => {
  const challenge1 = generateChallenge(MONEYGRAM);
  const challenge2 = generateChallenge(COWRIE);
  assert.notEqual(challenge1, challenge2);
});

test("generateChallenge differs for different entry with same homeDomain", () => {
  const entry1: AnchorRegistryEntry = Object.freeze({
    slug: "moneygram",
    name: "MoneyGram",
    homeDomain: "mgxanchor.moneygram.com",
  });
  const entry2: AnchorRegistryEntry = Object.freeze({
    slug: "moneygram2",
    name: "MoneyGram Two",
    homeDomain: "mgxanchor.moneygram.com",
  });
  const challenge1 = generateChallenge(entry1);
  const challenge2 = generateChallenge(entry2);
  assert.notEqual(challenge1, challenge2);
});

test("createProof produces valid proof with correct structure", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  assert.equal(proof.version, 1);
  assert.equal(proof.homeDomain, "mgxanchor.moneygram.com");
  assert.equal(proof.changeHash, hashCanonicalEntry(MONEYGRAM));
  assert.equal(proof.issuedAt, "2026-06-15T12:00:00.000Z");
  assert.equal(proof.expiresAt, "2026-07-15T12:00:00.000Z");
  assert.equal(proof.nonce.length, 32);
  assert.ok(proof.signature.length > 0);
});

test("verifyProof accepts valid proof", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  const result = verifyProof(proof, MONEYGRAM, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, true);
  assert.ok(result.proofId.length > 0);
  assert.equal(result.verifiedAt, "2026-06-15T12:00:00.000Z");
  assert.equal(result.error, undefined);
});

test("verifyProof rejects expired proof", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  const expiredClock = createFixedClock(new Date("2026-07-16T12:00:00.000Z"));

  const result = verifyProof(proof, MONEYGRAM, {
    clock: expiredClock,
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Proof has expired");
});

test("verifyProof rejects proof issued in future", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  const pastClock = createFixedClock(new Date("2026-06-14T12:00:00.000Z"));

  const result = verifyProof(proof, MONEYGRAM, {
    clock: pastClock,
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Proof issued in the future");
});

test("verifyProof rejects mismatched homeDomain", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  const result = verifyProof(proof, COWRIE, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("does not match entry homeDomain"));
});

test("verifyProof rejects mismatched changeHash (different entry)", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  const differentEntry: AnchorRegistryEntry = Object.freeze({
    slug: "moneygram",
    name: "MoneyGram Different Name",
    homeDomain: "mgxanchor.moneygram.com",
  });

  const result = verifyProof(proof, differentEntry, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Proof changeHash does not match the proposed registry entry");
});

test("verifyProof rejects invalid signature", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);
  const tamperedProof = Object.freeze({
    ...proof,
    signature: "invalid-signature",
  });

  const result = verifyProof(tamperedProof, MONEYGRAM, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid proof signature");
});

test("verifyProof rejects unsupported version", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);
  const oldVersionProof = {
    ...proof,
    version: 99,
  } as unknown as DomainControlProof;

  const result = verifyProof(oldVersionProof, MONEYGRAM, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("Unsupported proof version"));
});

test("verifyProofAsync rejects replayed proof (nonce reuse)", async () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);
  const nonceStore = createInMemoryNonceStore();

  const result1 = await verifyProofAsync(proof, MONEYGRAM, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });

  assert.equal(result1.ok, true);

  const result2 = await verifyProofAsync(proof, MONEYGRAM, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });

  assert.equal(result2.ok, false);
  assert.equal(result2.error, "Proof has already been used (replay detected)");
});

test("verifyProofAsync accepts proof with different nonce", async () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof1 = createProof(MONEYGRAM, clock);
  
  const clock2 = createFixedClock(new Date("2026-06-15T12:00:01.000Z"));
  const proof2 = createProof(MONEYGRAM, clock2);

  const nonceStore = createInMemoryNonceStore();
  
  // Use a verification clock that's after both proofs' issuedAt
  const verificationClock = createFixedClock(new Date("2026-06-15T12:00:02.000Z"));

  const result1 = await verifyProofAsync(proof1, MONEYGRAM, {
    clock: verificationClock,
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });
  assert.equal(result1.ok, true);

  const result2 = await verifyProofAsync(proof2, MONEYGRAM, {
    clock: verificationClock,
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });
  assert.equal(result2.ok, true);
});

test("verifyProof rejects invalid timestamp format", () => {
  const badProof: DomainControlProof = Object.freeze({
    version: 1,
    homeDomain: "mgxanchor.moneygram.com",
    changeHash: hashCanonicalEntry(MONEYGRAM),
    issuedAt: "not-a-date",
    expiresAt: "2026-07-15T12:00:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
    signature: "dummy",
  });

  const result = verifyProof(badProof, MONEYGRAM, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid timestamp format in proof");
});

test("hashCanonicalEntry is deterministic", () => {
  const hash1 = hashCanonicalEntry(MONEYGRAM);
  const hash2 = hashCanonicalEntry(MONEYGRAM);
  assert.equal(hash1, hash2);
  assert.equal(hash1.length, 64);
});

test("homeDomain change requires new proof", () => {
  const clock = createFixedClock(FIXED_TIME);
  const proof = createProof(MONEYGRAM, clock);

  const entryWithNewDomain: AnchorRegistryEntry = Object.freeze({
    ...MONEYGRAM,
    homeDomain: "newdomain.example.com",
  });

  const result = verifyProof(proof, entryWithNewDomain, {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: async () => false,
    markNonceUsed: async () => {},
  });

  assert.equal(result.ok, false);
  assert.ok(result.error?.includes("does not match entry homeDomain"));
});