export const RATE_FRESHNESS_THRESHOLD_MS = 120_000;
export const MIN_FRESH_SOURCES = 2;

// Capture execution budget (#144). The run deadline stays well below
// RATE_FRESHNESS_THRESHOLD_MS so a full run cannot outlive its own freshness window.
export const RATE_CAPTURE_CONCURRENCY = 4;
export const RATE_CAPTURE_PER_SOURCE_TIMEOUT_MS = 15_000;
export const RATE_CAPTURE_RUN_DEADLINE_MS = 60_000;
