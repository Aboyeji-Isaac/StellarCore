import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveIdentityKey,
  resolveClientIdentity,
  UNKNOWN_IDENTITY,
} from "@/lib/ratelimit/identity";

const HEADER = "x-vercel-forwarded-for";

function identityOf(value: string | null, extra: Record<string, string> = {}) {
  const headers = new Headers(extra);
  if (value !== null) headers.set(HEADER, value);
  return resolveClientIdentity(headers, HEADER);
}

test("valid IPv4 and IPv4-mapped IPv6 resolve to the IPv4 identity", () => {
  assert.deepEqual(identityOf("203.0.113.7"), { kind: "ip4", value: "203.0.113.7" });
  assert.deepEqual(identityOf("::ffff:203.0.113.7"), {
    kind: "ip4",
    value: "203.0.113.7",
  });
});

test("only the last list entry, added by the trusted proxy, is used", () => {
  assert.deepEqual(identityOf("6.6.6.6, 198.51.100.2"), {
    kind: "ip4",
    value: "198.51.100.2",
  });
});

test("IPv6 clients are bucketed by /64", () => {
  const a = identityOf("2001:db8::1");
  const b = identityOf("2001:db8:0:0:ffff::9");
  const c = identityOf("2001:db8:0:1::1");

  assert.equal(a.kind, "ip6");
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("malformed, oversized and missing values share the unknown identity", () => {
  for (const value of [
    null,
    "",
    "not-an-ip",
    "999.1.1.1",
    "1.2.3.4.5",
    "01.2.3.4",
    "2001:db8::zz",
    ":1:2:3:4:5:6:7",
    "1::2::3",
    "a".repeat(300),
  ]) {
    assert.deepEqual(identityOf(value), UNKNOWN_IDENTITY, String(value));
  }
});

test("untrusted forwarding headers are ignored", () => {
  const identity = identityOf(null, {
    "x-forwarded-for": "203.0.113.9",
    "x-real-ip": "203.0.113.9",
    forwarded: "for=203.0.113.9",
  });
  assert.deepEqual(identity, UNKNOWN_IDENTITY);
});

test("derived keys are short, stable, keyed and do not contain the IP", async () => {
  const identity = identityOf("203.0.113.7");
  const one = await deriveIdentityKey(identity, "secret-one-secret-one");
  const again = await deriveIdentityKey(identity, "secret-one-secret-one");
  const other = await deriveIdentityKey(identity, "secret-two-secret-two");

  assert.equal(one, again);
  assert.notEqual(one, other);
  assert.match(one, /^[0-9a-f]{16}$/);
  assert.equal(one.includes("203"), false);
});
