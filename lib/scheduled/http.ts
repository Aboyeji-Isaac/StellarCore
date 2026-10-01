import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import {
  sendCronFailureAlert,
  type CronFailureAlert,
} from "@/lib/scheduled/alert";
import type { ScheduledRefreshResult } from "@/types/scheduled";

export type ScheduledRefreshHttpDependencies = Readonly<{
  cronSecret?: string | undefined;
  cronPreviousSecret?: string | undefined;
  cronRotationUntil?: string | undefined;
  cronNow?: () => number;
  run?: () => Promise<ScheduledRefreshResult>;
  alert?: (alert: CronFailureAlert) => Promise<void>;
  now?: () => Date;
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

  const alert = dependencies.alert ?? sendCronFailureAlert;
  const now = dependencies.now ?? (() => new Date());
  const alertAbout = (failure: CronFailureAlert): void => {
    alert(failure).catch(() => {
      // A notification failure must never hide the original scheduled-job outcome.
    });
  };

  try {
    const run = dependencies.run ?? runScheduledRefresh;
    const result = await run();

    if (result.ok === false) {
      alertAbout(failureAlert("scheduled refresh", summarizePartialFailures(result), now()));
    }

    return json(result, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    alertAbout(failureAlert("scheduled refresh", message, now()));
    return json({ error: { code: "internal_error", message: "Unable to run scheduled refresh." } }, 500);
  }
}

function failureAlert(
  step: string,
  error: string,
  timestamp: Date,
): CronFailureAlert {
  return Object.freeze({
    step,
    error,
    timestamp: timestamp.toISOString(),
  });
}

function summarizePartialFailures(result: ScheduledRefreshResult): string {
  const rateFailures = result.rates.failed;
  const reputationFailures = result.reputation.failed;
  return `rate snapshot failed for ${rateFailures} source(s); reputation failed for ${reputationFailures} anchor(s)`;
}

function json(body: object, status: 200 | 401 | 500): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
