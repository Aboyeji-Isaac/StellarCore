import type { StellarSep } from "@/constants/seps";

export type AnchorRegistryEntry = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
}>;

export type DiscoveredAnchorEndpoints = Readonly<{
  transferServer?: string;
  transferServerSep24?: string;
  webAuthEndpoint?: string;
  kycServer?: string;
  directPaymentServer?: string;
  anchorQuoteServer?: string;
}>;

export type DiscoveredAnchorAsset = Readonly<{
  code: string;
  issuer?: string;
  status?: string;
  isAssetAnchored?: boolean;
  anchorAssetType?: string;
  anchorAsset?: string;
}>;

export type Sep1Data = Readonly<{
  organizationName: string;
  organizationUrl?: string;
  networkPassphrase: string;
  seps: readonly StellarSep[];
  endpoints: DiscoveredAnchorEndpoints;
  signingKey?: string;
  assets: readonly DiscoveredAnchorAsset[];
}>;

export type DiscoveredAnchor = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  tomlUrl: string;
  organizationName: string;
  organizationUrl?: string;
  networkPassphrase: string;
  seps: readonly StellarSep[];
  isTransferCapable: boolean;
  endpoints: DiscoveredAnchorEndpoints;
  signingKey?: string;
  assets: readonly DiscoveredAnchorAsset[];
}>;
