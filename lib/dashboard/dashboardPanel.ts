import {
  isRecoverablePublicApiErrorCode,
  type PublicApiErrorCode,
  type PublicApiErrorStatus,
} from "@/types/api/errors";

/**
 * A panel-level failure. `unknown_error` covers responses that did not carry a
 * recognised public error envelope; it is deliberately treated as terminal so a
 * retry control is never offered for an unclassifiable failure.
 */
export type DashboardPanelErrorCode = PublicApiErrorCode | "unknown_error";

export type DashboardPanelError = Readonly<{
  code: DashboardPanelErrorCode;
  message: string;
}>;

export type DashboardPanelResult<T> =
  | Readonly<{ status: 200; body: T }>
  | Readonly<{
      status: PublicApiErrorStatus;
      body: Readonly<{ error: DashboardPanelError }>;
    }>;

export type DashboardPanelState<T> = Readonly<{
  /** `loading` until the first result arrives, then `success` or `error`. */
  status: "loading" | "success" | "error";
  data: T | null;
  error: DashboardPanelError | null;
  /**
   * True only when the current failure is recoverable, which is the single
   * condition under which a retry control may be shown.
   */
  retryable: boolean;
  /** True while a request for this panel is in flight. */
  pending: boolean;
  /** Number of requests this panel has actually issued. */
  requestCount: number;
}>;

export function initialDashboardPanelState<T>(): DashboardPanelState<T> {
  return Object.freeze({
    status: "loading" as const,
    data: null,
    error: null,
    retryable: false,
    pending: false,
    requestCount: 0,
  });
}

export type DashboardPanelController<T> = Readonly<{
  getState: () => DashboardPanelState<T>;
  subscribe: (
    listener: (state: DashboardPanelState<T>) => void,
  ) => () => void;
  /** Issues a request for this panel, reusing any in-flight request. */
  load: () => Promise<DashboardPanelState<T>>;
  /**
   * Retries the panel. Returns the unchanged state without issuing a request
   * when the panel is not in a recoverable failure, so a retry control can
   * never start work the panel state does not justify.
   */
  retry: () => Promise<DashboardPanelState<T>>;
}>;

export type DashboardPanelOptions<T> = Readonly<{
  load: () => Promise<DashboardPanelResult<T>>;
}>;

const TRANSPORT_FAILURE_MESSAGE = "Unable to reach the data source.";

function transportFailure(): DashboardPanelResult<never> {
  return Object.freeze({
    status: 503,
    body: Object.freeze({
      error: Object.freeze({
        code: "upstream_unavailable" as const,
        message: TRANSPORT_FAILURE_MESSAGE,
      }),
    }),
  });
}

/**
 * Creates the state machine for a single dashboard panel.
 *
 * Each panel owns an independent controller, so retrying one panel never
 * touches the state of a sibling panel. Repeated clicks are folded into the
 * in-flight request instead of starting parallel work, and a response that
 * arrives after a newer request was started is discarded rather than allowed
 * to overwrite newer state.
 */
export function createDashboardPanel<T>(
  options: DashboardPanelOptions<T>,
): DashboardPanelController<T> {
  let state: DashboardPanelState<T> = initialDashboardPanelState<T>();
  let inFlight: Promise<DashboardPanelState<T>> | null = null;
  let attempts = 0;
  const listeners = new Set<(next: DashboardPanelState<T>) => void>();

  const publish = (next: DashboardPanelState<T>): void => {
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const run = (): Promise<DashboardPanelState<T>> => {
    if (inFlight) {
      return inFlight;
    }

    const attempt = ++attempts;
    const requestCount = state.requestCount + 1;
    const previous = state;

    publish(
      Object.freeze({
        ...previous,
        // Keep the previous failure visible while a retry is in flight so the
        // panel does not flash a skeleton between attempts.
        status: previous.status === "error" ? "error" : "loading",
        pending: true,
        requestCount,
      }),
    );

    const request = (async (): Promise<DashboardPanelState<T>> => {
      let result: DashboardPanelResult<T>;
      try {
        result = await options.load();
      } catch {
        result = transportFailure() as DashboardPanelResult<T>;
      }

      if (attempt !== attempts) {
        return state;
      }

      if (result.status === 200) {
        const next = Object.freeze({
          status: "success" as const,
          data: result.body,
          error: null,
          retryable: false,
          pending: false,
          requestCount,
        });
        publish(next);
        return next;
      }

      const error = result.body.error;
      const next = Object.freeze({
        status: "error" as const,
        data: null,
        error: Object.freeze({ code: error.code, message: error.message }),
        retryable: isRecoverablePublicApiErrorCode(error.code),
        pending: false,
        requestCount,
      });
      publish(next);
      return next;
    })();

    const tracked = request.finally(() => {
      if (inFlight === tracked) {
        inFlight = null;
      }
    });
    inFlight = tracked;
    return tracked;
  };

  return Object.freeze({
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: run,
    retry: () => {
      if (!state.retryable) {
        return Promise.resolve(state);
      }
      return run();
    },
  });
}
