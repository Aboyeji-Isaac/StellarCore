import {
  isZeroDecimal,
  parseDatabaseDecimal,
} from "@/lib/rates/decimal";
import { parseSep38AssetIdentifier } from "@/lib/stellar/sep38";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

export type StellarCoreConfigurationInput = Readonly<{
  anchors: readonly AnchorRegistryEntry[];
  corridors: readonly CorridorRegistryEntry[];
  anchorCorridorMappings: readonly AnchorCorridorRegistryEntry[];
  reviewedLiveRateSources: readonly ReviewedLiveRateSource[];
}>;

export type ConfigurationAuditIssueCode =
  | "DUPLICATE_CORRIDOR_IDENTITY"
  | "DUPLICATE_REVIEWED_SOURCE"
  | "NON_CANONICAL_CORRIDOR_SLUG"
  | "SOURCE_ANCHOR_NOT_FOUND"
  | "SOURCE_BUY_ASSET_CODE_MISMATCH"
  | "SOURCE_BUY_ASSET_FORM_INVALID"
  | "SOURCE_BUY_ASSET_INVALID"
  | "SOURCE_CONTEXT_INVALID"
  | "SOURCE_CORRIDOR_NOT_FOUND"
  | "SOURCE_DESTINATION_COUNTRY_MISMATCH"
  | "SOURCE_MEMBERSHIP_NOT_CONFIGURED"
  | "SOURCE_OPTIONAL_FIELD_INVALID"
  | "SOURCE_SELL_AMOUNT_INVALID"
  | "SOURCE_SELL_AMOUNT_NOT_POSITIVE"
  | "SOURCE_SELL_ASSET_CODE_MISMATCH"
  | "SOURCE_SELL_ASSET_FORM_INVALID"
  | "SOURCE_SELL_ASSET_INVALID";

export type ConfigurationAuditIssue = Readonly<{
  code: ConfigurationAuditIssueCode;
  registry: "corridors" | "reviewedLiveRateSources";
  entryIndex: number;
  anchorSlug?: string;
  corridorSlug?: string;
  field?:
    | "buyAsset"
    | "buyDeliveryMethod"
    | "context"
    | "countryCode"
    | "sellAmount"
    | "sellAsset"
    | "slug";
}>;

export type ConfigurationAuditResult = Readonly<{
  ok: boolean;
  issues: readonly ConfigurationAuditIssue[];
}>;

export class StellarCoreConfigurationAuditError extends Error {
  readonly code = "INVALID_STELLARCORE_CONFIGURATION";
  readonly issues: readonly ConfigurationAuditIssue[];

  constructor(result: ConfigurationAuditResult) {
    super("StellarCore configuration audit failed");
    this.name = "StellarCoreConfigurationAuditError";
    this.issues = result.issues;
  }
}

export function auditStellarCoreConfiguration(
  input: StellarCoreConfigurationInput,
): ConfigurationAuditResult {
  const issues: ConfigurationAuditIssue[] = [];
  const anchors = new Set(input.anchors.map(({ slug }) => slug));
  const corridors = new Map(input.corridors.map((corridor) => [corridor.slug, corridor]));
  const memberships = new Set(input.anchorCorridorMappings.flatMap((mapping) =>
    mapping.corridorSlugs.map((corridorSlug) =>
      candidateIdentity(mapping.anchorSlug, corridorSlug))));

  auditCorridors(input.corridors, issues);
  auditReviewedSources(
    input.reviewedLiveRateSources,
    anchors,
    corridors,
    memberships,
    issues,
  );

  const frozenIssues = Object.freeze(
    issues.sort(compareIssues).map((issue) => Object.freeze({ ...issue })),
  );
  return Object.freeze({ ok: frozenIssues.length === 0, issues: frozenIssues });
}

export function assertStellarCoreConfiguration(
  input: StellarCoreConfigurationInput,
): ConfigurationAuditResult {
  const result = auditStellarCoreConfiguration(input);
  if (!result.ok) throw new StellarCoreConfigurationAuditError(result);
  return result;
}

export type StellarCoreConfigurationFingerprintInput = Readonly<{
  deploymentRevision: string;
  configuration: StellarCoreConfigurationInput;
  policyIdentifiers?: readonly string[];
}>;

export type StellarCoreConfigurationFingerprint = Readonly<{
  fingerprint: string;
  deploymentRevision: string;
  canonical: string;
  components: Readonly<{
    anchors: string;
    corridors: string;
    anchorCorridorMappings: string;
    reviewedLiveRateSources: string;
    policyIdentifiers: string;
  }>;
}>;

