import { SEPS, type StellarSep } from "@/constants/seps";

export type AdvertisedCapability = Readonly<{
  sep: StellarSep;
  label: string;
}>;

const KNOWN_ADVERTISED_CAPABILITIES = Object.freeze([
  Object.freeze({ sep: SEPS.SEP_6, label: "SEP-6 transfer server advertised" }),
  Object.freeze({ sep: SEPS.SEP_10, label: "SEP-10 web-auth endpoint advertised" }),
  Object.freeze({ sep: SEPS.SEP_24, label: "SEP-24 interactive transfer server advertised" }),
  Object.freeze({ sep: SEPS.SEP_31, label: "SEP-31 direct-payment server advertised" }),
  Object.freeze({ sep: SEPS.SEP_38, label: "SEP-38 quote server advertised" }),
] as const satisfies readonly AdvertisedCapability[]);

/**
 * Maps only known persisted SEP numbers to cautious presentation labels. These
 * labels describe metadata observed during the last successful SEP-1 sync;
 * they do not verify current anchor operation or StellarCore authority.
 */
export function advertisedCapabilities(
  seps: readonly number[],
): readonly AdvertisedCapability[] {
  return Object.freeze(KNOWN_ADVERTISED_CAPABILITIES
    .filter(({ sep }) => seps.includes(sep))
    .map((capability) => Object.freeze({ ...capability })));
}
