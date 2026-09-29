import { Prisma } from "@/app/generated/prisma/client";
import {
  elapsedSeconds,
  instruments,
  recordHistogram,
  withSpan,
} from "@/lib/telemetry/core";
import { ATTR, errorTypeOf } from "@/lib/telemetry/semantics";

export type DatabaseOperation = Readonly<{
  client: string;
  model?: string;
  operation: string;
}>;

/**
 * Times one Prisma operation. Labels are the Prisma operation and model names
 * (a small fixed set), never SQL text, parameters, or connection details. The
 * duration includes waiting for a pool connection, so it rises under
 * queueing before any timeout occurs.
 */
export async function observeDatabaseOperation<T>(
  { client, model, operation }: DatabaseOperation,
  run: () => Promise<T>,
): Promise<T> {
  const attributes = {
    [ATTR.dbSystem]: "postgresql",
    [ATTR.dbOperation]: operation,
    [ATTR.dbClient]: client,
    ...(model ? { [ATTR.dbCollection]: model } : {}),
  };
  const startedAt = performance.now();
  let errorType: string | undefined;

  try {
    return await withSpan(model ? `${operation} ${model}` : operation, attributes, run);
  } catch (error) {
    errorType = errorTypeOf(error);
    throw error;
  } finally {
    recordHistogram(instruments().dbDuration, elapsedSeconds(startedAt), {
      ...attributes,
      ...(errorType ? { [ATTR.errorType]: errorType } : {}),
    });
  }
}

/** Prisma client extension that routes every operation through the observer. */
export function databaseTelemetryExtension(client: string) {
  return Prisma.defineExtension({
    name: "stellarcore-telemetry",
    query: {
      async $allOperations({ model, operation, args, query }) {
        return observeDatabaseOperation({ client, model, operation }, () => query(args));
      },
    },
  });
}
