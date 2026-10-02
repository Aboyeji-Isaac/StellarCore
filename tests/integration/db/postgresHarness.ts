import { randomUUID } from "node:crypto";

import { Client } from "pg";

import {
  databaseBudgetDefaults,
  type DatabaseBudget,
  type DatabaseBudgetKnob,
  type DatabaseBudgetProfileName,
} from "@/lib/db/budget";

/**
 * Opt-in isolated PostgreSQL integration harness.
 *
 * The database budget tests never run against production credentials or
 * production load. They are enabled only by `RUN_DATABASE_BUDGET_INTEGRATION=1`
 * and read `TEST_DATABASE_URL` (falling back to `DATABASE_URL`) pointing at an
 * isolated database. `npm test` skips them by default.
 */
export function databaseBudgetIntegrationEnabled(): boolean {
  return process.env.RUN_DATABASE_BUDGET_INTEGRATION === "1";
}

export function integrationConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "RUN_DATABASE_BUDGET_INTEGRATION=1 requires TEST_DATABASE_URL (or DATABASE_URL)",
    );
  }
  return url;
}

export function testBudget(
  profile: DatabaseBudgetProfileName,
  overrides: Partial<Record<DatabaseBudgetKnob, number>> = {},
): DatabaseBudget {
  return Object.freeze({
    profile,
    applicationName: `stellarcore:test:${profile}`,
    ...databaseBudgetDefaults(profile),
    ...overrides,
  });
}

export async function withRawClient<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function uniqueTableName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export async function createProbeTable(connectionString: string): Promise<string> {
  const table = uniqueTableName("db_budget_probe");
  await withRawClient(connectionString, async (client) => {
    await client.query(
      `CREATE TABLE ${table} (id integer PRIMARY KEY, value integer NOT NULL)`,
    );
    await client.query(`INSERT INTO ${table} (id, value) VALUES (1, 0)`);
  });
  return table;
}

export async function dropProbeTable(connectionString: string, table: string): Promise<void> {
  await withRawClient(connectionString, async (client) => {
    await client.query(`DROP TABLE IF EXISTS ${table}`);
  });
}

export function arrayRows<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}
