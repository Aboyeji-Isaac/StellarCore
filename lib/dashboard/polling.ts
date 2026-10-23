/**
 * Visibility-aware refresh scheduling for the public dashboard.
 *
 * The dashboard is read-only evidence. Nothing on the page needs to keep
 * refreshing while the tab is in the background, so the poller holds a single
 * timer that only exists while the document is visible. When the document
 * becomes hidden the timer is cancelled and nothing is scheduled again until
 * the document is visible, at which point the documented refresh policy
 * applies:
 *
 * - A refresh runs at most once per `DASHBOARD_REFRESH_INTERVAL_MS`.
 * - Returning to a view before that interval elapses waits for the remainder
 *   instead of refreshing immediately.
 * - Returning after the interval has elapsed refreshes once, immediately, and
 *   then resumes the normal interval.
 *
 * Scheduling is injectable so tests can drive it with a controlled clock
 * instead of waiting on real time.
 */

export const DASHBOARD_REFRESH_INTERVAL_MS = 60_000;

export type PollingClock = Readonly<{
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}>;

export type PollingVisibility = Readonly<{
  isVisible: () => boolean;
  subscribe: (listener: () => void) => () => void;
}>;

export type DashboardPollerOptions = Readonly<{
  refresh: () => void | Promise<void>;
  intervalMs?: number;
  clock?: PollingClock;
  visibility?: PollingVisibility;
  onError?: (error: unknown) => void;
}>;

export type DashboardPoller = Readonly<{
  start: () => void;
  stop: () => void;
  isRunning: () => boolean;
}>;

export const BROWSER_POLLING_CLOCK: PollingClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
});

export const BROWSER_POLLING_VISIBILITY: PollingVisibility = Object.freeze({
  isVisible: () =>
    typeof document === "undefined" || document.visibilityState !== "hidden",
  subscribe(listener) {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

export function createDashboardPoller(
  options: DashboardPollerOptions,
): DashboardPoller {
  const intervalMs = options.intervalMs ?? DASHBOARD_REFRESH_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("the dashboard refresh interval must be a positive number");
  }

  const clock = options.clock ?? BROWSER_POLLING_CLOCK;
  const visibility = options.visibility ?? BROWSER_POLLING_VISIBILITY;

  let running = false;
  let timer: unknown;
  let unsubscribe: (() => void) | undefined;
  let refreshing = false;
  let lastRefreshAt = 0;

  const cancelTimer = () => {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (delayMs: number) => {
    cancelTimer();
    timer = clock.setTimeout(() => {
      timer = undefined;
      void refreshNow();
    }, Math.max(0, delayMs));
  };

  const scheduleNext = () => {
    if (!running || !visibility.isVisible()) {
      cancelTimer();
      return;
    }
    schedule(intervalMs - (clock.now() - lastRefreshAt));
  };

  const refreshNow = async (): Promise<void> => {
    cancelTimer();
    if (!running || !visibility.isVisible() || refreshing) return;

    refreshing = true;
    lastRefreshAt = clock.now();
    try {
      await options.refresh();
    } catch (error) {
      options.onError?.(error);
    } finally {
      refreshing = false;
      scheduleNext();
    }
  };

  const handleVisibilityChange = () => {
    if (!running) return;

    if (!visibility.isVisible()) {
      cancelTimer();
      return;
    }

    if (timer !== undefined) return;
    const remaining = intervalMs - (clock.now() - lastRefreshAt);
    if (remaining <= 0) {
      void refreshNow();
      return;
    }
    schedule(remaining);
  };

  return Object.freeze({
    start() {
      if (running) return;
      running = true;
      lastRefreshAt = clock.now();
      unsubscribe = visibility.subscribe(handleVisibilityChange);
      if (visibility.isVisible()) schedule(intervalMs);
    },

    stop() {
      if (!running) return;
      running = false;
      cancelTimer();
      unsubscribe?.();
      unsubscribe = undefined;
    },

    isRunning: () => running,
  });
}
