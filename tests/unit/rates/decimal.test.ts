import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  absDecimalDiff,
  addDecimals,
  formatDecimal,
  maxDecimal,
  multiplyDecimals,
  oneUlp,
  parseDatabaseDecimal,
  subtractDecimals,
} from "@/lib/rates/decimal";

describe("ExactDecimal math operations", () => {
  test("addDecimals computes exact sums without floating-point errors", () => {
    const a = parseDatabaseDecimal("0.1");
    const b = parseDatabaseDecimal("0.2");
    const sum = addDecimals(a, b);
    assert.equal(formatDecimal(sum), "0.3");
  });

  test("subtractDecimals computes exact differences", () => {
    const a = parseDatabaseDecimal("100.50");
    const b = parseDatabaseDecimal("0.25");
    const diff = subtractDecimals(a, b);
    assert.equal(formatDecimal(diff), "100.25");
  });

  test("multiplyDecimals preserves exact precision with arbitrary digits", () => {
    const a = parseDatabaseDecimal("100.5");
    const b = parseDatabaseDecimal("2.5");
    const product = multiplyDecimals(a, b);
    // 100.5 * 2.5 = 251.25
    assert.equal(formatDecimal(product), "251.25");
  });

  test("multiplyDecimals handles 18-decimal numbers accurately", () => {
    const a = parseDatabaseDecimal("1.000000000000000001");
    const b = parseDatabaseDecimal("100");
    const product = multiplyDecimals(a, b);
    assert.equal(formatDecimal(product), "100.0000000000000001");
  });

  test("absDecimalDiff returns positive absolute difference regardless of operand order", () => {
    const a = parseDatabaseDecimal("10.50");
    const b = parseDatabaseDecimal("20.75");
    assert.equal(formatDecimal(absDecimalDiff(a, b)), "10.25");
    assert.equal(formatDecimal(absDecimalDiff(b, a)), "10.25");
  });

  test("oneUlp returns exact 10^-scale decimal", () => {
    assert.equal(formatDecimal(oneUlp(0)), "1");
    assert.equal(formatDecimal(oneUlp(2)), "0.01");
    assert.equal(formatDecimal(oneUlp(7)), "0.0000001");
  });

  test("maxDecimal returns the larger decimal value", () => {
    const a = parseDatabaseDecimal("3.14");
    const b = parseDatabaseDecimal("3.141");
    assert.equal(formatDecimal(maxDecimal(a, b)), "3.141");
    assert.equal(formatDecimal(maxDecimal(b, a)), "3.141");
  });
});
