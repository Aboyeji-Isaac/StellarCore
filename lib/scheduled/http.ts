import { PRISMA_CRON_NONCE_STORE } from "@/lib/scheduled/cronNonceStore";
import { hasValidCronAuthorization } from "@/lib/scheduled/cronAuth";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import {
  hasSignedCronHeaders,
  verifySignedCronRequest,
  type CronNonceStore,
} from "@/lib/scheduled/signedCronAuth";
import type { ScheduledRefreshResult } from "@/types/scheduled";

/**
 * How the refresh route authenticates its caller.
 * - bearer: the static CRON_SECRET bearer credential only (the default; what
 *   Vercel Cron sends).
 * - either: a signed request when signature headers are present, otherwise the
 *   bearer credential. A request that carries signature headers is judged only
 *   as a signed request, so a bad signature is never rescued by a bearer.
 * - signed: signed requests only.
 */
export type CronAuthMode = "bearer" | "either" | "signed";

export type ScheduledRefreshHttpDependencies = Readonly<{
  cronSecret?: string | undefined;
  authMode?: CronAuthMode;
  nonceStore?: CronNonceStore;
  now?: () => Date;
  run?: () => Promise<ScheduledRefreshResult>;
}>;

export function parseCronAuthMode(value: string | undefined): CronAuthMode {
  if (value === undefined || value === "") return "bearer";
  if (value === "bearer" || value === "either" || value === "signed") return value;
  throw new Error("Invalid CRON_AUTH_MODE");
}

export async function getScheduledRefreshResponse(
  request: Request,
  dependencies: ScheduledRefreshHttpDependencies = {},
): Promise<Response> {
  try {
    if (!(await isAuthorized(request, dependencies))) {
      return json({ error: { code: "unauthorized", message: "Unauthorized." } }, 401);
    }

    const run = dependencies.run ?? runScheduledRefresh;
    return json(await run(), 200);
  } catch {
    // Misconfiguration or an unavailable nonce store fails closed.
    return json({ error: { code: "internal_error", message: "Unable to run scheduled refresh." } }, 500);
  }
}

async function isAuthorized(
  request: Request,
  dependencies: ScheduledRefreshHttpDependencies,
): Promise<boolean> {
  const mode = dependencies.authMode ?? parseCronAuthMode(process.env.CRON_AUTH_MODE);
  const secret = dependencies.cronSecret ?? process.env.CRON_SECRET;
  const bearer = () => hasValidCronAuthorization(request.headers.get("authorization"), secret);

  if (mode === "bearer") return bearer();
  if (mode === "either" && !hasSignedCronHeaders(request.headers)) return bearer();

  const verification = await verifySignedCronRequest(request, {
    secret,
    nonceStore: dependencies.nonceStore ?? PRISMA_CRON_NONCE_STORE,
    now: dependencies.now?.() ?? new Date(),
  });
  return verification.ok;
}

function json(body: object, status: 200 | 401 | 500): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
