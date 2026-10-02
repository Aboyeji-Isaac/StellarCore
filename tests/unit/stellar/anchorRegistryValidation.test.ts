import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAnchorRegistry,
  validateAnchorRegistryDetailed,
  validateAnchorRegistryAsync,
  requiresDomainControlProof,
} from "@/lib/stellar/anchorRegistry";
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

const ZEAM: AnchorRegistryEntry = Object.freeze({
  slug: "zeam",
  name: "Zeam",
  homeDomain: "zeam.money",
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

test("validateAnchorRegistryDetailed passes for existing registry entries with valid proofs", () => {
  const result = validateAnchorRegistryDetailed([MONEYGRAM, COWRIE, ZEAM]);
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

test("validateAnchorRegistryDetailed fails for new entry without proof", () => {
  const newEntry: AnchorRegistryEntry = Object.freeze({
    slug: "newanchor",
    name: "New Anchor",
    homeDomain: "newanchor.example.com",
  });

  const result = validateAnchorRegistryDetailed([MONEYGRAM, newEntry]);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "MISSING_DOMAIN_CONTROL_PROOF");
  assert.equal(result.issues[0].slug, "newanchor");
});

test("validateAnchorRegistryDetailed fails for entry with changed homeDomain without new proof", () => {
  const changedEntry: AnchorRegistryEntry = Object.freeze({
    ...MONEYGRAM,
    homeDomain: "newdomain.example.com",
  });

  const result = validateAnchorRegistryDetailed([changedEntry]);
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, "INVALID_DOMAIN_CONTROL_PROOF");
  assert.ok(result.issues[0].proofVerification?.error?.includes("does not match entry homeDomain"));
});

test("validateAnchorRegistryDetailed fails for invalid slug", () => {
  const invalidEntry: AnchorRegistryEntry = Object.freeze({
    slug: "Invalid Slug",
    name: "Test",
    homeDomain: "example.com",
  });

  const result = validateAnchorRegistryDetailed([invalidEntry]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "INVALID_SLUG");
});

test("validateAnchorRegistryDetailed fails for empty name", () => {
  const invalidEntry: AnchorRegistryEntry = Object.freeze({
    slug: "test",
    name: "",
    homeDomain: "example.com",
  });

  const result = validateAnchorRegistryDetailed([invalidEntry]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "EMPTY_NAME");
});

test("validateAnchorRegistryDetailed fails for invalid homeDomain", () => {
  const invalidEntry: AnchorRegistryEntry = Object.freeze({
    slug: "test",
    name: "Test",
    homeDomain: "invalid",
  });

  const result = validateAnchorRegistryDetailed([invalidEntry]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "INVALID_HOME_DOMAIN");
});

test("validateAnchorRegistryDetailed fails for duplicate slug", () => {
  const result = validateAnchorRegistryDetailed([MONEYGRAM, { ...MONEYGRAM }]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "DUPLICATE_SLUG");
});

test("validateAnchorRegistryDetailed fails for duplicate homeDomain", () => {
  const duplicateDomainEntry: AnchorRegistryEntry = Object.freeze({
    slug: "duplicate",
    name: "Duplicate",
    homeDomain: "mgxanchor.moneygram.com",
  });

  const result = validateAnchorRegistryDetailed([MONEYGRAM, duplicateDomainEntry]);
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "DUPLICATE_HOME_DOMAIN");
});

test("validateAnchorRegistryAsync passes for valid entries with async nonce checking", async () => {
  const nonceStore = createInMemoryNonceStore();

  const result = await validateAnchorRegistryAsync([MONEYGRAM, COWRIE], {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });

  assert.equal(result.ok, true);
});

test("validateAnchorRegistryAsync fails for replayed proof", async () => {
  const nonceStore = createInMemoryNonceStore();

  const result1 = await validateAnchorRegistryAsync([MONEYGRAM], {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });
  assert.equal(result1.ok, true);

  const result2 = await validateAnchorRegistryAsync([MONEYGRAM], {
    clock: createFixedClock(FIXED_TIME),
    isNonceUsed: nonceStore.isNonceUsed,
    markNonceUsed: nonceStore.markNonceUsed,
  });
  assert.equal(result2.ok, false);
  assert.equal(result2.issues[0].code, "INVALID_DOMAIN_CONTROL_PROOF");
  assert.ok(result2.issues[0].proofVerification?.error?.includes("replay detected"));
});

test("requiresDomainControlProof returns true for new entry", () => {
  assert.equal(requiresDomainControlProof(undefined, MONEYGRAM), true);
});

test("requiresDomainControlProof returns true when homeDomain changes", () => {
  const changedEntry: AnchorRegistryEntry = Object.freeze({
    ...MONEYGRAM,
    homeDomain: "newdomain.example.com",
  });
  assert.equal(requiresDomainControlProof(MONEYGRAM, changedEntry), true);
});

test("requiresDomainControlProof returns false when only name changes", () => {
  const changedEntry: AnchorRegistryEntry = Object.freeze({
    ...MONEYGRAM,
    name: "New Name",
  });
  assert.equal(requiresDomainControlProof(MONEYGRAM, changedEntry), false);
});

test("requiresDomainControlProof returns false when slug changes (different entry)", () => {
  const differentEntry: AnchorRegistryEntry = Object.freeze({
    slug: "different",
    name: "MoneyGram",
    homeDomain: "mgxanchor.moneygram.com",
  });
  assert.equal(requiresDomainControlProof(MONEYGRAM, differentEntry), false);
});

test("validateAnchorRegistry throws on validation failure", () => {
  const newEntry: AnchorRegistryEntry = Object.freeze({
    slug: "newanchor",
    name: "New Anchor",
    homeDomain: "newanchor.example.com",
  });

  assert.throws(
    () => validateAnchorRegistry([newEntry]),
    /is missing a domain control proof/,
  );
});