import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";
import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

/**
 * The reviewed static registry deliberately does not store SEP support; it is
 * discovered from each anchor's stellar.toml during registry bootstrap, so a
 * registry-only tool must not claim SEP support for any anchor.
 */
export type RegistryAnchorSummary = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  corridorSlugs: readonly string[];
  reviewedRateSourceCount: number;
}>;

export type RegistryCorridorSummary = Readonly<{
  slug: string;
  route: string;
  anchorSlugs: readonly string[];
  hasReviewedRateSource: boolean;
}>;

export type RegistrySummary = Readonly<{
  anchors: readonly RegistryAnchorSummary[];
  corridors: readonly RegistryCorridorSummary[];
  reviewedRateSources: readonly Readonly<{
    anchorSlug: string;
    corridorSlug: string;
    sellAsset: string;
    buyAsset: string;
    context: string;
  }>[];
}>;

export type RegistrySummaryInput = Readonly<{
  anchors: readonly AnchorRegistryEntry[];
  corridors: readonly CorridorRegistryEntry[];
  anchorCorridorMappings: readonly AnchorCorridorRegistryEntry[];
  reviewedLiveRateSources: readonly ReviewedLiveRateSource[];
}>;

/**
 * Builds a read-only summary of the reviewed registries. Pure function over
 * explicit inputs so it can be unit-tested without touching registry files.
 */
export function buildRegistrySummary(
  input: RegistrySummaryInput,
): RegistrySummary {
  const anchors = input.anchors.map((anchor) => {
    const mapping = input.anchorCorridorMappings.find(
      (candidate) => candidate.anchorSlug === anchor.slug,
    );
    const corridorSlugs = Object.freeze([...(mapping?.corridorSlugs ?? [])]);
    const reviewedRateSourceCount = input.reviewedLiveRateSources.filter(
      (source) => source.anchorSlug === anchor.slug,
    ).length;

    return Object.freeze({
      slug: anchor.slug,
      name: anchor.name,
      homeDomain: anchor.homeDomain,
      corridorSlugs,
      reviewedRateSourceCount,
    });
  });

  const corridors = input.corridors.map((corridor) => {
    const anchorSlugs = Object.freeze(
      input.anchorCorridorMappings
        .filter((mapping) => mapping.corridorSlugs.includes(corridor.slug))
        .map((mapping) => mapping.anchorSlug),
    );
    const hasReviewedRateSource = input.reviewedLiveRateSources.some(
      (source) => source.corridorSlug === corridor.slug,
    );

    return Object.freeze({
      slug: corridor.slug,
      route: corridorRoute(corridor),
      anchorSlugs,
      hasReviewedRateSource,
    });
  });

  return Object.freeze({
    anchors: Object.freeze(anchors),
    corridors: Object.freeze(corridors),
    reviewedRateSources: Object.freeze(
      input.reviewedLiveRateSources.map((source) => Object.freeze({
        anchorSlug: source.anchorSlug,
        corridorSlug: source.corridorSlug,
        sellAsset: source.sellAsset,
        buyAsset: source.buyAsset,
        context: source.context,
      })),
    ),
  });
}

/**
 * Renders the summary as readable text. Reads from a prebuilt summary only; it
 * never loads registry files, so formatting stays independently testable.
 */
export function formatRegistrySummary(summary: RegistrySummary): string {
  const lines: string[] = [];

  lines.push("StellarCore reviewed registry");
  lines.push("=============================");
  lines.push(
    `${summary.anchors.length} anchor(s), ` +
      `${summary.corridors.length} corridor(s), ` +
      `${summary.reviewedRateSources.length} reviewed live rate source(s).`,
  );

  lines.push("");
  lines.push("Anchors");
  lines.push("-------");
  if (summary.anchors.length === 0) {
    lines.push("(none)");
  }
  for (const anchor of summary.anchors) {
    lines.push(`${anchor.name} (${anchor.slug})`);
    lines.push(`  home domain: ${anchor.homeDomain}`);
    lines.push(`  corridors:   ${joinList(anchor.corridorSlugs)}`);
    lines.push(
      `  reviewed rate sources: ${anchor.reviewedRateSourceCount}`,
    );
  }

  lines.push("");
  lines.push("Corridors");
  lines.push("---------");
  if (summary.corridors.length === 0) {
    lines.push("(none)");
  }
  for (const corridor of summary.corridors) {
    lines.push(`${corridor.slug}`);
    lines.push(`  route:   ${corridor.route}`);
    lines.push(`  anchors: ${joinList(corridor.anchorSlugs)}`);
    lines.push(
      `  reviewed rate source: ${corridor.hasReviewedRateSource ? "yes" : "no"}`,
    );
  }

  lines.push("");
  lines.push("Known SEPs");
  lines.push("----------");
  lines.push(
    "  SEP-1, SEP-6, SEP-10, SEP-24, SEP-31, SEP-38 are the SEPs this project",
  );
  lines.push(
    "  models. The reviewed registry does not store SEP support: it is",
  );
  lines.push(
    "  discovered from each anchor's stellar.toml during registry bootstrap and",
  );
  lines.push(
    "  lives in the database. Run `npm run bootstrap:registry` (or query the",
  );
  lines.push(
    "  public /api/anchors endpoint) to see each anchor's discovered SEPs.",
  );

  return `${lines.join("\n")}\n`;
}

/** Summarizes the checked-in registries for printing. Purely read-only. */
export function currentRegistrySummary(): RegistrySummary {
  return buildRegistrySummary({
    anchors: ANCHOR_REGISTRY,
    corridors: CORRIDOR_REGISTRY,
    anchorCorridorMappings: ANCHOR_CORRIDOR_REGISTRY,
    reviewedLiveRateSources: REVIEWED_LIVE_RATE_SOURCES,
  });
}

function corridorRoute(corridor: CorridorRegistryEntry): string {
  return `${corridor.assetCodeFrom} (${corridor.countryFrom}) -> ` +
    `${corridor.assetCodeTo} (${corridor.countryTo})`;
}

function joinList(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}
