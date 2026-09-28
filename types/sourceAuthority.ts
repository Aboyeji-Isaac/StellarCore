/**
 * A reviewed source authority is the maintainer-reviewed operator behind one
 * or more reviewed anchors. Authority is a governance classification recorded
 * in reviewed configuration, not something inferred at runtime from matching
 * domains, IP addresses, issuer accounts, branding, or price similarity.
 */
export type SourceAuthorityRegistryEntry = Readonly<{
  /**
   * Stable opaque identifier assigned once at review time. It is never derived
   * from display text, an anchor slug, a home domain, or an endpoint hostname,
   * and it never changes when `displayName` changes.
   */
  authorityId: string;
  /** Human-readable label only. Renaming it never creates a new authority. */
  displayName: string;
  /**
   * Reviewed revision of this authority identity. Bumping it records a
   * reviewed configuration change without creating a new independent
   * authority, and it is persisted with every captured observation.
   */
  configurationVersion: number;
}>;
