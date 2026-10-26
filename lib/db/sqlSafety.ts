const STABLE_IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Restricts public slugs to the stable identifier grammar used by the registry.
 * This validation does not make interpolating values into raw SQL safe; raw SQL
 * must continue to bind values as parameters.
 */
export function assertSafeIdentifier(value: string, label: string): asserts value is string {
  if (!STABLE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}
