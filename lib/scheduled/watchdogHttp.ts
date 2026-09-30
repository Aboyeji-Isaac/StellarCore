import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { readRefreshWatchdogStatus } from "@/lib/scheduled/watchdogRun";
import type { RefreshWatchdogStatus } from "@/types/refreshWatchdog";

export type RefreshWatchdogHttpDependencies = Readonly<{
  cronSecret?: string | undefined;
  read?: () => Promise<RefreshWatchdogStatus>;
}>;

/**
 * Internal operator status for scheduled evidence freshness. It requires the
 * same bearer credential as the refresh route, is read-only, and reports run
 * health only: it never creates, alters, or vouches for rate or reputation
 * evidence.
 */
export async function getRefreshWatchdogResponse(
  request: Request,
  dependencies: RefreshWatchdogHttpDependencies = {},
): Promise<Response> {
  if (!hasValidCronAuthorization(
    request.headers.get("authorization"),
    dependencies.cronSecret,
  )) {
    return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  }

  try {
    const read = dependencies.read ?? (() => readRefreshWatchdogStatus());
    return json(await read(), 200);
  } catch {
    return json({ error: { code: "internal_error", message: "Unable to read refresh status." } }, 500);
  }
}

function json(body: object, status: 200 | 401 | 500): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
