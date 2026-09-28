import {
  isZeroDecimal,
  parseDatabaseDecimal,
} from "@/lib/rates/decimal";
import {
  isValidAuthorityConfigurationVersion,
  isValidAuthorityDisplayName,
  isValidSourceAuthorityId,
} from "@/lib/rates/sourceAuthority";
import { parseSep38AssetIdentifier } from "@/lib/stellar/sep38";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";
import type { SourceAuthorityRegistryEntry } from "@/types/sourceAuthority";

export type StellarCoreConfigurationInput = Readonly<{
  anchors: readonly AnchorRegistryEntry[];
  corridors: readonly CorridorRegistryEntry[];
  anchorCorridorMappings: readonly AnchorCorridorRegistryEntry[];
  reviewedLiveRateSources: readonly ReviewedLiveRateSource[];
  sourceAuthorities: readonly SourceAuthorityRegistryEntry[];
}>;

export type ConfigurationAuditIssueCode =
  | "AUTHORITY_CONFIGURATION_VERSION_INVALID"
  | "AUTHORITY_DISPLAY_NAME_INVALID"
  | "AUTHORITY_ID_MALFORMED"
  | "CONTRADICTORY_AUTHORITY_ASSIGNMENT"
  | "DUPLICATE_AUTHORITY_IDENTITY"
  | "DUPLICATE_CORRIDOR_IDENTITY"
  | "DUPLICATE_REVIEWED_SOURCE"
  | "NON_CANONICAL_CORRIDOR_SLUG"
  | "SOURCE_ANCHOR_NOT_FOUND"
  | "SOURCE_AUTHORITY_MALFORMED"
  | "SOURCE_AUTHORITY_MISSING"
  | "SOURCE_AUTHORITY_NOT_FOUND"
  | "SOURCE_BUY_ASSET_CODE_MISMATCH"
  | "SOURCE_BUY_ASSET_FORM_INVALID"
  | "SOURCE_BUY_ASSET_INVALID"
  | "SOURCE_CONTEXT_INVALID"
  | "SOURCE_CORRIDOR_NOT_FOUND"
  | "SOURCE_DESTINATION_COUNTRY_MISMATCH"
  | "SOURCE_MEMBERSHIP_NOT_CONFIGURED"
  | "SOURCE_OPTIONAL_FIELD_INVALID"
  | "SOURCE_SELL_AMOUNT_INVALID"
  | "SOURCE_SELL_AMOUNT_NOT_POSITIVE"
  | "SOURCE_SELL_ASSET_CODE_MISMATCH"
  | "SOURCE_SELL_ASSET_FORM_INVALID"
  | "SOURCE_SELL_ASSET_INVALID";

export type ConfigurationAuditIssue = Readonly<{
  code: ConfigurationAuditIssueCode;
  registry: "corridors" | "reviewedLiveRateSources" | "sourceAuthorities";
  entryIndex: number;
  anchorSlug?: string;
  authorityId?: string;
  corridorSlug?: string;
  field?:
    | "authorityId"
    | "buyAsset"
    | "buyDeliveryMethod"
    | "configurationVersion"
    | "context"
    | "countryCode"
    | "displayName"
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
  const reviewedAuthorities = auditSourceAuthorities(
    input.sourceAuthorities,
    issues,
  );
  auditReviewedSources(
    input.reviewedLiveRateSources,
    anchors,
    corridors,
    memberships,
    reviewedAuthorities,
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

/**
 * Audits the reviewed source-authority registry itself: identifiers must be
 * well-formed opaque ids, unique, and carry a reviewed display name and
 * positive configuration version. Nothing here infers authority from anchor
 * slugs, domains, hosts, or accounts.
 */
function auditSourceAuthorities(
  authorities: readonly SourceAuthorityRegistryEntry[],
  issues: ConfigurationAuditIssue[],
): ReadonlySet<string> {
  const reviewed = new Set<string>();

  authorities.forEach((authority, entryIndex) => {
    const validId = isValidSourceAuthorityId(authority.authorityId);
    const base = {
      registry: "sourceAuthorities" as const,
      entryIndex,
      ...(validId ? { authorityId: authority.authorityId } : {}),
    };

    if (!validId) {
      issues.push(issue({ ...base, code: "AUTHORITY_ID_MALFORMED", field: "authorityId" }));
      return;
    }

    if (reviewed.has(authority.authorityId)) {
      issues.push(issue({
        ...base,
        code: "DUPLICATE_AUTHORITY_IDENTITY",
        field: "authorityId",
      }));
      return;
    }
    reviewed.add(authority.authorityId);

    if (!isValidAuthorityDisplayName(authority.displayName)) {
      issues.push(issue({
        ...base,
        code: "AUTHORITY_DISPLAY_NAME_INVALID",
        field: "displayName",
      }));
    }

    if (!isValidAuthorityConfigurationVersion(authority.configurationVersion)) {
      issues.push(issue({
        ...base,
        code: "AUTHORITY_CONFIGURATION_VERSION_INVALID",
        field: "configurationVersion",
      }));
    }
  });

  return reviewed;
}

function auditReviewedSources(
  sources: readonly ReviewedLiveRateSource[],
  anchors: ReadonlySet<string>,
  corridors: ReadonlyMap<string, CorridorRegistryEntry>,
  memberships: ReadonlySet<string>,
  reviewedAuthorities: ReadonlySet<string>,
  issues: ConfigurationAuditIssue[],
): void {
  const candidates = new Set<string>();
  const authorityByAnchor = new Map<string, string>();

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

    auditSourceAuthority(
      source,
      reviewedAuthorities,
      authorityByAnchor,
      base,
      issues,
    );

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

function auditSourceAuthority(
  source: ReviewedLiveRateSource,
  reviewedAuthorities: ReadonlySet<string>,
  authorityByAnchor: Map<string, string>,
  base: Omit<ConfigurationAuditIssue, "code" | "field">,
  issues: ConfigurationAuditIssue[],
): void {
  const authorityId = source.authorityId;
  if (typeof authorityId !== "string" || authorityId.trim().length === 0) {
    issues.push(issue({ ...base, code: "SOURCE_AUTHORITY_MISSING", field: "authorityId" }));
    return;
  }

  if (!isValidSourceAuthorityId(authorityId)) {
    issues.push(issue({ ...base, code: "SOURCE_AUTHORITY_MALFORMED", field: "authorityId" }));
    return;
  }

  const safeBase = { ...base, authorityId };
  if (!reviewedAuthorities.has(authorityId)) {
    issues.push(issue({ ...safeBase, code: "SOURCE_AUTHORITY_NOT_FOUND", field: "authorityId" }));
  }

  const assigned = authorityByAnchor.get(source.anchorSlug);
  if (assigned !== undefined && assigned !== authorityId) {
    issues.push(issue({ ...safeBase, code: "CONTRADICTORY_AUTHORITY_ASSIGNMENT", field: "authorityId" }));
    return;
  }
  authorityByAnchor.set(source.anchorSlug, authorityId);
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
    || compareText(left.authorityId ?? "", right.authorityId ?? "")
    || compareText(left.corridorSlug ?? "", right.corridorSlug ?? "")
    || compareText(left.field ?? "", right.field ?? "")
    || left.entryIndex - right.entryIndex;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
