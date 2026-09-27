const DEFAULT_TIMEOUT_MS = 5_000;

export type ReachabilityProbeOptions = Readonly<{
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}>;

export type ReachabilityProbeResult = Readonly<{
  slug: string;
  tomlUrl: string;
  reachable: boolean;
  status: "reachable" | "unreachable";
  httpStatus?: number;
  responseTimeMs: number;
  checkedAt: string;
  error?: string;
}>;

export type ReachabilityAnchor = Readonly<{
  slug: string;
  tomlUrl: string;
}>;

/**
 * Performs one fresh HTTP GET of a persisted anchor's TOML URL and reports live
 * reachability only. This deliberately does not parse, validate, or persist
 * anything and never touches Anchor.status or any persisted sync field.
 */
export async function probeTomlReachability(
  anchor: ReachabilityAnchor,
  options: ReachabilityProbeOptions = {},
): Promise<ReachabilityProbeResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const startedMs = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const base = Object.freeze({
    slug: anchor.slug,
    tomlUrl: anchor.tomlUrl,
    checkedAt,
  });

  try {
    const response = await fetcher(anchor.tomlUrl, {
      method: "GET",
      headers: { Accept: "text/plain, application/toml;q=0.9, */*;q=0.1" },
      redirect: "follow",
      signal: controller.signal,
    });
    const responseTimeMs = Date.now() - startedMs;
    const ok = response.ok;

    return Object.freeze({
      ...base,
      reachable: ok,
      status: ok ? "reachable" : "unreachable",
      ...(ok ? {} : { httpStatus: response.status }),
      responseTimeMs,
      ...(ok ? {} : { error: `HTTP ${response.status}` }),
    });
  } catch (error) {
    const responseTimeMs = Date.now() - startedMs;

    if (controller.signal.aborted) {
      return Object.freeze({
        ...base,
        reachable: false,
        status: "unreachable",
        responseTimeMs,
        error: `Timed out after ${timeoutMs}ms`,
      });
    }

    return Object.freeze({
      ...base,
      reachable: false,
      status: "unreachable",
      responseTimeMs,
      error: error instanceof Error ? error.message : "Network request failed",
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probes every provided anchor; one failure never prevents the remaining
 * anchors from being checked.
 */
export async function probeAnchorsReachability(
  anchors: readonly ReachabilityAnchor[],
  options: ReachabilityProbeOptions = {},
): Promise<readonly ReachabilityProbeResult[]> {
  const results: ReachabilityProbeResult[] = [];

  for (const anchor of anchors) {
    results.push(await probeTomlReachability(anchor, options));
  }

  return Object.freeze(results);
}

export async function loadPersistedAnchorsForProbe(): Promise<readonly ReachabilityAnchor[]> {
  const { db } = await import("@/lib/dbClient");
  const anchors = await db.anchor.findMany({
    orderBy: { slug: "asc" },
    select: { slug: true, tomlUrl: true },
  });

  return Object.freeze(anchors.map((anchor) => Object.freeze({
    slug: anchor.slug,
    tomlUrl: anchor.tomlUrl,
  })));
}