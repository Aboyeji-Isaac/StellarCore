/**
 * Pagination utilities for list endpoints.
 *
 * Cursor-based pagination using base64url-encoded slugs:
 * - Opaque and URL-safe (no server state required)
 * - Deterministic slug ordering prevents duplication/omission
 * - Stable across concurrent modifications
 */

export type PaginationParams = Readonly<{
  limit: number;
  after: string | null;
}>;

export type PaginationResponse<T> = Readonly<{
  limit: number;
  next: string | null;
  items: readonly T[];
}>;

/**
 * Validates and normalizes pagination parameters.
 * @param limit - Requested items per page (clamped to [1, maxLimit])
 * @param after - Cursor to start from (optional, validated before use)
 * @param maxLimit - Maximum allowed limit (typically 500)
 * @returns Validated pagination params
 */
export function validatePaginationParams(
  limit: number | undefined | null,
  after: string | undefined | null,
  maxLimit: number = 500,
): PaginationParams {
  let normalizedLimit = limit ?? 100;
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1) {
    normalizedLimit = 100;
  }
  if (normalizedLimit > maxLimit) {
    normalizedLimit = maxLimit;
  }

  const normalizedAfter = after && typeof after === "string" && after.trim().length > 0
    ? after.trim()
    : null;

  return Object.freeze({ limit: normalizedLimit, after: normalizedAfter });
}

/**
 * Encodes a slug as a cursor (base64url without padding).
 * @param slug - The anchor or corridor slug
 * @returns URL-safe cursor string
 */
export function encodeCursor(slug: string): string {
  const buffer = Buffer.from(slug, "utf-8");
  return buffer.toString("base64url");
}

/**
 * Decodes a cursor back to a slug.
 * @param cursor - The cursor string
 * @returns The decoded slug, or null if invalid
 */
export function decodeCursor(cursor: string): string | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    // Verify it's a valid slug format
    if (decoded.length > 0 && decoded.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(decoded)) {
      return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Finds the index of the item to start from (exclusive of this index).
 * @param items - Array of items with a slug property
 * @param afterSlug - The slug cursor (already decoded)
 * @returns Index to start from, or -1 if cursor not found (use 0)
 */
export function findCursorIndex<T extends { slug: string }>(
  items: readonly T[],
  afterSlug: string | null,
): number {
  if (!afterSlug) return -1;

  const index = items.findIndex((item) => item.slug === afterSlug);
  return index;
}

/**
 * Paginates a sorted list of items.
 * @param items - Already-sorted array of items with slug
 * @param params - Pagination parameters (limit, after cursor)
 * @returns Paginated response with items and next cursor
 */
export function paginate<T extends { slug: string }>(
  items: readonly T[],
  params: PaginationParams,
): PaginationResponse<T> {
  const cursorIndex = findCursorIndex(items, params.after);
  const startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;

  const pageItems = items.slice(startIndex, startIndex + params.limit);
  const hasNext = startIndex + params.limit < items.length;

  const nextCursor = hasNext && pageItems.length > 0
    ? encodeCursor(pageItems[pageItems.length - 1]!.slug)
    : null;

  return Object.freeze({
    limit: params.limit,
    next: nextCursor,
    items: Object.freeze([...pageItems]),
  });
}
