import type { AnchorRegistryEntry } from "@/types/anchor";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HOME_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

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

    if (!HOME_DOMAIN_PATTERN.test(entry.homeDomain)) {
      throw new Error(
        `Anchor "${entry.slug}" has an invalid home domain: "${entry.homeDomain}"`,
      );
    }

    if (slugs.has(entry.slug)) {
      throw new Error(`Duplicate anchor slug: "${entry.slug}"`);
    }

    if (homeDomains.has(entry.homeDomain)) {
      throw new Error(`Duplicate anchor home domain: "${entry.homeDomain}"`);
    }

    slugs.add(entry.slug);
    homeDomains.add(entry.homeDomain);
  }
}
