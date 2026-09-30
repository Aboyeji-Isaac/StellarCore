import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeSepEndpoint,
  areSepEndpointsEquivalent,
  SepEndpointValidationError,
} from "../lib/stellar/sepEndpointCanonicalization";
import { parseSep1Toml, Sep1DiscoveryError } from "../lib/stellar/sep1";

describe("SEP Endpoint Canonicalization & Trust Boundaries (Issue #239)", () => {
  describe("Canonical Equivalence", () => {
    it("compares equivalent endpoints as identical", () => {
      const variants = [
        "https://api.anchor.example/sep24",
        "https://api.anchor.example:443/sep24",
        "https://API.ANCHOR.EXAMPLE/sep24/",
        "https://api.anchor.example./sep24",
        "https://api.anchor.example//sep24///",
      ];

      const expected = "https://api.anchor.example/sep24";

      for (const variant of variants) {
        const canonical = canonicalizeSepEndpoint(variant);
        assert.strictEqual(
          canonical,
          expected,
          `Variant "${variant}" must canonicalize to "${expected}"`,
        );
      }

      assert.strictEqual(
        areSepEndpointsEquivalent(
          "https://example.com:443/api/",
          "https://EXAMPLE.COM/api",
        ),
        true,
      );
    });

    it("normalizes root origins consistently", () => {
      assert.strictEqual(
        canonicalizeSepEndpoint("https://example.com/"),
        "https://example.com",
      );
      assert.strictEqual(
        canonicalizeSepEndpoint("https://example.com"),
        "https://example.com",
      );
      assert.strictEqual(
        canonicalizeSepEndpoint("https://example.com:443/"),
        "https://example.com",
      );
    });

    it("sorts query parameters deterministically", () => {
      const url1 = "https://anchor.com/api?z=1&a=2&m=3";
      const url2 = "https://anchor.com/api?a=2&m=3&z=1";
      assert.strictEqual(
        canonicalizeSepEndpoint(url1),
        canonicalizeSepEndpoint(url2),
      );
      assert.strictEqual(
        canonicalizeSepEndpoint(url1),
        "https://anchor.com/api?a=2&m=3&z=1",
      );
    });
  });

  describe("Security Boundaries & Adversarial Input Rejection", () => {
    it("rejects non-HTTPS schemes", () => {
      const disallowed = [
        "http://anchor.com/api",
        "ftp://anchor.com/api",
        "javascript:alert(1)",
        "data:text/plain;base64,SGVsbG8=",
      ];

      for (const url of disallowed) {
        assert.throws(
          () => canonicalizeSepEndpoint(url),
          (err: Error) =>
            err instanceof SepEndpointValidationError &&
            err.code === "SCHEME_NOT_HTTPS",
        );
      }
    });

    it("rejects userinfo to prevent credential leakage and spoofing", () => {
      const userinfoUrls = [
        "https://admin:secret@anchor.com/api",
        "https://user@anchor.com/api",
      ];

      for (const url of userinfoUrls) {
        assert.throws(
          () => canonicalizeSepEndpoint(url),
          (err: Error) =>
            err instanceof SepEndpointValidationError &&
            err.code === "USERINFO_DISALLOWED",
        );
      }
    });

    it("rejects URL fragments", () => {
      const fragmentUrls = [
        "https://anchor.com/api#fragment",
        "https://anchor.com/api#bypass",
      ];

      for (const url of fragmentUrls) {
        assert.throws(
          () => canonicalizeSepEndpoint(url),
          (err: Error) =>
            err instanceof SepEndpointValidationError &&
            err.code === "FRAGMENT_DISALLOWED",
        );
      }
    });

    it("rejects non-standard ports in production mode", () => {
      const invalidPortUrls = [
        "https://anchor.com:80/api",
        "https://anchor.com:8080/api",
        "https://anchor.com:8443/api",
      ];

      for (const url of invalidPortUrls) {
        assert.throws(
          () => canonicalizeSepEndpoint(url),
          (err: Error) =>
            err instanceof SepEndpointValidationError &&
            err.code === "INVALID_PORT",
        );
      }
    });

    it("allows localhost ports only when explicitly configured for test environments", () => {
      const localUrl = "https://localhost:3001/api";
      assert.throws(
        () => canonicalizeSepEndpoint(localUrl),
        (err: Error) =>
          err instanceof SepEndpointValidationError &&
          err.code === "INVALID_PORT",
      );

      const allowed = canonicalizeSepEndpoint(localUrl, {
        allowLocalhostPorts: true,
      });
      assert.strictEqual(allowed, "https://localhost:3001/api");
    });

    it("rejects path traversal attempting to escape root", () => {
      const traversalUrls = [
        "https://anchor.com/../secret",
        "https://anchor.com/a/../../escape",
      ];

      for (const url of traversalUrls) {
        assert.throws(
          () => canonicalizeSepEndpoint(url),
          (err: Error) =>
            err instanceof SepEndpointValidationError &&
            err.code === "INVALID_PATH",
        );
      }
    });
  });

  describe("Integration with SEP-1 TOML Discovery", () => {
    it("canonicalizes endpoints parsed from stellar.toml", () => {
      const toml = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER = "https://EXAMPLE.COM:443/transfer//"
WEB_AUTH_ENDPOINT = "https://auth.example.com./auth"
ANCHOR_QUOTE_SERVER = "https://quote.example.com/sep38/"

[DOCUMENTATION]
ORG_NAME = "Test Anchor"
ORG_URL = "https://example.com:443/"
`;

      const parsed = parseSep1Toml(toml);
      assert.strictEqual(
        parsed.endpoints.transferServer,
        "https://example.com/transfer",
      );
      assert.strictEqual(
        parsed.endpoints.webAuthEndpoint,
        "https://auth.example.com/auth",
      );
      assert.strictEqual(
        parsed.endpoints.anchorQuoteServer,
        "https://quote.example.com/sep38",
      );
      assert.strictEqual(parsed.organizationUrl, "https://example.com");
    });

    it("rejects malicious endpoints in stellar.toml", () => {
      const maliciousToml = `
NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
TRANSFER_SERVER = "https://attacker:pwned@example.com/transfer"

[DOCUMENTATION]
ORG_NAME = "Test Anchor"
`;

      assert.throws(
        () => parseSep1Toml(maliciousToml),
        (err: Error) =>
          err instanceof Sep1DiscoveryError && err.code === "INVALID_DATA",
      );
    });
  });
});
