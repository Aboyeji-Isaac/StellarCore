import type { PrismaClient } from "@/app/generated/prisma/client";
import { withDatabaseDeadline } from "@/lib/db/deadlines";

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
  try {
    await withDatabaseDeadline(
      async () => {
        await checkDatabase();
      },
      { timeoutMs },
    );

    return Response.json(
      { status: "ready" },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return Response.json(
      { status: "not_ready" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