export type ConfigurationDriftPolicy = "fail" | "degrade" | "ignore";

export type ConfigurationDriftResult = Readonly<{
  status: "match" | "drift";
  expectedFingerprint: string;
  activeFingerprint: string;
  expectedRevision: string;
  activeRevision: string;
  policy: ConfigurationDriftPolicy;
  action: "none" | "degrade"; | "fail";
}>;

export class StellarCoreConfigurationDriftError extends Error {
  readonly code = "STELLARCORE_CONFIGURATION_DRIFT";
  readonly result: ConfigurationDriftResult;

  constructor(result: ConfigurationDriftResult) {
    super("StellarCore configuration drift detected");
    this.name = "StellarCoreConfigurationDriftError";
    this.result = result;
  }
}

const FINGERPRINT_VERSION = "stellarcore-config-fingerprint-v1";

const DEFAULT_DRIFT_POLICY: ConfigurationDriftPolicy = "fail";

export function computeStellarCoreConfigurationFingerprint(
  input: StellarCoreConfigurationFingerprintInput,
): StellarCoreConfigurationFingerprint {
  const deploymentRevision = normalizeRevision(input.deploymentRevision);
  const anchors = canonicalizeAnchors(input.configuration.anchors);
  const corridors = canonicalizeCorridors(input.configuration.corridors);
  const anchorCorridorMappings = canonicalizeAnchorCorridorMappings(
    input.configuration.anchorCorridorMappings,
  );
  const reviewedLiveRateSources = canonicalizeReviewedLiveRateSources(
    input.configuration.reviewedLiveRateSources,
  );
  const policyIdentifiers = canonicalizePolicyIdentifiers(
    input.policyIdentifiers ?? [],
  );

  const components = Object.freeze({
    anchors: hashString(anchors),
    corridors: hashString(corridors),
    anchorCorridorMappings: hashString(anchorCorridorMappings),
    reviewedLiveRateSources: hashString(reviewedLiveRateSources),
    policyIdentifiers: hashString(policyIdentifiers),
  });

  const canonical = [
    FINGERPRINT_VERSION,
    deploymentRevision,
    `anchors=${components.anchors}`,
    `corridors=${components.corridors}`,
    `anchorCorridorMappings=${components.anchorCorridorMappings}`,
    `reviewedLiveRateSources=${components.reviewedLiveRateSources}`,
    `policyIdentifiers=${components.policyIdentifiers}`,
  ].join("\n");

  return Object.freeze({
    fingerprint: hashString(canonical),
    deploymentRevision,
    canonical,
    components,
  });
}

export function detectStellarCoreConfigurationDrift(
  expected: StellarCoreConfigurationFingerprint,
  active: StellarCoreConfigurationFingerprint,
  policy: ConfigurationDriftPolicy = DEFAULT_DRIFT_POLICY,
): ConfigurationDriftResult {
  const match = expected.fingerprint === active.fingerprint;
  const status: "match" | "drift" = match ? "match" : "drift";
  const action: "none" | "degrade" | "fail" = match
    ? "none"
    : policy === "fail"
      ? "fail"
      : policy === "degrade"
        ? "degrade"
        : "none";

  return Object.freeze({
    status,
    expectedFingerprint: expected.fingerprint,
    activeFingerprint: active.fingerprint,
    expectedRevision: expected.deploymentRevision,
    activeRevision: active.deploymentRevision,
    policy,
    action,
  });
}

export function assertStellarCoreConfigurationDrift(
  expected: StellarCoreConfigurationFingerprint,
  active: StellarCoreConfigurationFingerprint,
  policy: ConfigurationDriftPolicy = DEFAULT_DRIFT_POLICY,
): ConfigurationDriftResult {
  const result = detectStellarCoreConfigurationDrift(expected, active, policy);
  if (result.action === "fail") {
    throw new StellarCoreConfigurationDriftError(result);
  }
  return result;
}

export function describeStellarCoreConfigurationFingerprint(
  fingerprint: StellarCoreConfigurationFingerprint,
): Readonly<{
  fingerprint: string;
  deploymentRevision: string;
  components: StellarCoreConfigurationFingerprint["components"];
}> {
  return Object.freeze({
    fingerprint: fingerprint.fingerprint,
    deploymentRevision: fingerprint.deploymentRevision,
    components: fingerprint.components,
  });
}

