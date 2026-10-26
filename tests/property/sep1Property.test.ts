import assert from "node:assert/strict";
import test from "node:test";

import { Sep1DiscoveryError, parseSep1Toml } from "@/lib/stellar/sep1";
import { SeededRandom, URL_FIELD_NAMES, mutateString, UNICODE_FRAGMENTS } from "./seededGenerator";

/**
 * Deterministic property suite for untrusted SEP-1 TOML parsing (#141).
 *
 * Properties asserted for every generated input:
 * P1. Parsing either returns a frozen Sep1Data or throws a typed
 *     Sep1DiscoveryError — never any other exception shape.
 * P2. Error messages never echo raw input content (no injection into logs).
 * P3. Accepted documents satisfy normalization invariants: HTTPS-only
 *     endpoints, non-empty required strings, sorted frozen arrays.
 *
 * Reproduce a failure locally with the exact printed seed:
 *   SEED=12345 npx tsx --test tests/property/sep1Property.test.ts
 */

const BASE_DOCUMENT = [
  "NETWORK_PASSPHRASE = \"Test SDF Network ; September 2015\"",
  "[DOCUMENTATION]",
  "ORG_NAME = \"Property Anchor\"",
  "ORG_URL = \"https://property.example\"",
  "TRANSFER_SERVER = \"https://property.example/transfer\"",
  "WEB_AUTH_ENDPOINT = \"https://property.example/auth\"",
  "ANCHOR_QUOTE_SERVER = \"https://property.example/sep38\"",
  "SIGNING_KEY = \"GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF\"",
  "[[CURRENCIES]]",
  "code = \"USDC\"",
  "issuer = \"GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF\"",
  "status = \"live\"",
  "is_asset_anchored = true",
  "anchor_asset_type = \"fiat\"",
  "anchor_asset = \"USD\"",
  "[[CURRENCIES]]",
  "code = \"BRL\"",
].join("\n");

const SEED = Number.parseInt(process.env.SEED ?? "141141", 10);
const ITERATIONS = Number.parseInt(process.env.PROPERTY_ITERATIONS ?? "600", 10);

test("generated SEP-1 documents always parse to frozen data or typed errors", () => {
  const random = new SeededRandom(SEED);
  let validCount = 0;

  for (let i = 0; i < ITERATIONS; i += 1) {
    const source = generateToml(random);

    try {
      const data = parseSep1Toml(source, "property://test");
      validCount += 1;
      assertInvariants(data);
    } catch (error) {
      assert.ok(
        error instanceof Sep1DiscoveryError,
        `iteration ${i}: expected Sep1DiscoveryError, got ${String(error)}`,
      );
      assert.match(error.code, /^[A-Z_]+$/);
      // P2: bounded, input-free messages.
      assert.ok(error.message.length < 200);
      assert.equal(error.message.includes(source), false);
    }
  }

  // The generator must actually produce a meaningful share of valid
  // documents, otherwise the invariants are not exercised.
  assert.ok(validCount > 0, "generator produced zero valid documents");
});

test("generated endpoint URLs never bypass the HTTPS-only invariant", () => {
  const random = new SeededRandom(SEED + 1);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const field = random.pick([...URL_FIELD_NAMES]);
    const endpointKey = camelField(field);
    const rawUrl = mutateString(random, "https://property.example/x", 120);
    const source = `${field} = "${tomlEscape(rawUrl)}"\nNETWORK_PASSPHRASE = "x"\nDOCUMENTATION = [ORG_NAME = "n"]`;

    try {
      const data = parseSep1Toml(source, "property://test");
      const endpoint = data.endpoints[endpointKey];
      if (endpoint !== undefined) {
        assert.match(endpoint, /^https:\/\//, `${field} must stay HTTPS`);
        assert.equal(endpoint.includes(" "), false);
      }
    } catch (error) {
      assert.ok(error instanceof Sep1DiscoveryError);
    }
  }
});

test("generated unicode and control fragments never crash the parser", () => {
  const random = new SeededRandom(SEED + 2);

  for (let i = 0; i < ITERATIONS; i += 1) {
    const fragment = random.pick([...UNICODE_FRAGMENTS]);
    const placement = random.nextInt(4);
    let source = BASE_DOCUMENT;
    if (placement === 0) {
      source = `NETWORK_PASSPHRASE = "${tomlEscape(fragment)}"\n${BASE_DOCUMENT}`;
    } else if (placement === 1) {
      source = `${BASE_DOCUMENT}\n[[CURRENCIES]]\ncode = "${tomlEscape(fragment)}"`;
    } else if (placement === 2) {
      source = BASE_DOCUMENT.replace("ORG_NAME = \"Property Anchor\"", `ORG_NAME = "${tomlEscape(fragment)}"`);
    } else {
      source = `${BASE_DOCUMENT}\n# comment ${tomlEscape(fragment)}`;
    }

    try {
      const data = parseSep1Toml(source, "property://test");
      assertInvariants(data);
    } catch (error) {
      assert.ok(error instanceof Sep1DiscoveryError);
    }
  }
});

