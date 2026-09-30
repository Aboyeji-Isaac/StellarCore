import assert from "node:assert/strict";
import test from "node:test";

import {
  isValidHomeDomain,
  validateAnchorRegistry,
} from "@/lib/stellar/anchorRegistry";
import type { AnchorRegistryEntry } from "@/types/anchor";

const BASE_ANCHOR = Object.freeze({
  slug: "anchor-one",
  name: "Anchor One",
  homeDomain: "anchor.example",
}) satisfies AnchorRegistryEntry;

test("isValidHomeDomain accepts valid ASCII and IDN domains", () => {
  assert.equal(isValidHomeDomain("mgxanchor.moneygram.com"), true);
  assert.equal(isValidHomeDomain("cowrie.exchange"), true);
  assert.equal(isValidHomeDomain("zeam.money"), true);
  assert.equal(isValidHomeDomain("münchen.de"), true);
  assert.equal(isValidHomeDomain("xn--mnchen-3ya.de"), true);
});

test("isValidHomeDomain rejects invalid forms", () => {
  assert.equal(isValidHomeDomain(""), false);
  assert.equal(isValidHomeDomain("example.com/path"), false);
  assert.equal(isValidHomeDomain("example.com:443"), false);
  assert.equal(isValidHomeDomain("127.0.0.1"), false);
  assert.equal(isValidHomeDomain("::1"), false);
  assert.equal(isValidHomeDomain("-foo.com"), false);
  assert.equal(isValidHomeDomain("sub_domain.com"), false);
  assert.equal(isValidHomeDomain("аpple.com"), false); // cyrillic mixed script
});

test("validateAnchorRegistry accepts valid normalized entries", () => {
  assert.doesNotThrow(() =>
    validateAnchorRegistry([
      BASE_ANCHOR,
      {
        slug: "anchor-two",
        name: "Anchor Two",
        homeDomain: "two.example",
      },
    ]),
  );
});

test("validateAnchorRegistry rejects invalid slugs, empty names, and invalid home domains", () => {
  assert.throws(
    () =>
      validateAnchorRegistry([
        { ...BASE_ANCHOR, slug: "Invalid Slug" },
      ]),
    /Invalid anchor slug/,
  );

  assert.throws(
    () =>
      validateAnchorRegistry([
        { ...BASE_ANCHOR, name: "   " },
      ]),
    /empty name/,
  );

  assert.throws(
    () =>
      validateAnchorRegistry([
        { ...BASE_ANCHOR, homeDomain: "https://anchor.example" },
      ]),
    /invalid home domain/,
  );

  assert.throws(
    () =>
      validateAnchorRegistry([
        { ...BASE_ANCHOR, homeDomain: "anchor.example:8443" },
      ]),
    /invalid home domain/,
  );
});

test("duplicate-domain checks cannot be bypassed by case variants", () => {
  const entry1 = { ...BASE_ANCHOR, slug: "anchor-a", homeDomain: "anchor.example" };
  const entry2 = { ...BASE_ANCHOR, slug: "anchor-b", homeDomain: "ANCHOR.EXAMPLE" };

  assert.throws(
    () => validateAnchorRegistry([entry1, entry2]),
    /Duplicate anchor home domain/,
  );
});

test("duplicate-domain checks cannot be bypassed by trailing-dot variants", () => {
  const entry1 = { ...BASE_ANCHOR, slug: "anchor-a", homeDomain: "anchor.example" };
  const entry2 = { ...BASE_ANCHOR, slug: "anchor-b", homeDomain: "anchor.example." };

  assert.throws(
    () => validateAnchorRegistry([entry1, entry2]),
    /Duplicate anchor home domain/,
  );
});

test("duplicate-domain checks cannot be bypassed by punycode and Unicode equivalents", () => {
  const entry1 = { ...BASE_ANCHOR, slug: "anchor-a", homeDomain: "münchen.de" };
  const entry2 = { ...BASE_ANCHOR, slug: "anchor-b", homeDomain: "xn--mnchen-3ya.de" };

  assert.throws(
    () => validateAnchorRegistry([entry1, entry2]),
    /Duplicate anchor home domain/,
  );
});

test("duplicate-domain checks cannot be bypassed by combined case, trailing dot, and punycode variants", () => {
  const entry1 = { ...BASE_ANCHOR, slug: "anchor-a", homeDomain: "münchen.de" };
  const entry2 = { ...BASE_ANCHOR, slug: "anchor-b", homeDomain: "XN--MNCHEN-3YA.DE." };

  assert.throws(
    () => validateAnchorRegistry([entry1, entry2]),
    /Duplicate anchor home domain/,
  );
});
