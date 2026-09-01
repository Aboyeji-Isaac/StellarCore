import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { ScheduledRefreshResult } from "@/types/scheduled";

export type ScheduledRefreshHttpDependencies = Readonly<{
  cronSecret?: string | undefined;
  run?: () => Promise<ScheduledRefreshResult>;
}>;

export async function getScheduledRefreshResponse(
  request: Request,
  dependencies: ScheduledRefreshHttpDependencies = {},
): Promise<Response> {
  if (!hasValidCronAuthorization(
    request.headers.get("authorization"),
    dependencies.cronSecret,
  )) {
    return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  }

  try {
    const run = dependencies.run ?? runScheduledRefresh;
    return json(await run(), 200);
  } catch {
    return json({ error: { code: "internal_error", message: "Unable to run scheduled refresh." } }, 500);
  }
}

function json(body: object, status: 200 | 401 | 500): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
