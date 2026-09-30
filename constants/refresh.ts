/**
 * Durable stale-refresh watchdog (issue #189).
 *
 * The production cron in vercel.json runs the refresh once daily at midnight
 * UTC (`0 0 * * *`). Scheduled slots are therefore every REFRESH_CADENCE_MS
 * starting at REFRESH_SLOT_OFFSET_MS past the Unix epoch.
 */
export const REFRESH_PIPELINE = "scheduled-refresh";
export const REFRESH_CRON_SCHEDULE = "0 0 * * *";
export const REFRESH_CADENCE_MS = 86_400_000;
export const REFRESH_SLOT_OFFSET_MS = 0;
/**
 * Two hours after a scheduled slot. The Vercel Hobby plan may invoke a daily
 * cron at any time within its scheduled hour and does not retry a failed
 * invocation, and a locally verified run takes about ten seconds; the second
 * hour is margin for a slow run. A refresh that has not succeeded by then is
 * reported stale.
 */
export const REFRESH_GRACE_MS = 7_200_000;
