import assert from "node:assert/strict";
import test from "node:test";

import { SEPS } from "@/constants/seps";
import { transferCapable } from "@/lib/stellar/anchors";
import {
  buildSep1TomlUrl,
  detectSupportedSeps,
  fetchSep1Toml,
  normalizeSeps,
  parseSep1Toml,
  Sep1DiscoveryError,
} from "@/lib/stellar/sep1";

test("normalizeSeps deduplicates, filters, and sorts SEP numbers", () => {
  assert.deepEqual(normalizeSeps([24, 1, 24, 38, 999, 6]), [1, 6, 24, 38]);
});

test("detectSupportedSeps maps documented SEP-1 endpoint fields", () => {
  assert.deepEqual(
    detectSupportedSeps({
      transferServer: "https://anchor.example/sep6",
      transferServerSep24: "https://anchor.example/sep24",
      webAuthEndpoint: "https://anchor.example/auth",
      directPaymentServer: "https://anchor.example/sep31",
      anchorQuoteServer: "https://anchor.example/sep38",
    }),
    [1, 6, 10, 24, 31, 38],
  );
});

test("transferCapable recognizes SEP-6, SEP-24, or SEP-31", () => {
  assert.equal(transferCapable([SEPS.SEP_1, SEPS.SEP_10]), false);
  assert.equal(transferCapable([SEPS.SEP_1, SEPS.SEP_24]), true);
});

test("buildSep1TomlUrl rejects malformed home domains", () => {
  assert.throws(
    () => buildSep1TomlUrl("https://anchor.example/path"),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "INVALID_HOME_DOMAIN",
  );
});

test("parseSep1Toml returns a typed invalid-TOML error", () => {
  assert.throws(
    () => parseSep1Toml("invalid = [", "https://anchor.example/stellar.toml"),
    (error) =>
      error instanceof Sep1DiscoveryError && error.code === "INVALID_TOML",
  );
});

test("parseSep1Toml reports missing identity data", () => {
  assert.throws(
    () =>
      parseSep1Toml(
        'NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"',
        "https://anchor.example/stellar.toml",
      ),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "MISSING_REQUIRED_DATA",
  );
});

test("fetchSep1Toml returns a typed non-2xx error without reading the body", async () => {
  await assert.rejects(
    fetchSep1Toml("anchor.example", {
      fetcher: async () => new Response("sensitive body", { status: 503 }),
    }),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "HTTP_FAILURE" &&
      error.status === 503,
  );
});
