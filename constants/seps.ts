export const SEPS = {
  SEP_1: 1,
  SEP_6: 6,
  SEP_10: 10,
  SEP_24: 24,
  SEP_31: 31,
  SEP_38: 38,
} as const;

export type StellarSep = (typeof SEPS)[keyof typeof SEPS];

export const TRANSFER_SEPS = [
  SEPS.SEP_6,
  SEPS.SEP_24,
  SEPS.SEP_31,
] as const satisfies readonly StellarSep[];
