/**
 * Deterministic seeded generator for property/fuzz tests (issue #141).
 *
 * A tiny, self-contained PCG-like generator so failing seeds are reproducible
 * locally with `--test-name-pattern` or by re-running the exact seed printed
 * in the failure. Generated inputs are bounded so the harness itself cannot
 * cause uncontrolled resource use: every length/density parameter has a hard
 * cap asserted by the tests that use it.
 */
export type Seed = number;

export class DeterministicRandom {
  private state: number;

  constructor(seed: Seed) {
    assertBounded(seed, 0, 0xffffffff, "seed");
    // Avoid the degenerate zero state.
    this.state = (seed ^ 0x9e3779b9) >>> 0 || 0x1234_5678;
  }

  /** Unsigned 32-bit integer. */
  nextUint32(): number {
    // mulberry32-style generator: deterministic across Node versions.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  }

  /** Integer in [min, max] inclusive; min >= 0, max <= 2^31-1. */
  nextInt(min: number, max: number): number {
    assertBounded(min, 0, 0x7fffffff, "min");
    assertBounded(max, min, 0x7fffffff, "max");
    return min + (this.nextUint32() % (max - min + 1));
  }

  nextBoolean(trueProbability = 0.5): boolean {
    return this.nextUint32() / 0x1_0000_0000 < trueProbability;
  }

  pick<T>(values: readonly T[]): T {
    assert.ok(values.length > 0, "pick requires a non-empty list");
    return values[this.nextInt(0, values.length - 1)]!;
  }

  /** String of length [minLength, maxLength] drawn from `alphabet`. */
  nextString(alphabet: string, minLength: number, maxLength: number): string {
    const length = this.nextInt(minLength, maxLength);
    let result = "";
    for (let i = 0; i < length; i += 1) {
      result += alphabet[this.nextInt(0, alphabet.length - 1)];
    }
    return result;
  }
}

import assert from "node:assert/strict";

function assertBounded(value: number, min: number, max: number, label: string): void {
  assert.ok(
    Number.isInteger(value) && value >= min && value <= max,
    `${label} must be an integer in [${min}, ${max}], got ${value}`,
  );
}
