import {
  isFailoverOrConnectionError,
  isTransactionResolutionUnknown,
} from "@/lib/db/failoverErrors";

export class TransactionInterruptedError extends Error {
  readonly code = "TRANSACTION_INTERRUPTED";
  readonly phase: "IN_FLIGHT" | "COMMITTING";
  readonly originalError?: unknown;

  constructor(
    message: string,
    phase: "IN_FLIGHT" | "COMMITTING",
    originalError?: unknown,
  ) {
    super(message);
    this.name = "TransactionInterruptedError";
    this.phase = phase;
    this.originalError = originalError;
  }
}

export class TransactionCommitUnconfirmedError extends TransactionInterruptedError {
  constructor(message = "Transaction commit confirmation not received", originalError?: unknown) {
    super(message, "COMMITTING", originalError);
    this.name = "TransactionCommitUnconfirmedError";
  }
}

export type TransactionPhase =
  | "INITIALIZED"
  | "IN_FLIGHT"
  | "COMMITTING"
  | "COMMITTED"
  | "FAILED";

export interface TransactionExecutionTracker {
  readonly currentPhase: TransactionPhase;
  readonly failedAtPhase: TransactionPhase | null;
  markInFlight(): void;
  markCommitting(): void;
  markCommitted(): void;
  markFailed(error: unknown): void;
}

/**
 * Creates an execution tracker to monitor the lifecycle of a transaction
 * and detect whether an interruption happened during query execution or during commit confirmation.
 */
export function createTransactionTracker(): TransactionExecutionTracker {
  let phase: TransactionPhase = "INITIALIZED";
  let failedAt: TransactionPhase | null = null;

  return {
    get currentPhase() {
      return phase;
    },
    get failedAtPhase() {
      return failedAt;
    },
    markInFlight() {
      phase = "IN_FLIGHT";
    },
    markCommitting() {
      phase = "COMMITTING";
    },
    markCommitted() {
      phase = "COMMITTED";
    },
    markFailed() {
      failedAt = phase;
      phase = "FAILED";
    },
  };
}

/**
 * Wraps transaction execution to enforce that interrupted transactions never
 * report success and are classified with explicit typed interruption errors.
 */
export async function executeSafeTransaction<TResult, TClient>(
  transactionRunner: (
    fn: (tx: TClient) => Promise<TResult>,
  ) => Promise<TResult>,
  action: (tx: TClient) => Promise<TResult>,
): Promise<TResult> {
  const tracker = createTransactionTracker();
  let executedResult: { ok: true; value: TResult } | null = null;

  try {
    const result = await transactionRunner(async (tx) => {
      tracker.markInFlight();
      const value = await action(tx);
      tracker.markCommitting();
      return value;
    });

    tracker.markCommitted();
    executedResult = { ok: true, value: result };
    return result;
  } catch (error) {
    const interruptionPhase = tracker.currentPhase;
    tracker.markFailed(error);

    if (interruptionPhase === "COMMITTING" || isTransactionResolutionUnknown(error)) {
      throw new TransactionCommitUnconfirmedError(
        "Transaction commit confirmation was not received due to connection/failover event; transaction outcome unknown",
        error,
      );
    }

    if (isFailoverOrConnectionError(error)) {
      throw new TransactionInterruptedError(
        "Transaction was interrupted by connection failure before commit confirmation",
        "IN_FLIGHT",
        error,
      );
    }

    throw error;
  } finally {
    // Assert invariant: if phase is not COMMITTED, executedResult must never be returned
    if (tracker.currentPhase !== "COMMITTED" && executedResult !== null) {
      throw new TransactionCommitUnconfirmedError(
        "Invariant violation: transaction completed action but commit confirmation was not finalized",
      );
    }
  }
}
