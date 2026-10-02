export type RequestCancellationReason = "client_aborted" | "deadline_exceeded";

export type RequestContext = Readonly<{
  /**
   * Aborts when the caller disconnects or when the end-to-end deadline passes,
   * so holders further down the stack observe the same cancellation state.
   */
  signal: AbortSignal;
  cancellationReason: () => RequestCancellationReason | null;
  assertActive: () => void;
  run: <T>(work: () => Promise<T>) => Promise<T>;
  dispose: () => void;
}>;

export type RequestDeadlineExceededResponse = Readonly<{
  error: Readonly<{
    code: "request_deadline_exceeded";
    message: string;
  }>;
}>;