function normalizeRevision(revision: string): string {
  if (typeof revision !== "string" || revision.trim().length === 0) {
    throw new Error("deploymentRevision must be a non-empty string");
  }
  return revision.trim().toLowerCase();
}

function canonicalizeAnchors(
  anchors: readonly AnchorRegistryEntry[],
): string {
  const entries = anchors.map((anchor) => ({
    slug: stringOrEmpty(anchor.slug),
    name: stringOrEmpty(anchor.name),
  }));
  entries.sort((left, right) => compareText(left.slug, right.slug));
  return JSON.stringify(entries);
}

function canonicalizeCorridors(
  corridors: readonly CorridorRegistryEntry[],
): string {
  const entries = corridors.map((corridor) => ({
    slug: stringOrEmpty(corridor.slug),
    assetCodeFrom: stringOrEmpty(corridor.assetCodeFrom),
    countryFrom: stringOrEmpty(corridor.countryFrom),
    assetCodeTo: stringOrEmpty(corridor.assetCodeTo),
    countryTo: stringOrEmpty(corridor.countryTo),
  }));
  entries.sort((left, right) => compareText(left.slug, right.slug));
  return JSON.stringify(entries);
}

function canonicalizeAnchorCorridorMappings(
  mappings: readonly AnchorCorridorRegistryEntry[],
): string {
  const entries = mappings.map((mapping) => ({
    anchorSlug: stringOrEmpty(mapping.anchorSlug),
    corridorSlugs: [...mapping.corridorSlugs]
      .map((value) => stringOrEmpty(value))
      .sort(compareText),
  }));
  entries.sort((left, right) => compareText(left.anchorSlug, right.anchorSlug));
  return JSON.stringify(entries);
}

function canonicalizeReviewedLiveRateSources(
  sources: readonly ReviewedLiveRateSource[],
): string {
  const entries = sources.map((source) => ({
    anchorSlug: stringOrEmpty(source.anchorSlug),
    corridorSlug: stringOrEmpty(source.corridorSlug),
    context: stringOrEmpty(source.context),
    countryCode: stringOrEmpty(source.countryCode),
    sellAsset: stringOrEmpty(source.sellAsset),
    buyAsset: stringOrEmpty(source.buyAsset),
    sellAmount: stringOrEmpty(source.sellAmount),
    buyDeliveryMethod: stringOrEmpty(source.buyDeliveryMethod ?? ""),
  }));
  entries.sort((left, right) =>
    compareText(left.anchorSlug, right.anchorSlug)
    || compareText(left.corridorSlug, right.corridorSlug)
    || compareText(left.context, right.context)
    || compareText(left.countryCode, right.countryCode)
    || compareText(left.sellAsset, right.sellAsset)
    || compareText(left.buyAsset, right.buyAsset)
    || compareText(left.sellAmount, right.sellAmount)
    || compareText(left.buyDeliveryMethod, right.buyDeliveryMethod),
  );
  return JSON.stringify(entries);
}

function canonicalizePolicyIdentifiers(
  identifiers: readonly string[],
): string {
  const normalized = identifiers
    .map((value) => stringOrEmpty(value))
    .sort(compareText);
  return JSON.stringify(normalized);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hashString(value: string): string {
  // FIPS 180-4 implementation over UTF-8 bytes.
  const bytes = utf8Encode(value);
  const words = new Uint32Array(5);
  words[0] = 0x67452301;
  words[1] = 0xefcdab89;
  words[2] = 0x98badcfe;
  words[3] = 0x10325476;
  words[4] = 0xc3d2e1f0;

  const blockCount = Math.ceil((bytes.length + 9) / 64);
  const totalWords = blockCount * 16;
  const message = new Uint32Array(totalWords);
  for (let i = 0; i < bytes.length; i++) {
    message[i >> 2] |= bytes[i] << ((3 - (i & 3)) * 8);
  }
  message[bytes.length >> 2] |= 0x80 << ((3 - (bytes.length & 3)) * 8);
  const bitLength = bytes.length * 8;
  message[totalWords - 2] = Math.floor(bitLength / 0x100000000);
  message[totalWords - 1] = bitLength >>> 0;

  for (let block = 0; block < blockCount; block++) {
    const w = new Uint32Array(80);
    for (let i = 0; i < 16; i++) w[i] = message[block * 16 + i];
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = words[0];
    let b = words[1];
    let c = words[2];
    let d = words[3];
    let e = words[4];
    for (let i = 0; i < 80; i++) {
      const f = i < 20
        ? (b & c)  | ((~b) & d)
        : i < 40
          ? b ^ c ^ d
          : i < 60
            ? ((b & c) | (b & d) | (c & d))
            : b ^ c ^ d;
      const k = i < 20
        ? 0x5a827999
        : i < 40
          ? 0x6ed9eba1
          : i < 60
            ? 0x8f1bbcdc
            : 0xca62c1d6;
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = temp;
    }
    words[0] = (words[0] + a) >>> 0;
    words[1] = (words[1] + b) >>> 0;
    words[2] = (words[2] + c) >>> 0;
    words[3] = (words[3] + d) >>> 0;
    words[4] = (words[4] + e) >>> 0;
  }

  return Array.from(words, (word) => word.toString(16).padStart(8, "0")).join("");
}

function rotl(Value: number, bits: number): number {
  return ((Value << bits) | (Value >>> (32 - bits))) >>> 0;
}

function utf8Encode(value: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value);
  }
  const encoded = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    bytes[i] = encoded.charCodeAt(i);
  }
  return bytes;
}

