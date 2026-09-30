/*
 * Utility functions for safe construction of Prisma raw SQL queries.
 * Provides identifier sanitization and a template tag for parameterized queries.
 */

import { sql } from '@prisma/client/runtime';

/**
 * Whitelist of allowed identifiers (table and column names).
 * Extend as needed for new queries.
 */
const ALLOWED_IDENTIFIERS = new Set<string>([
  'Observation',
  'Account',
  'Transaction',
  // add other known identifiers
]);

/**
 * Returns a sanitized identifier wrapped in backticks.
 * Throws if the identifier is not in the allowlist.
 */
export function safeIdentifier(name: string): string {
  if (!ALLOWED_IDENTIFIERS.has(name)) {
    throw new Error(`Unsafe identifier "${name}" is not allowed`);
  }
  // Escape backticks inside name (should not happen for allowed identifiers)
  const escaped = name.replace(/`/g, '``');
  return `\`${escaped}\``;
}

/**
 * Template tag for constructing raw SQL with safe identifiers.
 * Usage:
 *   const query = rawSql`SELECT * FROM ${safeIdentifier('Observation')} WHERE id = ${id}`;
 * The tag treats interpolated values as parameters (via Prisma.sql) and identifiers
 * must be passed through safeIdentifier().
 */
export function rawSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const parts: (string | typeof sql)[] = [];
  strings.forEach((str, i) => {
    parts.push(str);
    if (i < values.length) {
      const val = values[i];
      // Identifier safety is enforced by caller; we treat all values as parameters.
      parts.push(sql`${val}`);
    }
  });
  // Join parts into a single Prisma.sql template literal
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (sql as any)(...parts);
}
