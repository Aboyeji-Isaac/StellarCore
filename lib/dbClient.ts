/**
 * Shared application database entry point.
 *
 * `db` is the bounded read-role runtime client used by public read models. Write
 * paths use the lazily created write-role client via `getWriteDatabaseClient()`.
 * Both are process-scoped and must not be disconnected per request.
 */

import { getReadDatabaseClient } from "@/lib/db/runtime";

export const db = getReadDatabaseClient();

export {
  getWriteDatabaseClient,
  getDatabaseBudget,
  getDatabaseBudgetConfiguration,
  disconnectRuntimeDatabaseClients,
} from "@/lib/db/runtime";
