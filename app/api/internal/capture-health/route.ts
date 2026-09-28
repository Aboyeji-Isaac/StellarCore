import { getCaptureCadenceHealthResponse } from "@/lib/scheduled/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Authenticated, sanitized cadence-health signal for operators.
 *
 * It reports whether StellarCore's capture process ran on schedule. It is not
 * anchor uptime, and it is not rate evidence: a `healthy` cadence says nothing
 * about whether an anchor answered, whether a quote was available, or whether a
 * transfer settled. Responses are bounded, no-store, and contain no
 * credentials, URLs, payloads, or raw errors.
 */
export async function GET(request: Request): Promise<Response> {
  return getCaptureCadenceHealthResponse(request);
}
