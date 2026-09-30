import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeHostname,
  isValidHostname,
  validateCanonicalHostname,
  HostnameValidationError,
} from "@/lib/stellar/hostname";

test("canonicalizes case variants to lowercase ASCII", () => {
  const resultUpper = canonicalizeHostname("EXAMPLE.COM");
  assert.equal(resultUpper.ok, true);
  if (resultUpper.ok) {
    assert.equal(resultUpper.hostname, "example.com");
  }

  const resultMixed = canonicalizeHostname("MgXAnchor.MoneyGram.COM");
  assert.equal(resultMixed.ok, true);
  if (resultMixed.ok) {
    assert.equal(resultMixed.hostname, "mgxanchor.moneygram.com");
  }
});

test("strips a single trailing dot to produce canonical form", () => {
  const result = canonicalizeHostname("example.com.");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.hostname, "example.com");
  }

  const resultUpper = canonicalizeHostname("EXAMPLE.COM.");
  assert.equal(resultUpper.ok, true);
  if (resultUpper.ok) {
    assert.equal(resultUpper.hostname, "example.com");
  }
});

test("resolves Unicode IDN and punycode equivalents to the same canonical form", () => {
  const unicodeResult = canonicalizeHostname("münchen.de");
  const punycodeResult = canonicalizeHostname("xn--mnchen-3ya.de");
  const upperPunycode = canonicalizeHostname("XN--MNCHEN-3YA.DE.");

  assert.equal(unicodeResult.ok, true);
  assert.equal(punycodeResult.ok, true);
  assert.equal(upperPunycode.ok, true);

  if (unicodeResult.ok && punycodeResult.ok && upperPunycode.ok) {
    assert.equal(unicodeResult.hostname, "xn--mnchen-3ya.de");
    assert.equal(punycodeResult.hostname, "xn--mnchen-3ya.de");
    assert.equal(upperPunycode.hostname, "xn--mnchen-3ya.de");
  }
});

test("normalizes composed (NFC) and decomposed (NFD) Unicode representations to identical canonical form", () => {
  // NFC: \u00e9
  const nfc = "caf\u00e9.com";
  // NFD: e + combining acute accent (\u0065\u0301)
  const nfd = "cafe\u0301.com";

  const nfcResult = canonicalizeHostname(nfc);
  const nfdResult = canonicalizeHostname(nfd);

  assert.equal(nfcResult.ok, true);
  assert.equal(nfdResult.ok, true);

  if (nfcResult.ok && nfdResult.ok) {
    assert.equal(nfcResult.hostname, "xn--caf-dma.com");
    assert.equal(nfdResult.hostname, "xn--caf-dma.com");
  }
});

test("rejects malformed punycode", () => {
  const invalidPunycodeSamples = [
    "xn--",
    "xn--.com",
    "xn--0.com",
    "xn--apple.com", // ASCII-only payload in xn-- is invalid
    "xn--notvalidpunycode!.com",
    "xn--a-yba.com",
  ];

  for (const sample of invalidPunycodeSamples) {
    const result = canonicalizeHostname(sample);
    assert.equal(result.ok, false, `Expected ${sample} to be rejected`);
    if (!result.ok) {
      assert.ok(
        result.reason === "INVALID_PUNYCODE" ||
          result.reason === "INVALID_IDNA" ||
          result.reason === "DISALLOWED_CHARACTERS",
        `Unexpected reason ${result.reason} for ${sample}`,
      );
    }
  }
});

test("rejects invalid IDN labels and disallowed code points", () => {
  const disallowedSamples = [
    "☕.com", // emoji
    "❤️.org", // emoji
    "\u0301foo.com", // label starting with combining mark
  ];

  for (const sample of disallowedSamples) {
    const result = canonicalizeHostname(sample);
    assert.equal(result.ok, false, `Expected ${sample} to be rejected`);
    if (!result.ok) {
      assert.ok(
        result.reason === "DISALLOWED_CODEPOINT" ||
          result.reason === "INVALID_IDNA",
        `Unexpected reason ${result.reason} for ${sample}`,
      );
    }
  }
});

