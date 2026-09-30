import type { PrismaClient } from "@/app/generated/prisma/client";

const READINESS_TIMEOUT_MS = 2_000;

type DatabaseCheck = () => Promise<void>;

async function checkDatabaseConnection(): Promise<void> {
  const { db } = await import("@/lib/dbClient");
  await (db as PrismaClient).$queryRaw`SELECT 1`;
}

export function getLivenessResponse(): Response {
  return Response.json(
    { status: "alive" },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function getReadinessResponse(
  checkDatabase: DatabaseCheck = checkDatabaseConnection,
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const ready = await Promise.race([
      Promise.resolve().then(checkDatabase).then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);

    return Response.json(
      { status: ready ? "ready" : "not_ready" },
      {
        status: ready ? 200 : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { status: "not_ready" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}