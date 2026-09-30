const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const DECIMAL_SCALE = 18;
const DECIMAL_FACTOR = BigInt(10) ** BigInt(DECIMAL_SCALE);
const MAX_PRECISION_VALUE = BigInt(10) ** BigInt(38) - BigInt(1);

export type OutcomeMetric = "fillRate" | "slippage";

export function parseOutcomeMetric(value: string, metric: OutcomeMetric): bigint {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`Invalid ${metric}: expected a plain decimal string`);
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  if (fraction.length > DECIMAL_SCALE || digits.length > 38) {
    throw new Error(`Invalid ${metric}: precision exceeds NUMERIC(38,18)`);
  }

  const scaled = BigInt(integer) * DECIMAL_FACTOR
    + BigInt(fraction.padEnd(DECIMAL_SCALE, "0") || "0");
  const signed = negative ? -scaled : scaled;
  if (metric === "fillRate" && (signed < BigInt(0) || signed > DECIMAL_FACTOR)) {
    throw new Error("Invalid fillRate: expected a value from 0 through 1");
  }
  if (metric === "fillRate" && integer.length > 1) {
    throw new Error("Invalid fillRate: precision exceeds NUMERIC(19,18)");
  }
  if (metric === "slippage" && (signed < -MAX_PRECISION_VALUE || signed > MAX_PRECISION_VALUE)) {
    throw new Error("Invalid slippage: precision exceeds NUMERIC(38,18)");
  }
  return signed;
}

export function normalizeOutcomeMetric(value: string, metric: OutcomeMetric): string {
  return formatOutcomeMetric(parseOutcomeMetric(value, metric));
}

export function formatOutcomeMetric(scaled: bigint): string {
  const negative = scaled < BigInt(0);
  const magnitude = negative ? -scaled : scaled;
  const integer = magnitude / DECIMAL_FACTOR;
  const fraction = (magnitude % DECIMAL_FACTOR)
    .toString()
    .padStart(DECIMAL_SCALE, "0")
    .replace(/0+$/, "");
  const sign = negative && magnitude !== BigInt(0) ? "-" : "";
  return `${sign}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function basisPointsToOutcomeMetric(basisPoints: number): string {
  return formatOutcomeMetric(BigInt(basisPoints) * BigInt(10) ** BigInt(14));
}