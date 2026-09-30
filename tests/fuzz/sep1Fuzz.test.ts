import assert from "node:assert/strict";
import test from "node:test";

import { DeterministicRandom } from "./deterministicRandom";
import { parseSep1Toml } from "@/lib/stellar/sep1";

/**
 * Issue #141: deterministic property/fuzz coverage for the untrusted SEP-1
 * TOML parser. Generated malformed, oversized, deeply nested, Unicode,
 * duplicate-field, and boundary TOML documents must produce bounded typed
 * failures (Sep1DiscoveryError) — never uncaught exceptions — and every
 * accepted document must satisfy the normalization invariants (HTTPS-only
 * endpoints, trimmed non-empty required strings, sorted/deduplicated SEP
 * detection).
 *
 * All seeds are fixed; see tests/fuzz/README.md for reproduction.
 */
const SEEDS = [20260930, 20261001];
const CASES_PER_SEED = 300;

const MAX_STRING_LENGTH = 512;
const MAX_CURRENCIES = 16;

const UNICODE_SAMPLES = [
  "é", "中", "𝄞", "\u0000", "\u0007", "\ufffd", "\ud83d\ude00",
  "\u2028", "\t", "\\", "\\\"", "\"", "'", "[", "]", "=", "#", "\n",
];

const ENDPOINT_KEYS = [
  "TRANSFER_SERVER", "TRANSFER_SERVER_SEP0024", "WEB_AUTH_ENDPOINT",
  "KYC_SERVER", "DIRECT_PAYMENT_SERVER", "ANCHOR_QUOTE_SERVER",
] as const;

const URL_FORMS = [
  "https://anchor.example/sep38",
  "https://anchor.example", // no path
  "http://anchor.example/sep38", // insecure
  "ftp://anchor.example/sep38",
  "https://", "https://anchor.example/", "//anchor.example", "",
  "https://user:pass@anchor.example/sep38",
  "https://anchor.example/sep38?query=1",
  "https://anchor.example/#frag",
  "javascript:alert(1)",
  "https://anchor.example:8443/sep38",
  "HTTPS://ANCHOR.EXAMPLE/SEP38",
];

function validDocument(overrides: Record<string, unknown> = {}): string {
  const lines = [
    "NETWORK_PASSPHRASE=\"Test SDF Network ; September 2015\"",
    "[DOCUMENTATION]",
    "ORG_NAME=\"Fuzz Anchor\"",
    "ORG_URL=\"https://fuzz.example\"",
  ];
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "object" && value !== null) continue;
    lines.push(`${key}="${String(value)}"`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "object" && value !== null && "raw" in (value as object)) {
      lines.push(`${key}=${(value as { raw: string }).raw}`);
    }
  }
  return lines.join("\n");
}

function isTypedSep1Failure(error: unknown): boolean {
  return error instanceof Error && error.name === "Sep1DiscoveryError";
}

test("generated malformed TOML fails bounded without uncaught process failures", () => {
  for (const seed of SEEDS) {
    const random = new DeterministicRandom(seed);
    for (let index = 0; index < CASES_PER_SEED; index += 1) {
      const source = generateTomlSource(random);
      try {
        const data = parseSep1Toml(source, `fuzz-${seed}-${index}.toml`);
        assertSep1Invariants(data);
      } catch (error) {
        if (!isTypedSep1Failure(error)) {
          assert.fail(
            `fuzz case failed: seed=${seed} index=${index} unexpected ` +
              `${(error as Error)?.name}: ${(error as Error)?.message}`,
          );
        }
      }
    }
  }
});

test("generated endpoint URLs either parse as HTTPS or fail typed (unsafe URLs never accepted)", () => {
  for (const seed of SEEDS) {
    const random = new DeterministicRandom(seed);
    for (let index = 0; index < CASES_PER_SEED; index += 1) {
      const key = random.pick(ENDPOINT_KEYS);
      const url = random.nextBoolean()
        ? random.pick(URL_FORMS)
        : generateUrl(random);
      const source = validDocument({ [key]: url });
      try {
        const data = parseSep1Toml(source);
        if (key in dataEndpoints(data)) {
          const value = dataEndpoints(data)[key as keyof ReturnType<typeof dataEndpoints>];
          if (value !== undefined) {
            assert.equal(new URL(value).protocol, "https:", `seed=${seed} index=${index} accepted non-HTTPS ${key}`);
          }
        }
      } catch (error) {
        if (!isTypedSep1Failure(error)) {
          assert.fail(`fuzz case failed: seed=${seed} index=${index} key=${key}`);
        }
      }
    }
  }
});

test("a corpus of structurally valid documents still parses with normalized invariants", () => {
  const source = [
    "NETWORK_PASSPHRASE=\"Test SDF Network ; September 2015\"",
    "SIGNING_KEY=\"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN\"",
    "[DOCUMENTATION]",
    "ORG_NAME=\"Corpus Anchor\"",
    "ORG_URL=\"https://corpus.example\"",
    "[[CURRENCIES]]",
    "code=\"USDC\"",
    "issuer=\"GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN\"",
    "is_asset_anchored=true",
    "anchor_asset_type=\"fiat\"",
    "[[CURRENCIES]]",
    "code=\"EURT\"",
  ].join("\n");
  const data = parseSep1Toml(source, "corpus.toml");
  assert.equal(data.organizationName, "Corpus Anchor");
  assert.equal(data.assets.length, 2);
  assert.equal(data.assets[0]!.code, "USDC");
  assert.equal(data.assets[0]!.isAssetAnchored, true);
  assert.ok(data.seps.includes(1));
});