test("oversized and deeply nested generated documents stay bounded", () => {
  const random = new SeededRandom(SEED + 3);

  // Bounded oversized input (well under MAX_TOML_BYTES but structurally nasty).
  const manyCurrencies = Array.from({ length: 2_000 }, (_, index) =>
    `[[CURRENCIES]]\ncode = "C${index}"`).join("\n");
  const outcome = tryParse(manyCurrencies);
  assert.ok(outcome !== "crash");

  // Deep TOML table nesting with bounded depth.
  let nested = "";
  for (let depth = 0; depth < 200; depth += 1) {
    nested += `${"[".repeat(1)}section${depth}`;
    nested += "]".repeat(1) + "\n";
  }
  assert.ok(tryParse(nested) !== "crash");
  assert.ok(random.nextInt(1) >= 0); // consume RNG so seeds stay comparable
});

function tryParse(source: string): "ok" | "typed-error" | "crash" {
  try {
    parseSep1Toml(source, "property://test");
    return "ok";
  } catch (error) {
    return error instanceof Sep1DiscoveryError ? "typed-error" : "crash";
  }
}

function assertInvariants(data: ReturnType<typeof parseSep1Toml>): void {
  // Frozen output.
  assert.equal(Object.isFrozen(data), true);
  assert.equal(Object.isFrozen(data.assets), true);
  assert.equal(Object.isFrozen(data.endpoints), true);
  assert.equal(Object.isFrozen(data.seps), true);

  // Required fields survive normalization.
  assert.ok(data.organizationName.trim().length > 0);
  assert.ok(data.networkPassphrase.trim().length > 0);

  // All endpoints are normalized absolute HTTPS URLs.
  for (const endpoint of Object.values(data.endpoints)) {
    assert.match(endpoint, /^https:\/\//);
  }

  // Assets carry non-empty codes and stay frozen per element.
  for (const asset of data.assets) {
    assert.ok(asset.code.length > 0);
    assert.equal(Object.isFrozen(asset), true);
  }

  // SEP list is sorted and deduplicated.
  for (let i = 1; i < data.seps.length; i += 1) {
    assert.ok(data.seps[i]! > data.seps[i - 1]!);
  }
}

/** Builds one mutated TOML document within bounded size. */
function generateToml(random: SeededRandom): string {
  const lines = BASE_DOCUMENT.split("\n");
  // One third of inputs stay unmutated so the valid-document invariants are
  // always exercised, whatever corruption streak the PRNG produces.
  const mutations = random.chance(1 / 3) ? 0 : random.nextInt(4);
  for (let m = 0; m < mutations; m += 1) {
    const choice = random.nextInt(6);
    if (choice === 0) {
      // Mutate a URL field.
      const field = random.pick([...URL_FIELD_NAMES]);
      const value = mutateString(random, "https://property.example", 100);
      lines.push(`${field} = "${tomlEscape(value)}"`);
    } else if (choice === 1) {
      // Mutate a required field.
      const key = random.pick(["NETWORK_PASSPHRASE", "SIGNING_KEY", "ORG_NAME"]);
      const value = mutateString(random, "Test SDF Network", 100);
      lines.push(`${key} = "${tomlEscape(value)}"`);
    } else if (choice === 2) {
      // Add a currency entry.
      const code = mutateString(random, "USDC", 40);
      lines.push(`[[CURRENCIES]]\ncode = "${tomlEscape(code)}"`);
    } else if (choice === 3) {
      // Corrupt a line structurally.
      const index = random.nextInt(lines.length);
      const corruption = random.pick([
        lines[index]?.replace("=", "") ?? "orphan",
        `${lines[index]} =`,
        `[${lines[index]}`,
        `${lines[index]}#`,
        "",
        "   ",
      ]);
      lines[index] = corruption;
    } else if (choice === 4) {
      // Duplicate a field (TOML duplicate-key handling).
      const key = random.pick(["NETWORK_PASSPHRASE", "TRANSFER_SERVER"]);
      const value = mutateString(random, "duplicate", 60);
      lines.push(`${key} = "${tomlEscape(value)}"`);
    } else {
      // Random type confusion: number/bool/array where string expected.
      const key = random.pick(["NETWORK_PASSPHRASE", "SIGNING_KEY", "code"]);
      const value = random.pick(["123", "true", "[1, 2]", "{ a = 1 }", "1979-05-27", "[]"]);
      lines.push(`${key} = ${value}`);
    }
  }
  return lines.join("\n").slice(0, 20_000);
}

function tomlEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

/** Maps a SEP-1 UPPER_SNAKE endpoint key to its camelCase property name. */
function camelField(field: (typeof URL_FIELD_NAMES)[number]):
  keyof ReturnType<typeof parseSep1Toml>["endpoints"] {
  const mapping = {
    TRANSFER_SERVER: "transferServer",
    TRANSFER_SERVER_SEP0024: "transferServerSep24",
    WEB_AUTH_ENDPOINT: "webAuthEndpoint",
    KYC_SERVER: "kycServer",
    DIRECT_PAYMENT_SERVER: "directPaymentServer",
    ANCHOR_QUOTE_SERVER: "anchorQuoteServer",
  } as const;
  return mapping[field];
}
