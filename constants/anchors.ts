import { validateAnchorRegistry } from "@/lib/stellar/anchorRegistry";
import type { AnchorRegistryEntry } from "@/types/anchor";

const anchorRegistry = [
  Object.freeze({
    slug: "moneygram",
    name: "MoneyGram",
    homeDomain: "mgxanchor.moneygram.com",
  }),
  Object.freeze({
    slug: "cowrie",
    name: "Cowrie",
    homeDomain: "cowrie.exchange",
  }),
  Object.freeze({
    slug: "zeam",
    name: "Zeam",
    homeDomain: "zeam.money",
  }),
] as const satisfies readonly AnchorRegistryEntry[];

validateAnchorRegistry(anchorRegistry);

export const ANCHOR_REGISTRY = Object.freeze(anchorRegistry);
