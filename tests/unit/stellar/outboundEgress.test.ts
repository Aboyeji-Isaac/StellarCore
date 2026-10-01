import assert from "node:assert/strict";
import test from "node:test";

import {
  approveResolvedAddresses,
  createEgressFetch,
  EgressPolicyError,
  isPublicAddress,
  type ResolvedAddress,
} from "@/lib/stellar/outboundEgress";

const denied = [
  "0.0.0.0",
  "10.0.0.1",
  "100.64.0.1",
  "127.0.0.1",
  "169.254.169.254",
  "172.16.0.1",
  "192.168.1.1",
  "192.0.2.1",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "::",
  "::1",
  "::ffff:127.0.0.1",
  "64:ff9b:1::1",
  "100::1",
  "2001:db8::1",
  "fc00::1",
  "fe80::1",
  "ff00::1",
];

test("address policy rejects special-purpose IPv4 and IPv6 ranges", () => {
  for (const address of denied) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("address policy fails closed for mixed public and private answers", () => {
  assert.throws(
    () =>
      approveResolvedAddresses("anchor.example", [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]),
    (error) =>
      error instanceof EgressPolicyError && error.code === "MIXED_ADDRESSES",
  );
});

test("empty and failed DNS resolution fail closed", async () => {
  const empty = createEgressFetch({ resolver: async () => [] });
  await assert.rejects(
    empty("https://anchor.example/"),
    (error) => error instanceof EgressPolicyError && error.code === "NO_ADDRESSES",
  );

  const failed = createEgressFetch({
    resolver: async () => {
      throw new Error("synthetic DNS failure");
    },
  });
  await assert.rejects(
    failed("https://anchor.example/"),
    (error) => error instanceof EgressPolicyError && error.code === "DNS_FAILURE",
  );
});

test("transport pins the validated answer and does not resolve again", async () => {
  let resolutionCalls = 0;
  let connectedAddress: ResolvedAddress | undefined;
  const decisions: unknown[] = [];
  const fetcher = createEgressFetch({
    resolver: async () => {
      resolutionCalls += 1;
      return resolutionCalls === 1
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    request: async (url, _init, address) => {
      assert.equal(url.hostname, "anchor.example");
      connectedAddress = address;
      return new Response("ok");
    },
    logger: (decision) => decisions.push(decision),
  });

  const response = await fetcher("https://anchor.example/.well-known/stellar.toml");
  assert.equal(await response.text(), "ok");
  assert.equal(resolutionCalls, 1);
  assert.deepEqual(connectedAddress, { address: "8.8.8.8", family: 4 });
  assert.equal(decisions.length, 1);
});

test("policy logging is bounded and excludes paths, queries, and credentials", async () => {
  const decisions: Array<Record<string, unknown>> = [];
  const fetcher = createEgressFetch({
    resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async () => new Response("ok"),
    logger: (decision) => decisions.push(decision),
  });
  await fetcher("https://anchor.example/private?token=secret", {
    headers: { Authorization: "Bearer secret" },
  });

  const serialized = JSON.stringify(decisions);
  assert.doesNotMatch(serialized, /private|token|secret|Authorization/);
  assert.match(serialized, /anchor\.example/);
});


test("egress resolves and requests the canonical hostname", async () => {
  const seen: string[] = [];
  const fetcher = createEgressFetch({
    resolver: async (hostname) => {
      seen.push(hostname);
      return [{ address: "8.8.8.8", family: 4 }];
    },
    request: async (url) => {
      seen.push(url.hostname);
      return new Response("ok");
    },
    logger: () => {},
  });

  await fetcher("https://MÜNCHEN.DE./path");
  assert.deepEqual(seen, ["xn--mnchen-3ya.de", "xn--mnchen-3ya.de"]);
});
