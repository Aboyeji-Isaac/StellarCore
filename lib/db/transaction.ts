import type { Prisma, PrismaClient } from "@/app/generated/prisma/client";
import type { DatabaseBudget } from "@/lib/db/budget";

/**
 * Runs one interactive transaction under the profile's client-side budget.
 *
 * The `timeout` and `maxWait` bounds are a client-side backstop. The
 * authoritative bounds remain server-side: `statement_timeout` cancels an
 * individual statement, `lock_timeout` cancels a lock wait, and
 * `idle_in_transaction_session_timeout` terminates a transaction left idle.
 * Because the server terminates the statement and aborts the transaction, no
 * mutation is merely abandoned client-side.
 */
export async function runBoundedInteractiveTransaction<T>(
  client: PrismaClient,
  budget: DatabaseBudget,
  work: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(work, {
    maxWait: budget.interactiveTransactionMaxWaitMs,
    timeout: budget.interactiveTransactionTimeoutMs,
  });
}