test("rejects mixed-script confusable labels", () => {
  // Cyrillic 'а' (U+0430) mixed with Latin 'pple.com'
  const cyrillicMixed = "\u0430pple.com";
  const cyrillicMixedResult = canonicalizeHostname(cyrillicMixed);
  assert.equal(cyrillicMixedResult.ok, false);
  if (!cyrillicMixedResult.ok) {
    assert.equal(cyrillicMixedResult.reason, "MIXED_SCRIPT_CONFUSABLE");
  }

  // Punycode of the above mixed-script label
  const punycodeMixed = "xn--pple-43d.com";
  const punycodeMixedResult = canonicalizeHostname(punycodeMixed);
  assert.equal(punycodeMixedResult.ok, false);
  if (!punycodeMixedResult.ok) {
    assert.equal(punycodeMixedResult.reason, "MIXED_SCRIPT_CONFUSABLE");
  }

  // Greek 'ο' (U+03BF) mixed with Latin 'nline.com'
  const greekMixed = "\u03BFnline.com";
  const greekMixedResult = canonicalizeHostname(greekMixed);
  assert.equal(greekMixedResult.ok, false);
  if (!greekMixedResult.ok) {
    assert.equal(greekMixedResult.reason, "MIXED_SCRIPT_CONFUSABLE");
  }
});

test("rejects whole-script homoglyphic Latin lookalikes", () => {
  // Cyrillic letters that are exact homoglyphs of 'scope':
  // ѕ (U+0455), с (U+0441), о (U+043E), р (U+0440), е (U+0435)
  const cyrillicScope = "\u0455\u0441\u043E\u0440\u0435.com";
  const result = canonicalizeHostname(cyrillicScope);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "CONFUSABLE_HOMOGLYPH");
  }
});

test("rejects full-width characters rather than silently normalizing", () => {
  // full-width "example.com" (\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45\uff0e\uff43\uff4f\uff4d)
  const fullwidth = "\uff45\uff58\uff41\uff4d\uff50\uff4c\uff45\uff0e\uff43\uff4f\uff4d";
  const result = canonicalizeHostname(fullwidth);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "FULLWIDTH_DISALLOWED");
  }
});

test("enforces label length limits (63 bytes allowed, 64 bytes rejected)", () => {
  const label63 = "a".repeat(63) + ".com";
  const result63 = canonicalizeHostname(label63);
  assert.equal(result63.ok, true);
  if (result63.ok) {
    assert.equal(result63.hostname, label63);
  }

  const label64 = "a".repeat(64) + ".com";
  const result64 = canonicalizeHostname(label64);
  assert.equal(result64.ok, false);
  if (!result64.ok) {
    assert.equal(result64.reason, "LABEL_TOO_LONG");
  }
});

test("enforces total hostname length limits (253 bytes allowed, 254 bytes rejected)", () => {
  // 3 labels of 63 chars + 1 label of 58 chars + 3 dots = 63+63+63+58 + 3 = 250 chars + ".com" = 254
  // Let's create exact lengths:
  // 63 + 1 + 63 + 1 + 63 + 1 + 57 + 1 + 3 ("com") = 253 bytes total
  const part63 = "a".repeat(63);
  const part57 = "a".repeat(57);
  const name253 = `${part63}.${part63}.${part63}.${part57}.com`;
  assert.equal(name253.length, 253);

  const result253 = canonicalizeHostname(name253);
  assert.equal(result253.ok, true);
  if (result253.ok) {
    assert.equal(result253.hostname, name253);
  }

  // 254 bytes: change part57 to part58
  const part58 = "a".repeat(58);
  const name254 = `${part63}.${part63}.${part63}.${part58}.com`;
  assert.equal(name254.length, 254);

  const result254 = canonicalizeHostname(name254);
  assert.equal(result254.ok, false);
  if (!result254.ok) {
    assert.equal(result254.reason, "NAME_TOO_LONG");
  }
});

