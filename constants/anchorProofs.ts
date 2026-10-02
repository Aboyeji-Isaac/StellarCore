import type { DomainControlProof } from "@/lib/stellar/domainControl";

export const ANCHOR_PROOFS = Object.freeze({
  moneygram: Object.freeze({
    version: 1,
    homeDomain: "mgxanchor.moneygram.com",
    changeHash: "c63264cccb022c44a435a47ca47d49acff28740654f352b535bc359cb124ea38",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2036-01-01T00:00:00.000Z",
    nonce: "085264b218333511d3293b5f88556b31",
    signature: "ce9f94fd12cfbcb509b2d5562aa47cd71a623f6585bf34b21c654428a032fec7",
  }),
  cowrie: Object.freeze({
    version: 1,
    homeDomain: "cowrie.exchange",
    changeHash: "cf9265948645b99bd354bc845fb033759f0c72f9be26d7d6a37c6a0cae192176",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2036-01-01T00:00:00.000Z",
    nonce: "73f204fe56040db1e591c0ce2d020d66",
    signature: "df1f981e3eda4af22446ab81d116feea678e01adc200062001262111f3962f88",
  }),
  zeam: Object.freeze({
    version: 1,
    homeDomain: "zeam.money",
    changeHash: "61d2ad861c2f49e11154f30c0e2736d07ba8371ceff9c4026a21fc0384e7a21c",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2036-01-01T00:00:00.000Z",
    nonce: "c8418d19cbc7a09273c20ed636d99999",
    signature: "41980a58ed639f5d6e3bb0feaad568c6c68e0884796bbd44a795bb49796652b3",
  }),
} as const satisfies Record<string, DomainControlProof>);

export function getAnchorProof(slug: string): DomainControlProof | undefined {
  return ANCHOR_PROOFS[slug as keyof typeof ANCHOR_PROOFS];
}

export function hasAnchorProof(slug: string): boolean {
  return slug in ANCHOR_PROOFS;
}