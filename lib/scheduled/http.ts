import {
  assertEnvironmentIdentityOnce,
} from "@/lib/config/environmentGuard";
import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { ScheduledRefreshResult } from "@/types/scheduled";

export type ScheduledRefreshHttpDependencies = Readonly<{
  cronSecret?: string | undefined;
  run?: () => Promise<ScheduledRefreshResult>;
  assertEnvironment?: () => Promise<{ ok: boolean; code?: string; message?: string }>;
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

  // Issue #143: scheduled mutation is an explicit environment boundary. A
  // preview/test/CI runtime must never execute the refresh against a database
  // that is not marked for that same environment; fail closed with a bounded,
  // secret-free error before any evidence mutation.
  const assertEnvironment = dependencies.assertEnvironment ?? assertEnvironmentIdentityOnce;
  const guard = await assertEnvironment();
  if (!guard.ok) {
    return json({
      error: {
        code: "environment_identity_failure",
        message: guard.message ?? "Refusing to run scheduled refresh: environment identity check failed.",
      },
    }, 500);
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