test("rejects leading dots, double dots, and multiple trailing dots", () => {
  const leading = canonicalizeHostname(".example.com");
  assert.equal(leading.ok, false);
  if (!leading.ok) assert.equal(leading.reason, "LEADING_DOT");

  const doubleDots = canonicalizeHostname("example..com");
  assert.equal(doubleDots.ok, false);
  if (!doubleDots.ok) assert.equal(doubleDots.reason, "EMPTY_LABEL");

  const multiTrailing = canonicalizeHostname("example.com..");
  assert.equal(multiTrailing.ok, false);
  if (!multiTrailing.ok) assert.equal(multiTrailing.reason, "MULTIPLE_TRAILING_DOTS");
});

test("rejects empty input and whitespace", () => {
  assert.equal(canonicalizeHostname("").ok, false);
  assert.equal(canonicalizeHostname("   ").ok, false);
  assert.equal(canonicalizeHostname(" example.com").ok, false);
  assert.equal(canonicalizeHostname("example.com ").ok, false);
  assert.equal(canonicalizeHostname("exam ple.com").ok, false);
});

test("rejects IP literals", () => {
  const ipv4 = canonicalizeHostname("127.0.0.1");
  assert.equal(ipv4.ok, false);
  if (!ipv4.ok) assert.equal(ipv4.reason, "IP_LITERAL");

  const ipv6 = canonicalizeHostname("::1");
  assert.equal(ipv6.ok, false);
  if (!ipv6.ok) assert.equal(ipv6.reason, "IP_LITERAL");

  const bracketedIpv6 = canonicalizeHostname("[::1]");
  assert.equal(bracketedIpv6.ok, false);
  if (!bracketedIpv6.ok) assert.equal(bracketedIpv6.reason, "IP_LITERAL");
});

test("rejects ports, paths, query strings, and userinfo", () => {
  const withPort = canonicalizeHostname("example.com:443");
  assert.equal(withPort.ok, false);
  if (!withPort.ok) assert.equal(withPort.reason, "PORT_OR_PATH_OR_USERINFO");

  const withPath = canonicalizeHostname("example.com/path");
  assert.equal(withPath.ok, false);
  if (!withPath.ok) assert.equal(withPath.reason, "PORT_OR_PATH_OR_USERINFO");

  const withUser = canonicalizeHostname("user@example.com");
  assert.equal(withUser.ok, false);
  if (!withUser.ok) assert.equal(withUser.reason, "PORT_OR_PATH_OR_USERINFO");
});

test("rejects underscores and label hyphen violations", () => {
  const withUnderscore = canonicalizeHostname("anchor_api.example.com");
  assert.equal(withUnderscore.ok, false);
  if (!withUnderscore.ok) assert.equal(withUnderscore.reason, "UNDERSCORE_DISALLOWED");

  const leadingHyphen = canonicalizeHostname("-anchor.example.com");
  assert.equal(leadingHyphen.ok, false);
  if (!leadingHyphen.ok) assert.equal(leadingHyphen.reason, "LABEL_HYPHEN_VIOLATION");

  const trailingHyphen = canonicalizeHostname("anchor-.example.com");
  assert.equal(trailingHyphen.ok, false);
  if (!trailingHyphen.ok) assert.equal(trailingHyphen.reason, "LABEL_HYPHEN_VIOLATION");
});

test("preserves existing valid ASCII domains unchanged", () => {
  const existingDomains = [
    "mgxanchor.moneygram.com",
    "cowrie.exchange",
    "zeam.money",
    "anchor.example",
    "stellar.org",
  ];

  for (const domain of existingDomains) {
    const result = canonicalizeHostname(domain);
    assert.equal(result.ok, true, `Expected ${domain} to be valid`);
    if (result.ok) {
      assert.equal(result.hostname, domain);
    }
    assert.equal(isValidHostname(domain), true);
    assert.equal(validateCanonicalHostname(domain), domain);
  }
});

test("validateCanonicalHostname throws typed HostnameValidationError on invalid input", () => {
  assert.throws(
    () => validateCanonicalHostname("invalid..domain"),
    (err) =>
      err instanceof HostnameValidationError &&
      err.code === "EMPTY_LABEL" &&
      err.reason === "EMPTY_LABEL",
  );
});
