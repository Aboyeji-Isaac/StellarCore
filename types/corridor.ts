export type CorridorRegistryEntry = Readonly<{
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
}>;

export type AnchorCorridorRegistryEntry = Readonly<{
  anchorSlug: string;
  corridorSlugs: readonly string[];
}>;
