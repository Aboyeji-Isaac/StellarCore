import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export function validateCorridorRegistry(
  entries: readonly CorridorRegistryEntry[],
): void {
  const slugs = new Set<string>();

  for (const entry of entries) {
    if (!SLUG_PATTERN.test(entry.slug)) {
      throw new Error(`Invalid corridor slug: "${entry.slug}"`);
    }

    validateAssetCode(entry.slug, "assetCodeFrom", entry.assetCodeFrom);
    validateAssetCode(entry.slug, "assetCodeTo", entry.assetCodeTo);
    validateCountryCode(entry.slug, "countryFrom", entry.countryFrom);
    validateCountryCode(entry.slug, "countryTo", entry.countryTo);

    if (slugs.has(entry.slug)) {
      throw new Error(`Duplicate corridor slug: "${entry.slug}"`);
    }

    slugs.add(entry.slug);
  }
}

export function validateAnchorCorridorRegistry(
  mappings: readonly AnchorCorridorRegistryEntry[],
  corridors: readonly CorridorRegistryEntry[],
  anchors: readonly AnchorRegistryEntry[],
): void {
  const knownCorridors = new Set(corridors.map(({ slug }) => slug));
  const knownAnchors = new Set(anchors.map(({ slug }) => slug));
  const mappedAnchors = new Set<string>();

  for (const mapping of mappings) {
    if (!knownAnchors.has(mapping.anchorSlug)) {
      throw new Error(`Unknown anchor slug: "${mapping.anchorSlug}"`);
    }

    if (mappedAnchors.has(mapping.anchorSlug)) {
      throw new Error(`Duplicate anchor mapping: "${mapping.anchorSlug}"`);
    }

    if (mapping.corridorSlugs.length === 0) {
      throw new Error(`Anchor "${mapping.anchorSlug}" has no corridors`);
    }

    const mappedCorridors = new Set<string>();

    for (const corridorSlug of mapping.corridorSlugs) {
      if (!knownCorridors.has(corridorSlug)) {
        throw new Error(`Unknown corridor slug: "${corridorSlug}"`);
      }

      if (mappedCorridors.has(corridorSlug)) {
        throw new Error(
          `Duplicate corridor "${corridorSlug}" for anchor "${mapping.anchorSlug}"`,
        );
      }

      mappedCorridors.add(corridorSlug);
    }

    mappedAnchors.add(mapping.anchorSlug);
  }
}

function validateAssetCode(
  slug: string,
  field: "assetCodeFrom" | "assetCodeTo",
  value: string,
): void {
  if (!ASSET_CODE_PATTERN.test(value)) {
    throw new Error(`Corridor "${slug}" has an invalid ${field}: "${value}"`);
  }
}

function validateCountryCode(
  slug: string,
  field: "countryFrom" | "countryTo",
  value: string,
): void {
  if (!COUNTRY_CODE_PATTERN.test(value)) {
    throw new Error(`Corridor "${slug}" has an invalid ${field}: "${value}"`);
  }
}
