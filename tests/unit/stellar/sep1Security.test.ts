import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSep1Toml,
  parseSep1Toml,
  Sep1DiscoveryError,
} from "@/lib/stellar/sep1";

const MINIMAL_TOML = `
NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"

[DOCUMENTATION]
ORG_NAME = "Example Anchor"
`;

test("fetchSep1Toml rejects redirects at the network boundary", async () => {
  let redirectMode: RequestRedirect | undefined;

  const fetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    redirectMode = init?.redirect;
    return Promise.resolve(new Response(MINIMAL_TOML));
  }) as typeof fetch;

  await fetchSep1Toml("anchor.example", { fetcher });

  assert.equal(redirectMode, "error");
});

test("fetchSep1Toml rejects an oversized streamed body", async () => {
  await assert.rejects(
    fetchSep1Toml("anchor.example", {
      fetcher: async () => new Response("x".repeat(100_001)),
    }),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "RESPONSE_TOO_LARGE",
  );
});

test("normalized SEP-1 structures are frozen", () => {
  const data = parseSep1Toml(`${MINIMAL_TOML}\nTRANSFER_SERVER = "https://anchor.example/sep6"`);

  assert.equal(Object.isFrozen(data), true);
  assert.equal(Object.isFrozen(data.seps), true);
  assert.equal(Object.isFrozen(data.endpoints), true);
  assert.equal(Object.isFrozen(data.assets), true);
});
