import assert from "node:assert/strict";
import test from "node:test";

import { auditCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import {
  assertStellarCoreConfiguration,
  auditStellarCoreConfiguration,
  StellarCoreConfigurationAuditError,
  type ConfigurationAuditIssueCode,
  type StellarCoreConfigurationInput,
} from "@/lib/config/stellarCoreConfiguration";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";
import type { SourceAuthorityRegistryEntry } from "@/types/sourceAuthority";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const AUTHORITY_A = Object.freeze({
  authorityId: "auth-0001",
  displayName: "Anchor A Operator",
  configurationVersion: 1,
}) satisfies SourceAuthorityRegistryEntry;

const AUTHORITY_B = Object.freeze({
  authorityId: "auth-0002",
  displayName: "Anchor B Operator",
  configurationVersion: 3,
}) satisfies SourceAuthorityRegistryEntry;

const ANCHOR_A = Object.freeze({
  slug: "anchor-a",
  name: "Anchor A",
  homeDomain: "anchor-a.example.com",
}) satisfies AnchorRegistryEntry;

const ANCHOR_B = Object.freeze({
  slug: "anchor-b",
  name: "Anchor B",
  homeDomain: "anchor-b.example.com",
}) satisfies AnchorRegistryEntry;

const BRL_CORRIDOR = Object.freeze({
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
}) satisfies CorridorRegistryEntry;

const USD_CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
}) satisfies CorridorRegistryEntry;

test("current checked-in configuration passes the offline audit", () => {
  assert.deepEqual(auditCurrentStellarCoreConfiguration(), {
    ok: true,
    issues: [],
  });
});

test("missing reviewed-source anchor reference fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { anchorSlug: "missing-anchor" })],
  }));

  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("SOURCE_ANCHOR_NOT_FOUND"));
});

test("missing reviewed-source corridor reference fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { corridorSlug: "missing-corridor" })],
  }));

  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("SOURCE_CORRIDOR_NOT_FOUND"));
});

test("missing anchor and corridor membership fails", () => {
  const result = audit(configuration({ mappings: [] }));

  assert.deepEqual(codes(result), ["SOURCE_MEMBERSHIP_NOT_CONFIGURED"]);
});

test("duplicate reviewed candidate for one anchor and corridor fails", () => {
  const candidate = source(BRL_CORRIDOR);
  const result = audit(configuration({ sources: [candidate, candidate] }));

  assert.ok(codes(result).includes("DUPLICATE_REVIEWED_SOURCE"));
});

test("same anchor on different valid corridors remains allowed", () => {
  const mappings = [mapping(ANCHOR_A.slug, [BRL_CORRIDOR.slug, USD_CORRIDOR.slug])];
  const result = audit(configuration({
    corridors: [BRL_CORRIDOR, USD_CORRIDOR],
    mappings,
    sources: [source(BRL_CORRIDOR), source(USD_CORRIDOR)],
  }));

  assert.equal(result.ok, true);
});

test("distinct anchors on one valid corridor remain allowed", () => {
  const result = audit(configuration({
    anchors: [ANCHOR_A, ANCHOR_B],
    mappings: [
      mapping(ANCHOR_A.slug, [BRL_CORRIDOR.slug]),
      mapping(ANCHOR_B.slug, [BRL_CORRIDOR.slug]),
    ],
    sources: [
      source(BRL_CORRIDOR),
      source(BRL_CORRIDOR, { anchorSlug: ANCHOR_B.slug }),
    ],
  }));

  assert.equal(result.ok, true);
});

test("non-canonical corridor slug fails", () => {
  const corridor = Object.freeze({ ...BRL_CORRIDOR, slug: "brl-route" });
  const result = audit(configuration({
    corridors: [corridor],
    mappings: [mapping(ANCHOR_A.slug, [corridor.slug])],
    sources: [source(corridor)],
  }));

  assert.ok(codes(result).includes("NON_CANONICAL_CORRIDOR_SLUG"));
});

