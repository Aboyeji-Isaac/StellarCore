import type { PublicCorridor } from "@/types/api/corridors";

/**
 * Client-side, case-insensitive substring search over the existing corridor
 * data. Matches source/destination asset codes and source/destination
 * countries. An empty query matches every corridor.
 */
export function searchCorridors(
  corridors: readonly PublicCorridor[],
  query: string,
): readonly PublicCorridor[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return Object.freeze([...corridors]);
  }

  return Object.freeze(corridors.filter((corridor) =>
    corridor.sourceAsset.toLowerCase().includes(normalized)
    || corridor.sourceCountry.toLowerCase().includes(normalized)
    || corridor.destinationAsset.toLowerCase().includes(normalized)
    || corridor.destinationCountry.toLowerCase().includes(normalized),
  ));
}