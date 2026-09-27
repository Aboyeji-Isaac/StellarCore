export const CRON_FAILURE_WEBHOOK_URL_ENV = "CRON_FAILURE_WEBHOOK_URL";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 5_000;

export type CronFailureAlert = Readonly<{
  step: string;
  error: string;
  timestamp: string;
}>;

export type CronFailureAlertOptions = Readonly<{
  webhookUrl?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
}>;

export function buildCronFailureAlertContent(alert: CronFailureAlert): Readonly<{
  content: string;
}> {
  return Object.freeze({
    content: [
      "StellarCore scheduled job failed:",
      ...(alert.step ? [alert.step] : []),
      `Error: ${alert.error}`,
      `Timestamp: ${alert.timestamp}`,
    ].join("\n"),
  });
}

/**
 * Sends exactly one best-effort failure notification to the configured
 * webhook. It never throws: alerting must not hide the original scheduled job
 * failure. When no webhook URL is configured, it logs a single notice and
 * returns. Notification failures are logged but never recurse into another
 * alert.
 */
export async function sendCronFailureAlert(
  alert: CronFailureAlert,
  options: CronFailureAlertOptions = {},
): Promise<void> {
  const webhookUrl = options.webhookUrl ?? process.env.CRON_FAILURE_WEBHOOK_URL;
  const log = options.log ?? ((message: string) => console.log(message));

  if (!webhookUrl) {
    log(`CRON_FAILURE_WEBHOOK_URL is not configured; skipping failure alert for ${alert.step}`);
    return;
  }

  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildCronFailureAlertContent(alert)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`webhook returned HTTP ${response.status}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    log(`failed to deliver ${alert.step} failure alert: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }
}