test("duplicate semantic corridor tuple under different slugs fails", () => {
  const duplicate = Object.freeze({ ...BRL_CORRIDOR, slug: "duplicate-route" });
  const result = audit(configuration({
    corridors: [BRL_CORRIDOR, duplicate],
  }));

  assert.ok(codes(result).includes("DUPLICATE_CORRIDOR_IDENTITY"));
});

test("sell asset code mismatch fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { sellAsset: `stellar:EURC:${ISSUER}` })],
  }));

  assert.ok(codes(result).includes("SOURCE_SELL_ASSET_CODE_MISMATCH"));
});

test("buy asset code mismatch fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { buyAsset: "iso4217:USD" })],
  }));

  assert.ok(codes(result).includes("SOURCE_BUY_ASSET_CODE_MISMATCH"));
});

test("destination country mismatch fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { countryCode: "US" })],
  }));

  assert.ok(codes(result).includes("SOURCE_DESTINATION_COUNTRY_MISMATCH"));
});

test("missing or malformed Stellar issuer fails", () => {
  const missing = audit(configuration({
    sources: [source(BRL_CORRIDOR, { sellAsset: "stellar:USDC" })],
  }));
  const malformed = audit(configuration({
    sources: [source(BRL_CORRIDOR, { sellAsset: "stellar:USDC:GINVALID" })],
  }));

  assert.ok(codes(missing).includes("SOURCE_SELL_ASSET_INVALID"));
  assert.ok(codes(malformed).includes("SOURCE_SELL_ASSET_INVALID"));
});

test("invalid or non-ISO destination asset form fails", () => {
  const invalid = audit(configuration({
    sources: [source(BRL_CORRIDOR, { buyAsset: "iso4217:REAL" })],
  }));
  const nonIso = audit(configuration({
    sources: [source(BRL_CORRIDOR, { buyAsset: "stellar:XLM" })],
  }));

  assert.ok(codes(invalid).includes("SOURCE_BUY_ASSET_INVALID"));
  assert.ok(codes(nonIso).includes("SOURCE_BUY_ASSET_FORM_INVALID"));
});

test("zero sell amount fails", () => {
  const result = audit(configuration({ sources: [source(BRL_CORRIDOR, { sellAmount: "0" })] }));
  assert.ok(codes(result).includes("SOURCE_SELL_AMOUNT_NOT_POSITIVE"));
});

test("negative sell amount fails", () => {
  const result = audit(configuration({ sources: [source(BRL_CORRIDOR, { sellAmount: "-1" })] }));
  assert.ok(codes(result).includes("SOURCE_SELL_AMOUNT_INVALID"));
});

test("malformed sell amount fails", () => {
  const result = audit(configuration({ sources: [source(BRL_CORRIDOR, { sellAmount: "1e3" })] }));
  assert.ok(codes(result).includes("SOURCE_SELL_AMOUNT_INVALID"));
});

test("Decimal(38,18)-overflowing sell amount fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { sellAmount: "100000000000000000000" })],
  }));
  assert.ok(codes(result).includes("SOURCE_SELL_AMOUNT_INVALID"));
});

test("invalid optional request field fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { buyDeliveryMethod: "unsafe\nvalue" })],
  }));
  assert.ok(codes(result).includes("SOURCE_OPTIONAL_FIELD_INVALID"));
});

test("unsupported indicative context fails", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { context: "sep24" as never })],
  }));
  assert.ok(codes(result).includes("SOURCE_CONTEXT_INVALID"));
});

test("missing, malformed, and unreviewed source authority ids fail", () => {
  const missing = audit(configuration({
    sources: [source(BRL_CORRIDOR, { authorityId: "" })],
  }));
  const malformed = audit(configuration({
    sources: [source(BRL_CORRIDOR, { authorityId: "zeam" })],
  }));
  const unreviewed = audit(configuration({
    sources: [source(BRL_CORRIDOR, { authorityId: "auth-0099" })],
  }));

  assert.deepEqual(codes(missing), ["SOURCE_AUTHORITY_MISSING"]);
  assert.deepEqual(codes(malformed), ["SOURCE_AUTHORITY_MALFORMED"]);
  assert.deepEqual(codes(unreviewed), ["SOURCE_AUTHORITY_NOT_FOUND"]);
});

