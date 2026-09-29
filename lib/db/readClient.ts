import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import { createRuntimePrismaClient } from "@/lib/db/connection";

/**
 * Public read boundary. Public API routes, dashboard sections, and read
 * models import only this module. It connects with DATABASE_READ_URL, whose
 * PostgreSQL role holds SELECT only; the type below additionally removes
 * Prisma mutation methods so accidental writes fail at compile time before
 * PostgreSQL rejects them at run time.
 */
type MutationMethod =
  | "create"
  | "createMany"
  | "createManyAndReturn"
  | "update"
  | "updateMany"
  | "updateManyAndReturn"
  | "upsert"
  | "delete"
  | "deleteMany";

type ModelDelegateName = Uncapitalize<Prisma.ModelName>;

export type ReadOnlyDatabase = Readonly<{
  [Model in ModelDelegateName]: Omit<PrismaClient[Model], MutationMethod>;
}> & Pick<PrismaClient, "$queryRaw" | "$disconnect">;

const globalForReadDb = globalThis as unknown as {
  stellarCoreReadDb: PrismaClient | undefined;
};

const client = globalForReadDb.stellarCoreReadDb ?? createRuntimePrismaClient("read");

if (process.env.NODE_ENV !== "production") {
  globalForReadDb.stellarCoreReadDb = client;
}

export const readDb: ReadOnlyDatabase = client;
