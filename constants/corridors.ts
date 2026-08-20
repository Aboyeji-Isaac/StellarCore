import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  validateAnchorCorridorRegistry,
  validateCorridorRegistry,
} from "@/lib/stellar/corridorRegistry";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

const corridorRegistry = [
  // Live SEP-24 USDC plus MoneyGram US cash-ramp and USD-reference docs.
  Object.freeze({
    slug: "usdc-us-usd-us",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "USD",
    countryTo: "US",
  }),
  // Live SEP-1 NGNT-to-NGN anchoring plus Cowrie enabled SEP-6 NGNT rail.
  Object.freeze({
    slug: "ngnt-ng-ngn-ng",
    assetCodeFrom: "NGNT",
    countryFrom: "NG",
    assetCodeTo: "NGN",
    countryTo: "NG",
  }),
] as const satisfies readonly CorridorRegistryEntry[];

const anchorCorridorRegistry = [
  Object.freeze({
    anchorSlug: "moneygram",
    corridorSlugs: Object.freeze(["usdc-us-usd-us"]),
  }),
  Object.freeze({
    anchorSlug: "cowrie",
    corridorSlugs: Object.freeze(["ngnt-ng-ngn-ng"]),
  }),
] as const satisfies readonly AnchorCorridorRegistryEntry[];

validateCorridorRegistry(corridorRegistry);
validateAnchorCorridorRegistry(
  anchorCorridorRegistry,
  corridorRegistry,
  ANCHOR_REGISTRY,
);

export const CORRIDOR_REGISTRY = Object.freeze(corridorRegistry);
export const ANCHOR_CORRIDOR_REGISTRY = Object.freeze(anchorCorridorRegistry);
