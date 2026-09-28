import type { SourceAuthorityRegistryEntry } from "@/types/sourceAuthority";

/**
 * Reviewed source-authority registry.
 *
 * This is the only place that decides which anchors share an operator. Two
 * differently named anchors, hosts, or issuer accounts do not by themselves
 * prove independent control, so independence is recorded here by maintainer
 * review instead of being inferred at runtime.
 *
 * `authorityId` values are opaque and assigned once at review time. They are
 * never derived from display text, anchor slugs, home domains, endpoint
 * hostnames, IP addresses, issuer accounts, branding, or price similarity, and
 * they never change when `displayName` changes. A reviewed revision of an
 * existing identity bumps `configurationVersion` rather than minting a new id.
 *
 * Current reviewed USDC -> BRL source: Zeam only, so exactly one authority.
 */
const sourceAuthorities = [
  Object.freeze({
    authorityId: "auth-0001",
    displayName: "Zeam",
    configurationVersion: 1,
  }),
] as const satisfies readonly SourceAuthorityRegistryEntry[];

export const SOURCE_AUTHORITY_REGISTRY = Object.freeze(sourceAuthorities);