test("authority ids are never inferred from the anchor slug", () => {
  const result = audit(configuration({
    sources: [source(BRL_CORRIDOR, { authorityId: ANCHOR_A.slug })],
  }));

  assert.deepEqual(codes(result), ["SOURCE_AUTHORITY_MALFORMED"]);
});

test("malformed, unnamed, and unversioned authority entries fail", () => {
  const malformed = audit(configuration({
    authorities: [{ authorityId: "zeam", displayName: "Zeam", configurationVersion: 1 }],
  }));
  const unnamed = audit(configuration({
    authorities: [{ ...AUTHORITY_A, displayName: "   " }],
  }));
  const unversioned = audit(configuration({
    authorities: [{ ...AUTHORITY_A, configurationVersion: 0 }],
  }));

  assert.ok(codes(malformed).includes("AUTHORITY_ID_MALFORMED"));
  assert.deepEqual(codes(unnamed), ["AUTHORITY_DISPLAY_NAME_INVALID"]);
  assert.deepEqual(codes(unversioned), ["AUTHORITY_CONFIGURATION_VERSION_INVALID"]);
});

test("duplicate reviewed authority identity fails", () => {
  const result = audit(configuration({
    authorities: [AUTHORITY_A, AUTHORITY_A],
  }));

  assert.deepEqual(codes(result), ["DUPLICATE_AUTHORITY_IDENTITY"]);
});

test("one anchor cannot be assigned to two reviewed authorities", () => {
  const result = audit(configuration({
    corridors: [BRL_CORRIDOR, USD_CORRIDOR],
    mappings: [mapping(ANCHOR_A.slug, [BRL_CORRIDOR.slug, USD_CORRIDOR.slug])],
    authorities: [AUTHORITY_A, AUTHORITY_B],
    sources: [
      source(BRL_CORRIDOR, { authorityId: AUTHORITY_A.authorityId }),
      source(USD_CORRIDOR, { authorityId: AUTHORITY_B.authorityId }),
    ],
  }));

  assert.deepEqual(codes(result), ["CONTRADICTORY_AUTHORITY_ASSIGNMENT"]);
});

test("renaming an authority display name keeps the same reviewed identity", () => {
  const renamed = Object.freeze({
    ...AUTHORITY_A,
    displayName: "Renamed Operator Label",
  });
  const result = audit(configuration({ authorities: [renamed] }));

  assert.deepEqual(result, { ok: true, issues: [] });
});

test("two reviewed anchors under one authority remain valid configuration", () => {
  const result = audit(configuration({
    anchors: [ANCHOR_A, ANCHOR_B],
    mappings: [
      mapping(ANCHOR_A.slug, [BRL_CORRIDOR.slug]),
      mapping(ANCHOR_B.slug, [BRL_CORRIDOR.slug]),
    ],
    sources: [
      source(BRL_CORRIDOR),
      source(BRL_CORRIDOR, { anchorSlug: ANCHOR_B.slug }),
    ],
  }));

  assert.deepEqual(result, { ok: true, issues: [] });
});

test("audit results, issue collections, and issues are immutable", () => {
  const result = audit(configuration({ mappings: [] }));

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issues), true);
  assert.equal(Object.isFrozen(result.issues[0]), true);
  assert.throws(() => {
    (result.issues as unknown as unknown[]).push({});
  }, TypeError);
});

test("issue ordering is deterministic", () => {
  const badSource = source(BRL_CORRIDOR, {
    anchorSlug: "missing-anchor",
    buyAsset: "stellar:XLM",
    context: "sep24" as never,
    countryCode: "US",
    sellAmount: "0",
    sellAsset: "stellar:USDC",
  });
  const input = configuration({ sources: [badSource, badSource] });

  assert.deepEqual(audit(input), audit(input));
  assert.deepEqual(codes(audit(input)), [...codes(audit(input))].sort());
});