test("duplicate TOML tables and generated duplicate currency fields never yield ambiguous evidence", () => {
  // smol-toml rejects duplicate table headers as invalid TOML.
  assert.throws(
    () => parseSep1Toml(validDocument() + "\n[DOCUMENTATION]\nORG_NAME=\"Other\""),
    (error: unknown) => isTypedSep1Failure(error),
  );

  // Identical duplicate currency entries normalize to distinct accepted rows
  // (TOML arrays keep both), and each must satisfy the per-asset invariants.
  const source = validDocument() + "\n[[CURRENCIES]]\ncode=\"USDC\"\n[[CURRENCIES]]\ncode=\"USDC\"";
  const data = parseSep1Toml(source);
  assert.equal(data.assets.length, 2);
  for (const asset of data.assets) {
    assert.equal(asset.code, "USDC");
  }
});

test("generated oversized values stay bounded at the parser boundary", () => {
  const oversized = validDocument({
    NETWORK_PASSPHRASE: "x".repeat(MAX_STRING_LENGTH * 4),
  });
  // Bounded sizes either parse or fail typed; both are acceptable outcomes.
  try {
    const data = parseSep1Toml(oversized);
    assert.ok(typeof data.networkPassphrase === "string");
  } catch (error) {
    assert.ok(isTypedSep1Failure(error));
  }
});

test("deterministic seeds are stable across the run (regression harness sanity)", () => {
  const randomA = new DeterministicRandom(20260930);
  const randomB = new DeterministicRandom(20260930);
  for (let i = 0; i < 1_000; i += 1) {
    assert.equal(randomA.nextUint32(), randomB.nextUint32());
  }
});

// --- generators -------------------------------------------------------------

function generateTomlSource(random: DeterministicRandom): string {
  const shape = random.nextInt(0, 9);
  switch (shape) {
    case 0: return "";
    case 1: return random.nextString(
      [...UNICODE_SAMPLES, "a", "A", "=", "\"", "\n"].join(""),
      0,
      MAX_STRING_LENGTH,
    );
    case 2: return validDocument({ NETWORK_PASSPHRASE: "" });
    case 3: return "NETWORK_PASSPHRASE=\"x\"\n[DOCUMENTATION]\nORG_NAME=\"\"";
    case 4: return "NETWORK_PASSPHRASE=\"x\"\nDOCUMENTATION=\"not-a-table\"";
    case 5: return validDocument({ [random.pick(ENDPOINT_KEYS)]: random.pick(URL_FORMS) });
    case 6: return generateCurrencyDocument(random);
    case 7: return `NETWORK_PASSPHRASE=${random.pick([
      "x", "\"", "\"unterminated", "true", "[]", "{}", "\"\\uZZZZ\"",
    ])}\n[DOCUMENTATION]\nORG_NAME="x"`;
    case 8: {
      // Deeply nested tables.
      const lines = ["NETWORK_PASSPHRASE=\"x\"", "[DOCUMENTATION]", "ORG_NAME=\"x\""];
      let prefix = "";
      for (let depth = 0; depth < 24; depth += 1) {
        prefix += `[a${depth}]`;
        lines.push(`"${prefix}"="deep"`);
      }
      return lines.join("\n");
    }
    default: return validDocument({
      NETWORK_PASSPHRASE: random.nextString(
        [...UNICODE_SAMPLES, "a"].join(""),
        1,
        64,
      ),
      [random.pick(ENDPOINT_KEYS)]: generateUrl(random),
    });
  }
}

function generateCurrencyDocument(random: DeterministicRandom): string {
  const lines = [validDocument()];
  const count = random.nextInt(0, MAX_CURRENCIES);
  for (let i = 0; i < count; i += 1) {
    lines.push("[[CURRENCIES]]");
    const fields = random.nextInt(1, 6);
    for (let f = 0; f < fields; f += 1) {
      const key = random.pick([
        "code", "issuer", "status", "is_asset_anchored", "anchor_asset_type",
        "anchor_asset", "unknown_field",
      ]);
      const value = random.nextBoolean()
        ? `"${random.nextString([...UNICODE_SAMPLES, "a", "1"].join(""), 0, 64).replaceAll("\n", " ")}"`
        : random.pick(["true", "false", "42", "[]", "{}", "\"\"", "null"]);
      lines.push(`${key}=${value}`);
    }
  }
  return lines.join("\n");
}

function generateUrl(random: DeterministicRandom): string {
  const scheme = random.pick(["https", "http", "ftp", "", "HTTPS", "gopher"]);
  const host = random.nextString("abc0123456789-.", 0, 24);
  const port = random.nextBoolean() ? `:${random.nextInt(0, 65535)}` : "";
  const path = random.nextBoolean() ? "/" + random.nextString("abc/", 0, 24) : "";
  const auth = random.nextBoolean(0.9) ? "" : "user:pass@";
  const junk = random.nextBoolean(0.9) ? "" : random.pick(UNICODE_SAMPLES);
  return `${scheme}://${auth}${host}${port}${path}${junk}`;
}

function dataEndpoints(data: ReturnType<typeof parseSep1Toml>): Record<string, string | undefined> {
  return data.endpoints as unknown as Record<string, string | undefined>;
}

function assertSep1Invariants(data: ReturnType<typeof parseSep1Toml>): void {
  assert.ok(data.organizationName.trim().length > 0);
  assert.ok(data.networkPassphrase.trim().length > 0);
  for (const value of Object.values(dataEndpoints(data))) {
    if (value !== undefined) {
      const url = new URL(value);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
    }
  }
  for (const asset of data.assets) {
    assert.ok(asset.code.trim().length > 0);
  }
  const uniqueSeps = new Set(data.seps);
  assert.equal(uniqueSeps.size, data.seps.length);
  for (let i = 1; i < data.seps.length; i += 1) {
    assert.ok(data.seps[i - 1]! < data.seps[i]!, "seps must be sorted ascending");
  }
}
