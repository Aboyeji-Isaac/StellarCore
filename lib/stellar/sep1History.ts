import { createHash } from "node:crypto";

import type { DiscoveredAnchor } from "@/types/anchor";

/**
 * Versioned canonicalization, hashing, and diffing of SEP-1 discovery
 * metadata. Everything here is pure and deterministic; persistence lives in
 * `sep1HistoryRepository.ts`.
 *
 * A fetched stellar.toml is an anchor-controlled assertion. Digests identify
 * exactly which asserted metadata was observed or reviewed; they are not proof
 * that any advertised capability works.
 *
 * Canonicalization v1:
 * - strings are trimmed and Unicode NFC-normalized;
 * - every endpoint key is always present (`null` when absent), so key order
 *   and omission style cannot change a digest;
 * - endpoint URLs drop userinfo and fragments, keep origin + path, and replace
 *   each query value with a bounded hash so embedded secrets are never stored
 *   while a changed query still changes the digest;
 * - assets are de-duplicated and sorted by code, issuer, then remaining fields;
 * - JSON is serialized with recursively sorted object keys;
 * - digests are SHA-256 hex over `sep1-canonical-v<version>\n<json>`.
 * Any change to these rules must bump SEP1_CANONICAL_VERSION.
 */
export const SEP1_CANONICAL_VERSION = 1;

export const SEP1_ENDPOINT_FIELDS = [
  "transferServer",
  "transferServerSep24",
  "webAuthEndpoint",
  "kycServer",
  "directPaymentServer",
  "anchorQuoteServer",
] as const;

export type Sep1EndpointField = (typeof SEP1_ENDPOINT_FIELDS)[number];

export type CanonicalSep1Asset = Readonly<{
  code: string;
  issuer: string | null;
  status: string | null;
  isAssetAnchored: boolean | null;
  anchorAssetType: string | null;
  anchorAsset: string | null;
}>;

export type CanonicalSep1Metadata = Readonly<{
  version: number;
  organizationName: string;
  organizationUrl: string | null;
  networkPassphrase: string;
  signingKey: string | null;
  seps: readonly number[];
  endpoints: Readonly<Record<Sep1EndpointField, string | null>>;
  assets: readonly CanonicalSep1Asset[];
}>;

/** Fields whose silent change would redirect or re-key downstream capture. */
export type CanonicalSep1SensitiveMetadata = Readonly<{
  version: number;
  networkPassphrase: string;
  signingKey: string | null;
  endpoints: Readonly<Record<Sep1EndpointField, string | null>>;
  assets: readonly Readonly<{ code: string; issuer: string | null }>[];
}>;

export type Sep1FieldDiff = Readonly<{
  field: string;
  before: string | null;
  after: string | null;
}>;

export type Sep1Assessment =
  | "NO_BASELINE"
  | "MATCHES_BASELINE"
  | "CHANGED_UNREVIEWED";

export type Sep1Observation = Readonly<{
  version: number;
  metadata: CanonicalSep1Metadata;
  sensitive: CanonicalSep1SensitiveMetadata;
  digest: string;
  sensitiveDigest: string;
}>;

export function buildSep1Observation(
  discovered: Pick<
    DiscoveredAnchor,
    | "organizationName"
    | "organizationUrl"
    | "networkPassphrase"
    | "signingKey"
    | "seps"
    | "endpoints"
    | "assets"
  >,
): Sep1Observation {
  const metadata = canonicalizeSep1Metadata(discovered);
  const sensitive = extractSensitiveMetadata(metadata);

  return Object.freeze({
    version: SEP1_CANONICAL_VERSION,
    metadata,
    sensitive,
    digest: digestCanonical(metadata),
    sensitiveDigest: digestCanonical(sensitive),
  });
}

export function canonicalizeSep1Metadata(
  discovered: Parameters<typeof buildSep1Observation>[0],
): CanonicalSep1Metadata {
  const endpoints = Object.fromEntries(
    SEP1_ENDPOINT_FIELDS.map((field) => [
      field,
      sanitizeEndpointUrl(discovered.endpoints[field]),
    ]),
  ) as Record<Sep1EndpointField, string | null>;

  const assets = new Map<string, CanonicalSep1Asset>();
  for (const asset of discovered.assets) {
    const canonical: CanonicalSep1Asset = Object.freeze({
      code: text(asset.code),
      issuer: nullableText(asset.issuer),
      status: nullableText(asset.status),
      isAssetAnchored: asset.isAssetAnchored ?? null,
      anchorAssetType: nullableText(asset.anchorAssetType),
      anchorAsset: nullableText(asset.anchorAsset),
    });
    assets.set(canonicalJson(canonical), canonical);
  }

  return Object.freeze({
    version: SEP1_CANONICAL_VERSION,
    organizationName: text(discovered.organizationName),
    organizationUrl: sanitizeEndpointUrl(discovered.organizationUrl),
    networkPassphrase: text(discovered.networkPassphrase),
    signingKey: nullableText(discovered.signingKey),
    seps: Object.freeze([...new Set(discovered.seps)].sort((a, b) => a - b)),
    endpoints: Object.freeze(endpoints),
    assets: Object.freeze(
      [...assets.entries()]
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([, asset]) => asset)
        .sort(compareAssets),
    ),
  });
}

