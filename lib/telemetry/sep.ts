import {
  elapsedSeconds,
  instruments,
  recordHistogram,
  withSpan,
} from "@/lib/telemetry/core";
import { ATTR, errorTypeOf, type SepOperation } from "@/lib/telemetry/semantics";

const SEP38_OPERATIONS: ReadonlySet<string> = new Set(["info", "prices", "price", "quote"]);

/**
 * Classifies a SEP-38 endpoint into a fixed operation name without keeping
 * the host, path prefix, query string, or quote id.
 */
export function classifySep38Operation(url: string): SepOperation {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index]!;
      if (SEP38_OPERATIONS.has(segment)) return segment as SepOperation;
    }
  } catch {
    // Fall through to the bounded default.
  }
  return "other";
}

/**
 * Observes one outbound SEP request. The typed SEP failure is rethrown
 * unchanged; telemetry records only its code and the HTTP status class.
 */
export async function observeSepRequest<T>(
  sep: "1" | "38",
  operation: SepOperation,
  run: () => Promise<T>,
): Promise<T> {
  const attributes = { [ATTR.sep]: sep, [ATTR.sepOperation]: operation };
  const startedAt = performance.now();
  let result = "OK";

  try {
    return await withSpan(`SEP-${sep} ${operation}`, attributes, async (span) => {
      try {
        return await run();
      } catch (error) {
        const status = (error as { status?: unknown }).status;
        if (typeof status === "number") span.setAttribute(ATTR.httpStatusCode, status);
        throw error;
      }
    });
  } catch (error) {
    result = errorTypeOf(error);
    throw error;
  } finally {
    recordHistogram(instruments().sepDuration, elapsedSeconds(startedAt), {
      ...attributes,
      [ATTR.result]: result,
    });
  }
}
