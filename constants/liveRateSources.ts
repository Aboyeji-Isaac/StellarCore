import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

export const ZEAM_USDC_ASSET =
  "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const ZEAM_BRL_ASSET = "iso4217:BRL";

const reviewedLiveRateSources = [
  Object.freeze({
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    sellAsset: ZEAM_USDC_ASSET,
    buyAsset: ZEAM_BRL_ASSET,
    sellAmount: "100",
    buyDeliveryMethod: "PIX",
    countryCode: "BR",
    context: "sep31",
  }),
] as const satisfies readonly ReviewedLiveRateSource[];

export const REVIEWED_LIVE_RATE_SOURCES = Object.freeze(reviewedLiveRateSources);
