/**
 * Response-size enforcement utilities.
 *
 * Estimates JSON serialization size and enforces byte budgets to prevent
 * unbounded memory growth. Provides safe 413 responses when budgets are exceeded.
 */

export type ResponseSizeBudget = Readonly<{
  maxBytes: number;
  maxItems: number;
}>;

/**
 * Estimates the JSON serialized size of an item.
 * Used to preflight-check whether a collection will exceed its byte budget.
 *
 * Estimation formula:
 *   - Base overhead per item: ~50 bytes (JSON structure, formatting)
 *   - Slug: ~25 bytes average
 *   - Name: ~20 bytes average
 *   - Additional field overhead: varies by endpoint
 *
 * Multiplier: 1.15 (15% safety margin for unknown fields)
 */
export function estimateItemBytes(item: unknown): number {
  const json = JSON.stringify(item);
  return json.length;
}

/**
 * Estimates total response size including overhead.
 * @param itemCount - Number of items in the response
 * @param avgItemBytes - Average item size (estimated or measured)
 * @returns Estimated response bytes including JSON wrapper overhead
 */
export function estimateResponseBytes(itemCount: number, avgItemBytes: number): number {
  const itemsBytes = itemCount * avgItemBytes;
  const wrapperOverhead = 200; // { "items": [], "count": X, "limit": Y, "next": null }
  return itemsBytes + wrapperOverhead;
}

/**
 * Checks if a response would exceed the byte budget.
 * @param estimatedBytes - Estimated serialized size
 * @param budget - Maximum allowed bytes
 * @returns true if within budget, false if exceeded
 */
export function withinBudget(estimatedBytes: number, budget: ResponseSizeBudget): boolean {
  return estimatedBytes <= budget.maxBytes;
}

/**
 * Measures the actual JSON serialized size of an object.
 * @param obj - Object to measure
 * @returns Byte count of JSON.stringify(obj)
 */
export function measureResponseBytes(obj: unknown): number {
  try {
    const json = JSON.stringify(obj);
    return Buffer.byteLength(json, "utf-8");
  } catch {
    return 0;
  }
}

/**
 * Creates a safe 413 Payload Too Large error response.
 */
export function responseTooLargeError(): Readonly<{
  status: 413;
  body: Readonly<{
    error: Readonly<{
      code: "response_too_large";
      message: string;
    }>;
  }>;
}> {
  return Object.freeze({
    status: 413,
    body: Object.freeze({
      error: Object.freeze({
        code: "response_too_large",
        message: "The response exceeds the maximum allowed size.",
      }),
    }),
  });
}

// Predefined budgets for each endpoint
export const RESPONSE_BUDGETS = Object.freeze({
  anchors: Object.freeze({ maxBytes: 1_000_000, maxItems: 500 }),
  anchorDetail: Object.freeze({ maxBytes: 100_000, maxItems: 1 }),
  corridors: Object.freeze({ maxBytes: 500_000, maxItems: 10_000 }),
  corridorDetail: Object.freeze({ maxBytes: 100_000, maxItems: 1 }),
  reputation: Object.freeze({ maxBytes: 500_000, maxItems: 500 }),
  reputationDetail: Object.freeze({ maxBytes: 10_000, maxItems: 1 }),
  rates: Object.freeze({ maxBytes: 200_000, maxItems: 500 }),
});
