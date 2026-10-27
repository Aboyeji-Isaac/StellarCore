import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { evaluateCronTimestamp } from "@/lib/scheduled/cronTimestamp";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { ScheduledRefreshResult } from "@/types/scheduled";

export type ScheduledRefreshHttpDependencies = Readonly<{
  cronSecret?: string | undefined;
  cronPreviousSecret?: string | undefined;
  cronRotationUntil?: string | undefined;
  cronNow?: () => number;
  cronTimestampNow?: () => Date;
  cronTimestampSkewMs?: number;
  run?: () => Promise<ScheduledRefreshResult>;
}>;

export async function getScheduledRefreshResponse(
  request: Request,
  dependencies: ScheduledRefreshHttpDependencies = {},
): Promise<Response> {
  if (!hasValidCronAuthorization(
    request.headers.get("authorization"),
    dependencies.cronSecret,
    dependencies.cronPreviousSecret,
    dependencies.cronRotationUntil,
    dependencies.cronNow,
  )) {
    return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
  }

  const timestampHeader = request.headers.get("x-cron-timestamp");
  if (timestampHeader !== null || dependencies.cronTimestampNow !== undefined) {
    const decision = evaluateCronTimestamp({
      timestamp: timestampHeader ?? undefined,
      now: dependencies.cronTimestampNow ?? (() => new Date()),
      allowedSkewMs: dependencies.cronTimestampSkewMs,
    });
    if (!decision.ok) {
      return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    }
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
