import type { PublicAnchorSummary } from "@/types/api/anchors";

/**
 * Returns the distinct SEP numbers actually present in the directory data,
 * sorted ascending. Filter options are derived from real data rather than a
 * hardcoded supported-SEP list.
 */
export function availableSepFilters(
  anchors: readonly PublicAnchorSummary[],
): readonly number[] {
  const seps = new Set<number>();
  for (const anchor of anchors) {
    for (const sep of anchor.seps) {
      seps.add(sep);
    }
  }
  return Object.freeze([...seps].sort((left, right) => left - right));
}

/**
 * Client-side SEP filter. Selecting one SEP shows anchors advertising it;
 * selecting several shows anchors advertising at least one of them; selecting
 * none shows every anchor.
 */
export function filterAnchorsBySeps(
  anchors: readonly PublicAnchorSummary[],
  selectedSeps: ReadonlySet<number>,
): readonly PublicAnchorSummary[] {
  if (selectedSeps.size === 0) {
    return Object.freeze([...anchors]);
  }
  return Object.freeze(anchors.filter((anchor) =>
    anchor.seps.some((sep) => selectedSeps.has(sep)),
  ));
}