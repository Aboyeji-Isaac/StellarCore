/**
 * Deterministic input generator for parser property/fuzz tests (#141).
 *
 * A seeded xorshift128 PRNG makes every generated corpus reproducible:
 * running the suite with the same seed produces the same inputs, so a
 * discovered failure can be replayed locally with the exact printed seed.
 * All generation is bounded (length caps everywhere) so the harness itself
 * can never cause uncontrolled resource use.
 */

export class SeededRandom {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // Spread the seed across the four state words with a simple hash so
    // nearby seeds produce very different streams.
    let x = seed | 0 || 0x9e3779b9;
    const next = () => {
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
      return (x ^ (x >>> 15)) | 0;
    };
    this.s0 = next() || 1;
    this.s1 = next() || 2;
    this.s2 = next() || 3;
    this.s3 = next() || 4;
  }

  /** Next raw 32-bit value as an unsigned integer. */
  nextUint(): number {
    const t = this.s3;
    const s = this.s2;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = this.s0;
    let result = 0;
    result ^= (t << 11) & 0xffffffff;
    this.s0 = (this.s0 ^ t ^ (this.s0 >>> 8) ^ s) | 0;
    result = (this.s0 ^ result) >>> 0;
    return result;
  }

  /** Uniform float in [0, 1). */
  nextFloat(): number {
    return this.nextUint() / 0x100000000;
  }

  /** Integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.nextFloat() * maxExclusive) % maxExclusive;
  }

  /** True with the given probability (0..1). */
  chance(probability: number): boolean {
    return this.nextFloat() < probability;
  }

  /** Picks a random element. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }

  /** Picks or returns undefined with the given probability of skipping. */
  pickOptional<T>(items: readonly T[], skipProbability = 0.3): T | undefined {
    if (this.chance(skipProbability)) return undefined;
    return this.pick(items);
  }
}

/** Canonical URL string that parses cleanly, with mutated variants. */
export const URL_FIELD_NAMES = [
  "TRANSFER_SERVER",
  "TRANSFER_SERVER_SEP0024",
  "WEB_AUTH_ENDPOINT",
  "KYC_SERVER",
  "DIRECT_PAYMENT_SERVER",
  "ANCHOR_QUOTE_SERVER",
] as const;

export const FEE_DETAIL_NAMES = [
  "service",
  "network",
  "spread",
  "fx_markup",
  "regulatory",
] as const;

export const DELIVERY_METHOD_NAMES = [
  "bank_transfer",
  "cash_pickup",
  "mobile_money",
  "wallet",
] as const;

export const COUNTRY_CODES = ["US", "BR", "NG", "GB", "AR", "MX", "KE", "PH"] as const;

export const ASSET_CODES = ["USDC", "BRL", "NGNT", "XLM", "EURC", "ARS", "KES"] as const;

export const ISO_CODES = ["USD", "BRL", "EUR", "NGN", "ARS", "KES", "PHP"] as const;

/** Issuer keys: one valid, several structurally close but invalid. */
export const ISSUER_KEYS = [
  // Valid SEP-11 issuer (well-known test issuer format, checksum-corrected at runtime).
  "GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF",
  // Wrong checksum / wrong version byte / too short variants.
  "GA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZ0",
  "MA5XIGA5C7QTPTWXQHY6MCJLMTR4ZVWDKJLMZJKQFGXVITFZPEQX3KZF",
  "GBBD47IF6LWK7P7MDEVSCWR7DPUYVGLNNJB2NH7OZAPMVQKBZ4UANFCS",
] as const;

/** Unicode samples: combining marks, RTL, emoji, zero-width, control chars. */
export const UNICODE_FRAGMENTS = [
  "café",
  "日本",
  "Ωμέγα",
  "‎invisible",
  "zero​width",
  "emoji🚀",
  "tab\there",
  "new\nline",
  "carriage\rreturn",
  "nul\u0000byte",
  "quote\"double",
  "back\\slash",
] as const;

/** Strings that commonly break naive parsers. */
export const BREAKING_STRINGS = [
  "",
  " ",
  "0",
  "-0",
  "0.0",
  "00",
  "01",
  ".5",
  "5.",
  "1e3",
  "1E3",
  "+1",
  "-1",
  "Infinity",
  "NaN",
  "null",
  "undefined",
  "true",
  "[]",
  "{}",
  "0x10",
  "999999999999999999999999",
  "1.7976931348623157e309",
  "5e-324",
  "%s",
  "${var}",
  "{{template}}",
] as const;

/** Bounded string builder with weighted fragment selection. */
export function mutateString(
  random: SeededRandom,
  base: string,
  maxLength: number,
): string {
  const fragments = [base, ...UNICODE_FRAGMENTS, ...BREAKING_STRINGS];
  let result = random.pick(fragments);
  const extra = random.nextInt(4);
  for (let i = 0; i < extra && result.length < maxLength; i += 1) {
    result += random.pick(fragments);
  }
  return result.slice(0, maxLength);
}
