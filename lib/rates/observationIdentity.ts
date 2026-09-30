import { createHash } from "node:crypto";

import { formatDecimal, parseDatabaseDecimal } from "@/lib/rates/decimal";
import type { NormalizedRateObservation } from "@/types/rates";

const IDENTITY_VERSION = "rate-observation-v1";

/**
 * Deterministic identity of one logical rate observation.
 *
 * With an upstream quote identifier the identity is the anchor, corridor and
 * that identifier: the same upstream quote observed twice is one observation.
 *
 * SEP-38 indicative prices carry no identifier, so without one the identity is
 * the anchor, corridor, the priced amounts and rate (compared as numbers, so
 * "100" and "100.0" agree) and the instant StellarCore captured the response.
 * Replaying the same captured observation after a retry, restart, or ambiguous
 * database result therefore maps to the same key. A fresh fetch has a new
 * capture instant and is a new observation even when its numbers are equal.
 */
export function deriveObservationKey(
  observation: Pick<
    NormalizedRateObservation,
    | "anchorSlug"
    | "corridorSlug"
    | "rate"
    | "sourceAmount"
    | "destinationAmount"
    | "fee"
    | "capturedAt"
    | "upstreamQuoteId"
  >,
): string {
  const parts = observation.upstreamQuoteId
    ? [
        IDENTITY_VERSION,
        "quote",
        observation.anchorSlug,
        observation.corridorSlug,
        observation.upstreamQuoteId,
      ]
    : [
        IDENTITY_VERSION,
        "captured",
        observation.anchorSlug,
        observation.corridorSlug,
        canonicalDecimal(observation.rate),
        canonicalDecimal(observation.sourceAmount),
        canonicalDecimal(observation.destinationAmount),
        canonicalDecimal(observation.fee),
        String(observation.capturedAt.getTime()),
      ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function canonicalDecimal(value: string): string {
  return formatDecimal(parseDatabaseDecimal(value));
}
