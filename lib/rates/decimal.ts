const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MAX_PRECISION = 38;
const MAX_SCALE = 18;
const MAX_INTEGER_DIGITS = MAX_PRECISION - MAX_SCALE;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const FIVE = BigInt(5);
const TEN = BigInt(10);

export class DecimalValidationError extends Error {
  constructor(message = "Invalid Decimal(38,18) value") {
    super(message);
    this.name = "DecimalValidationError";
  }
}

export type ExactDecimal = Readonly<{
  coefficient: bigint;
  scale: number;
}>;

export function parseDatabaseDecimal(value: string): ExactDecimal {
  if (!DECIMAL_PATTERN.test(value)) throw new DecimalValidationError();

  const [integer, fraction = ""] = value.split(".");
  if (fraction.length > MAX_SCALE || integer.length > MAX_INTEGER_DIGITS) {
    throw new DecimalValidationError();
  }

  const digits = `${integer}${fraction}`;
  if (digits.length > MAX_PRECISION) throw new DecimalValidationError();
  return normalizeDecimal({ coefficient: BigInt(digits), scale: fraction.length });
}

export function compareDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftValue = left.coefficient * powerOfTen(scale - left.scale);
  const rightValue = right.coefficient * powerOfTen(scale - right.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function averageDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const sum =
    left.coefficient * powerOfTen(scale - left.scale) +
    right.coefficient * powerOfTen(scale - right.scale);
  return sum % TWO === ZERO
    ? normalizeDecimal({ coefficient: sum / TWO, scale })
    : normalizeDecimal({ coefficient: sum * FIVE, scale: scale + 1 });
}

export function formatDecimal(value: ExactDecimal): string {
  const normalized = normalizeDecimal(value);
  const digits = normalized.coefficient.toString();
  if (normalized.scale === 0) return digits;
  const padded = digits.padStart(normalized.scale + 1, "0");
  const split = padded.length - normalized.scale;
  return `${padded.slice(0, split)}.${padded.slice(split)}`;
}

export function isZeroDecimal(value: ExactDecimal): boolean {
  return value.coefficient === ZERO;
}

export function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const sum =
    left.coefficient * powerOfTen(scale - left.scale) +
    right.coefficient * powerOfTen(scale - right.scale);
  return normalizeDecimal({ coefficient: sum, scale });
}

export function subtractDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const diff =
    left.coefficient * powerOfTen(scale - left.scale) -
    right.coefficient * powerOfTen(scale - right.scale);
  return normalizeDecimal({ coefficient: diff, scale });
}

export function multiplyDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const coefficient = left.coefficient * right.coefficient;
  const scale = left.scale + right.scale;
  return normalizeDecimal({ coefficient, scale });
}

export function absDecimalDiff(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const leftScaled = left.coefficient * powerOfTen(scale - left.scale);
  const rightScaled = right.coefficient * powerOfTen(scale - right.scale);
  const diff = leftScaled >= rightScaled ? leftScaled - rightScaled : rightScaled - leftScaled;
  return normalizeDecimal({ coefficient: diff, scale });
}

export function oneUlp(scale: number): ExactDecimal {
  return normalizeDecimal({ coefficient: ONE, scale: Math.max(0, scale) });
}

export function maxDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return compareDecimals(left, right) >= 0 ? left : right;
}

function normalizeDecimal(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % TEN === ZERO) {
    coefficient /= TEN;
    scale -= 1;
  }
  return Object.freeze({ coefficient, scale });
}

function powerOfTen(exponent: number): bigint {
  let result = ONE;
  for (let index = 0; index < exponent; index += 1) result *= TEN;
  return result;
}