test("audit results and assertion errors never reflect unsafe supplied values", () => {
  const sentinel = "DATABASE_URL=https://user:secret@example.com/token";
  const safeLookingSecret = "sentinel-secret-token";
  const malicious = source(BRL_CORRIDOR, {
    anchorSlug: safeLookingSecret,
    authorityId: sentinel,
    buyAsset: `iso4217:${sentinel}` as ReviewedLiveRateSource["buyAsset"],
    buyDeliveryMethod: `${sentinel}\n`,
    context: sentinel as never,
    corridorSlug: safeLookingSecret,
    countryCode: sentinel,
    sellAmount: sentinel,
    sellAsset: `stellar:USDC:${sentinel}` as ReviewedLiveRateSource["sellAsset"],
  });
  const maliceAuthority = Object.freeze({
    authorityId: sentinel,
    displayName: safeLookingSecret,
    configurationVersion: Number.NaN,
  });
  const input = configuration({
    authorities: [AUTHORITY_A, maliceAuthority],
    sources: [malicious],
  });
  const result = audit(input);

  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.equal(JSON.stringify(result).includes(safeLookingSecret), false);
  assert.throws(
    () => assertStellarCoreConfiguration(input),
    (error) => {
      assert.ok(error instanceof StellarCoreConfigurationAuditError);
      assert.equal(error.code, "INVALID_STELLARCORE_CONFIGURATION");
      assert.equal(error.message, "StellarCore configuration audit failed");
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      assert.equal(JSON.stringify(error).includes(safeLookingSecret), false);
      return true;
    },
  );
});

function configuration(overrides: Readonly<{
  anchors?: readonly AnchorRegistryEntry[];
  authorities?: readonly SourceAuthorityRegistryEntry[];
  corridors?: readonly CorridorRegistryEntry[];
  mappings?: readonly AnchorCorridorRegistryEntry[];
  sources?: readonly ReviewedLiveRateSource[];
}> = {}): StellarCoreConfigurationInput {
  return Object.freeze({
    anchors: overrides.anchors ?? Object.freeze([ANCHOR_A]),
    corridors: overrides.corridors ?? Object.freeze([BRL_CORRIDOR]),
    anchorCorridorMappings: overrides.mappings
      ?? Object.freeze([mapping(ANCHOR_A.slug, [BRL_CORRIDOR.slug])]),
    reviewedLiveRateSources: overrides.sources
      ?? Object.freeze([source(BRL_CORRIDOR)]),
    sourceAuthorities: overrides.authorities
      ?? Object.freeze([AUTHORITY_A]),
  });
}

function mapping(
  anchorSlug: string,
  corridorSlugs: readonly string[],
): AnchorCorridorRegistryEntry {
  return Object.freeze({ anchorSlug, corridorSlugs: Object.freeze([...corridorSlugs]) });
}

function source(
  corridor: CorridorRegistryEntry,
  overrides: Partial<ReviewedLiveRateSource> = {},
): ReviewedLiveRateSource {
  return Object.freeze({
    anchorSlug: ANCHOR_A.slug,
    corridorSlug: corridor.slug,
    authorityId: AUTHORITY_A.authorityId,
    sellAsset: `stellar:${corridor.assetCodeFrom}:${ISSUER}`,
    buyAsset: `iso4217:${corridor.assetCodeTo}`,
    sellAmount: "100",
    buyDeliveryMethod: "BANK",
    countryCode: corridor.countryTo,
    context: "sep31",
    ...overrides,
  }) as ReviewedLiveRateSource;
}

function audit(input: StellarCoreConfigurationInput) {
  return auditStellarCoreConfiguration(input);
}

function codes(result: ReturnType<typeof audit>): ConfigurationAuditIssueCode[] {
  return result.issues.map(({ code }) => code);
}
