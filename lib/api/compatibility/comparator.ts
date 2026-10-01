import { normalizePayload } from "@/lib/api/compatibility/normalizer";
import type {
  CompatibilityFixture,
  CompatibilityIssue,
  FixtureComparisonResult,
} from "@/lib/api/compatibility/types";

export type PayloadComparison = Readonly<{
  breakingIssues: readonly CompatibilityIssue[];
  additiveChanges: readonly CompatibilityIssue[];
}>;

export function comparePayloads(
  expectedRaw: unknown,
  actualRaw: unknown,
  currentPath = "$",
): PayloadComparison {
  const expected = normalizePayload(expectedRaw);
  const actual = normalizePayload(actualRaw);

  const breakingIssues: CompatibilityIssue[] = [];
  const additiveChanges: CompatibilityIssue[] = [];

  diffValues(expected, actual, currentPath, breakingIssues, additiveChanges);

  return Object.freeze({
    breakingIssues: Object.freeze(breakingIssues),
    additiveChanges: Object.freeze(additiveChanges),
  });
}

function diffValues(
  expected: unknown,
  actual: unknown,
  path: string,
  breakingIssues: CompatibilityIssue[],
  additiveChanges: CompatibilityIssue[],
): void {
  if (expected === actual) {
    return;
  }

  if (expected === null) {
    if (actual !== null) {
      breakingIssues.push(Object.freeze({
        path,
        severity: "breaking",
        message: `Expected null, but received ${describeType(actual)}`,
        expected,
        actual,
      }));
    }
    return;
  }

  if (actual === null) {
    breakingIssues.push(Object.freeze({
      path,
      severity: "breaking",
      message: `Expected non-null ${describeType(expected)}, but received null`,
      expected,
      actual,
    }));
    return;
  }

  if (typeof expected !== typeof actual) {
    breakingIssues.push(Object.freeze({
      path,
      severity: "breaking",
      message: `Type mismatch: expected ${describeType(expected)}, but received ${describeType(actual)}`,
      expected,
      actual,
    }));
    return;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      breakingIssues.push(Object.freeze({
        path,
        severity: "breaking",
        message: `Expected array, but received ${describeType(actual)}`,
        expected,
        actual,
      }));
      return;
    }

    if (expected.length !== actual.length) {
      breakingIssues.push(Object.freeze({
        path,
        severity: "breaking",
        message: `Array length mismatch: expected ${expected.length}, but received ${actual.length}`,
        expected: expected.length,
        actual: actual.length,
      }));
    }

    const minLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < minLength; index += 1) {
      diffValues(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        breakingIssues,
        additiveChanges,
      );
    }

    if (actual.length > expected.length) {
      for (let index = expected.length; index < actual.length; index += 1) {
        breakingIssues.push(Object.freeze({
          path: `${path}[${index}]`,
          severity: "breaking",
          message: `Unexpected extra array element at index ${index}`,
          expected: undefined,
          actual: actual[index],
        }));
      }
    }

    return;
  }

  if (typeof expected === "object") {
    if (Array.isArray(actual)) {
      breakingIssues.push(Object.freeze({
        path,
        severity: "breaking",
        message: `Expected object, but received array`,
        expected,
        actual,
      }));
      return;
    }

    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;

    for (const key of Object.keys(expectedRecord)) {
      const childPath = path === "$" ? key : `${path}.${key}`;
      if (!(key in actualRecord)) {
        breakingIssues.push(Object.freeze({
          path: childPath,
          severity: "breaking",
          message: `Missing required field: '${key}'`,
          expected: expectedRecord[key],
          actual: undefined,
        }));
      } else {
        diffValues(
          expectedRecord[key],
          actualRecord[key],
          childPath,
          breakingIssues,
          additiveChanges,
        );
      }
    }

    for (const key of Object.keys(actualRecord)) {
      const childPath = path === "$" ? key : `${path}.${key}`;
      if (!(key in expectedRecord)) {
        additiveChanges.push(Object.freeze({
          path: childPath,
          severity: "additive",
          message: `Additive field detected: '${key}'`,
          expected: undefined,
          actual: actualRecord[key],
        }));
      }
    }

    return;
  }

  breakingIssues.push(Object.freeze({
    path,
    severity: "breaking",
    message: `Value mismatch: expected ${JSON.stringify(expected)}, but received ${JSON.stringify(actual)}`,
    expected,
    actual,
  }));
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function compareFixtureAgainstResponse(
  fixture: CompatibilityFixture,
  actualStatus: number,
  actualBody: unknown,
): FixtureComparisonResult {
  const breakingIssues: CompatibilityIssue[] = [];
  const additiveChanges: CompatibilityIssue[] = [];

  if (fixture.expectedStatus !== actualStatus) {
    breakingIssues.push(Object.freeze({
      path: "status",
      severity: "breaking",
      message: `HTTP status code regression: expected ${fixture.expectedStatus}, but received ${actualStatus}`,
      expected: fixture.expectedStatus,
      actual: actualStatus,
    }));
  }

  const payloadDiff = comparePayloads(fixture.body, actualBody);
  breakingIssues.push(...payloadDiff.breakingIssues);
  additiveChanges.push(...payloadDiff.additiveChanges);

  return Object.freeze({
    fixtureName: fixture.name,
    domain: fixture.domain,
    endpoint: fixture.endpoint,
    expectedStatus: fixture.expectedStatus,
    actualStatus,
    ok: breakingIssues.length === 0,
    breakingIssues: Object.freeze(breakingIssues),
    additiveChanges: Object.freeze(additiveChanges),
  });
}