export function extractSensitiveMetadata(
  metadata: CanonicalSep1Metadata,
): CanonicalSep1SensitiveMetadata {
  const identities = new Map<string, { code: string; issuer: string | null }>();
  for (const { code, issuer } of metadata.assets) {
    identities.set(canonicalJson({ code, issuer }), { code, issuer });
  }

  return Object.freeze({
    version: metadata.version,
    networkPassphrase: metadata.networkPassphrase,
    signingKey: metadata.signingKey,
    endpoints: metadata.endpoints,
    assets: Object.freeze(
      [...identities.values()]
        .sort((left, right) =>
          compareStrings(left.code, right.code) ||
          compareStrings(left.issuer ?? "", right.issuer ?? ""))
        .map((identity) => Object.freeze(identity)),
    ),
  });
}

export function diffSensitiveMetadata(
  baseline: CanonicalSep1SensitiveMetadata | null,
  observed: CanonicalSep1SensitiveMetadata,
): readonly Sep1FieldDiff[] {
  const diffs: Sep1FieldDiff[] = [];
  const push = (field: string, before: string | null, after: string | null) => {
    if (before !== after) diffs.push(Object.freeze({ field, before, after }));
  };

  push(
    "networkPassphrase",
    baseline?.networkPassphrase ?? null,
    observed.networkPassphrase,
  );
  push("signingKey", baseline?.signingKey ?? null, observed.signingKey);
  for (const field of SEP1_ENDPOINT_FIELDS) {
    push(
      `endpoints.${field}`,
      baseline?.endpoints[field] ?? null,
      observed.endpoints[field],
    );
  }

  const before = new Set((baseline?.assets ?? []).map(assetLabel));
  const after = new Set(observed.assets.map(assetLabel));
  for (const label of before) {
    if (!after.has(label)) push(`assets.${label}`, "present", null);
  }
  for (const label of after) {
    if (!before.has(label)) push(`assets.${label}`, null, "present");
  }

  return Object.freeze(
    diffs.sort((left, right) => compareStrings(left.field, right.field)),
  );
}

export function assessObservation(
  baseline: CanonicalSep1SensitiveMetadata | null,
  observation: Sep1Observation,
): Readonly<{ assessment: Sep1Assessment; diff: readonly Sep1FieldDiff[] }> {
  if (!baseline) {
    return Object.freeze({
      assessment: "NO_BASELINE" as const,
      diff: diffSensitiveMetadata(null, observation.sensitive),
    });
  }

  const diff = diffSensitiveMetadata(baseline, observation.sensitive);
  return Object.freeze({
    assessment:
      diff.length === 0
        ? ("MATCHES_BASELINE" as const)
        : ("CHANGED_UNREVIEWED" as const),
    diff,
  });
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function digestCanonical(value: unknown): string {
  return createHash("sha256")
    .update(`sep1-canonical-v${SEP1_CANONICAL_VERSION}\n${canonicalJson(value)}`)
    .digest("hex");
}

export function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function sanitizeEndpointUrl(value: string | undefined): string | null {
  if (!value) return null;

  const url = new URL(value);
  const params = [...url.searchParams.entries()]
    .map(([name, paramValue]) => [name, shortHash(paramValue)] as const)
    .sort(([leftName, leftHash], [rightName, rightHash]) =>
      compareStrings(leftName, rightName) || compareStrings(leftHash, rightHash));
  const query = params.length
    ? `?${params.map(([name, hash]) => `${encodeURIComponent(name)}=h-${hash}`).join("&")}`
    : "";

  return `${url.origin}${url.pathname}${query}`.normalize("NFC");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function assetLabel(asset: { code: string; issuer: string | null }): string {
  return `${asset.code}:${asset.issuer ?? "-"}`;
}

function compareAssets(left: CanonicalSep1Asset, right: CanonicalSep1Asset) {
  return (
    compareStrings(left.code, right.code) ||
    compareStrings(left.issuer ?? "", right.issuer ?? "") ||
    compareStrings(canonicalJson(left), canonicalJson(right))
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: string): string {
  return value.trim().normalize("NFC");
}

function nullableText(value: string | undefined): string | null {
  return value === undefined ? null : text(value);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}
