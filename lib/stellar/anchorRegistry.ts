import {
  canonicalizeHostname,
  isValidHostname,
} from "@/lib/stellar/hostname";
import type { AnchorRegistryEntry } from "@/types/anchor";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidHomeDomain(homeDomain: string): boolean {
  return isValidHostname(homeDomain);
}

export function validateAnchorRegistry(
  entries: readonly AnchorRegistryEntry[],
): void {
  const slugs = new Set<string>();
  const homeDomains = new Set<string>();

  for (const entry of entries) {
    if (!SLUG_PATTERN.test(entry.slug)) {
      throw new Error(`Invalid anchor slug: "${entry.slug}"`);
    }

    if (!entry.name.trim()) {
      throw new Error(`Anchor "${entry.slug}" has an empty name`);
    }

    const canonicalResult = canonicalizeHostname(entry.homeDomain);
    if (!canonicalResult.ok) {
      throw new Error(
        `Anchor "${entry.slug}" has an invalid home domain: "${entry.homeDomain}"`,
      );
    }

    if (slugs.has(entry.slug)) {
      throw new Error(`Duplicate anchor slug: "${entry.slug}"`);
    }

    if (homeDomains.has(canonicalResult.hostname)) {
      throw new Error(`Duplicate anchor home domain: "${entry.homeDomain}"`);
    }

    slugs.add(entry.slug);
    homeDomains.add(canonicalResult.hostname);
  }
}