function auditCorridors(
  corridors: readonly CorridorRegistryEntry[],
  issues: ConfigurationAuditIssue[],
): void {
  const identities = new Map<string, number>();

  corridors.forEach((corridor, entryIndex) => {
    const tuple = corridorTuple(corridor);
    const safeCorridorSlug = safeSlug(corridor.slug);

    if (!tuple || corridor.slug !== tuple.canonicalSlug) {
      issues.push(issue({
        code: "NON_CANONICAL_CORRIDOR_SLUG",
        registry: "corridors",
        entryIndex,
        ...(safeCorridorSlug ? { corridorSlug: safeCorridorSlug } : {}),
        field: "slug",
      }));
    }

    if (!tuple) return;
    if (identities.has(tuple.semanticIdentity)) {
      issues.push(issue({
        code: "DUPLICATE_CORRIDOR_IDENTITY",
        registry: "corridors",
        entryIndex,
        ...(safeCorridorSlug ? { corridorSlug: safeCorridorSlug } : {}),
      }));
      return;
    }
    identities.set(tuple.semanticIdentity, entryIndex);
  });
}

function auditReviewedSources(
  sources: readonly ReviewedLiveRateSource[],
  anchors: ReadonlySet<string>,
  corridors: ReadonlyMap<string, CorridorRegistryEntry>,
  memberships: ReadonlySet<string>,
  issues: ConfigurationAuditIssue[],
): void {
  const candidates = new Set<string>();

  sources.forEach((source, entryIndex) => {
    const safeAnchorSlug = safeSlug(source.anchorSlug);
    const safeCorridorSlug = safeSlug(source.corridorSlug);
    const identity = candidateIdentity(source.anchorSlug, source.corridorSlug);
    const anchorExists = anchors.has(source.anchorSlug);
    const corridor = corridors.get(source.corridorSlug);
    const base = {
      registry: "reviewedLiveRateSources" as const,
      entryIndex,
      ...(anchorExists && safeAnchorSlug ? { anchorSlug: safeAnchorSlug } : {}),
      ...(corridor && safeCorridorSlug ? { corridorSlug: safeCorridorSlug } : {}),
    };

    if (!anchorExists) {
      issues.push(issue({ ...base, code: "SOURCE_ANCHOR_NOT_FOUND" }));
    }
    if (!corridor) {
      issues.push(issue({ ...base, code: "SOURCE_CORRIDOR_NOT_FOUND" }));
    }
    if (anchorExists && corridor && !memberships.has(identity)) {
      issues.push(issue({ ...base, code: "SOURCE_MEMBERSHIP_NOT_CONFIGURED" }));
    }
    if (candidates.has(identity)) {
      issues.push(issue({ ...base, code: "DUPLICATE_REVIEWED_SOURCE" }));
    } else {
      candidates.add(identity);
    }

    auditSellAsset(source, corridor, base, issues);
    auditBuyAsset(source, corridor, base, issues);

    if (corridor && source.countryCode !== corridor.countryTo) {
      issues.push(issue({
        ...base,
        code: "SOURCE_DESTINATION_COUNTRY_MISMATCH",
        field: "countryCode",
      }));
    }

    auditSellAmount(source.sellAmount, base, issues);

    if (
      source.buyDeliveryMethod !== undefined &&
      !isValidOptionalText(source.buyDeliveryMethod)
    ) {
      issues.push(issue({
        ...base,
        code: "SOURCE_OPTIONAL_FIELD_INVALID",
        field: "buyDeliveryMethod",
      }));
    }

    if (source.context !== "sep6" && source.context !== "sep31") {
      issues.push(issue({
        ...base,
        code: "SOURCE_CONTEXT_INVALID",
        field: "context",
      }));
    }
  });
}

