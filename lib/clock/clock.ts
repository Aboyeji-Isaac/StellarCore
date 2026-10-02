import type { ServerClock } from "@/types/clock";

/**
 * The production server clock. Every evidence capture/evaluation default goes
 * through this object so the boundary can be swapped in tests without changing
 * production call sites.
 */
export const SYSTEM_CLOCK: ServerClock = Object.freeze({
  now: () => new Date(),
});

export type ControlledClock = ServerClock & Readonly<{
  set: (instant: Date) => void;
  advance: (milliseconds: number) => void;
}>;

/**
 * Deterministic clock for tests. It never reads the system clock after
 * construction, so runs that cross "backward" and "forward" movements are
 * reproducible.
 */
export function createControlledClock(initial: Date = new Date(0)): ControlledClock {
  let current = new Date(initial.getTime());
  return Object.freeze({
    now: () => new Date(current.getTime()),
    set: (instant: Date) => {
      current = new Date(instant.getTime());
    },
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  });
}

export function isValidClockInstant(instant: Date | null | undefined): instant is Date {
  return instant instanceof Date && Number.isFinite(instant.getTime());
}