function auditSellAsset(
  source: ReviewedLiveRateSource,
  corridor: CorridorRegistryEntry | undefined,
  base: Omit<ConfigurationAuditIssue, "code" | "field">,
  issues: ConfigurationAuditIssue[],
): void {
  let parsed;
  try {
    parsed = parseSep38AssetIdentifier(source.sellAsset);
  } catch {
    issues.push(issue({ ...base, code: "SOURCE_SELL_ASSET_INVALID", field: "sellAsset" }));
    return;
  }

  if (parsed.scheme !== "stellar" || !parsed.issuer || !parsed.code) {
    issues.push(issue({
      ...base,
      code: "SOURCE_SELL_ASSET_FORM_INVALID",
      field: "sellAsset",
    }));
    return;
  }

  if (corridor && parsed.code !== corridor.assetCodeFrom) {
    issues.push(issue({
      ...base,
      code: "SOURCE_SELL_ASSET_CODE_MISMATCH",
      field: "sellAsset",
    }));
  }
}

function auditBuyAsset(
  source: ReviewedLiveRateSource,
  corridor: CorridorRegistryEntry | undefined,
  base: Omit<ConfigurationAuditIssue, "code" | "field">,
  issues: ConfigurationAuditIssue[],
): void {
  let parsed;
  try {
    parsed = parseSep38AssetIdentifier(source.buyAsset);
  } catch {
    issues.push(issue({ ...base, code: "SOURCE_BUY_ASSET_INVALID", field: "buyAsset" }));
    return;
  }

  if (parsed.scheme !== "iso4217") {
    issues.push(issue({
      ...base,
      code: "SOURCE_BUY_ASSET_FORM_INVALID",
      field: "buyAsset",
    }));
    return;
  }

  if (corridor && parsed.code !== corridor.assetCodeTo) {
    issues.push(issue({
      ...base,
      code: "SOURCE_BUY_ASSET_CODE_MISMATCH",
      field: "buyAsset",
    }));
  }
}

function auditSellAmount(
  value: string,
  base: Omit<ConfigurationAuditIssue, "code" | "field">,
  issues: ConfigurationAuditIssue[],
): void {
  try {
    if (isZeroDecimal(parseDatabaseDecimal(value))) {
      issues.push(issue({
        ...base,
        code: "SOURCE_SELL_AMOUNT_NOT_POSITIVE",
        field: "sellAmount",
      }));
    }
  } catch {
    issues.push(issue({
      ...base,
      code: "SOURCE_SELL_AMOUNT_INVALID",
      field: "sellAmount",
    }));
  }
}

function corridorTuple(corridor: CorridorRegistryEntry): Readonly<{
  canonicalSlug: string;
  semanticIdentity: string;
}> | null {
  const values = [
    corridor.assetCodeFrom,
    corridor.countryFrom,
    corridor.assetCodeTo,
    corridor.countryTo,
  ];
  if (!values.every((value) => typeof value === "string")) return null;

  return Object.freeze({
    canonicalSlug: values.map((value) => value.toLowerCase()).join("-"),
    semanticIdentity: values.map((value) => value.toUpperCase()).join("\0"),
  });
}

function candidateIdentity(anchorSlug: string, corridorSlug: string): string {
  return `${anchorSlug}\0${corridorSlug}`;
}

function isValidOptionalText(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeSlug(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length <= 100
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    ? value
    : undefined;
}

function issue(value: ConfigurationAuditIssue): ConfigurationAuditIssue {
  return value;
}

function compareIssues(
  left: ConfigurationAuditIssue,
  right: ConfigurationAuditIssue,
): number {
  return compareText(left.registry, right.registry)
    || compareText(left.code, right.code)
    || compareText(left.anchorSlug ?? "", right.anchorSlug ?? "")
    || compareText(left.corridorSlug ?? "", right.corridorSlug ?? "")
    || compareText(left.field ?? "", right.field ?? "")
    || left.entryIndex - right.entryIndex;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
