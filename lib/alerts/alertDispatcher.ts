import { computeWebhookSignature } from "@/lib/alerts/signature";
import { validateWebhookDestinationUrl } from "@/lib/alerts/ssrf";
import type {
  AlertSubscriptionRepository,
} from "@/lib/alerts/alertSubscriptionRepository";
import { PRISMA_ALERT_SUBSCRIPTION_REPOSITORY } from "@/lib/alerts/alertSubscriptionRepository";
import type {
  RateAlertEvaluationResult,
  RateAlertEventPayload,
  RateAlertSubscriptionRecord,
} from "@/types/alerts";

const DEFAULT_DISPATCH_TIMEOUT_MS = 5000;

export type DispatchAlertDependencies = Readonly<{
  repository?: AlertSubscriptionRepository;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}>;

export type DispatchResult = Readonly<{
  totalSubscriptions: number;
  attempted: number;
  delivered: number;
  failed: number;
  skipped: number;
}>;

export async function dispatchRateAlertsForCorridor(
  corridor: Readonly<{
    id: string;
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>,
  evaluation: Extract<RateAlertEvaluationResult, { shouldAlert: true }>,
  dependencies: DispatchAlertDependencies = {},
): Promise<DispatchResult> {
  const repository =
    dependencies.repository ?? PRISMA_ALERT_SUBSCRIPTION_REPOSITORY;
  const fetchFn = dependencies.fetchFn ?? fetch;
  const now = dependencies.now ?? (() => new Date());
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;

  const subscriptions = await repository.findSubscriptionsByCorridor(
    corridor.id,
    true,
  );

  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let attempted = 0;

  for (const subscription of subscriptions) {
    if (
      evaluation.changeType === "RATE_MOVEMENT" &&
      evaluation.percentageChange !== null &&
      evaluation.percentageChange < subscription.thresholdPercent
    ) {
      skipped += 1;
      continue;
    }

    if (subscription.deliveryMethod === "WEBHOOK") {
      attempted += 1;
      const success = await sendWebhookAlert(
        subscription,
        corridor,
        evaluation,
        { fetchFn, now, timeoutMs, repository },
      );
      if (success) {
        delivered += 1;
      } else {
        failed += 1;
      }
    } else {
      // Email or unsupported delivery method skipped safely
      skipped += 1;
    }
  }

  return Object.freeze({
    totalSubscriptions: subscriptions.length,
    attempted,
    delivered,
    failed,
    skipped,
  });
}

async function sendWebhookAlert(
  subscription: RateAlertSubscriptionRecord,
  corridor: Readonly<{
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>,
  evaluation: Extract<RateAlertEvaluationResult, { shouldAlert: true }>,
  deps: {
    fetchFn: typeof fetch;
    now: () => Date;
    timeoutMs: number;
    repository: AlertSubscriptionRepository;
  },
): Promise<boolean> {
  const urlCheck = validateWebhookDestinationUrl(subscription.destination);
  if (!urlCheck.ok) {
    return false;
  }

  const timestamp = deps.now().getTime();
  const payload: RateAlertEventPayload = Object.freeze({
    event: "corridor.rate_change",
    subscriptionId: subscription.id,
    corridor: Object.freeze({
      slug: corridor.slug,
      sourceAsset: corridor.sourceAsset,
      sourceCountry: corridor.sourceCountry,
      destinationAsset: corridor.destinationAsset,
      destinationCountry: corridor.destinationCountry,
    }),
    changeType: evaluation.changeType,
    previousRate: evaluation.previousRate,
    currentRate: evaluation.currentRate,
    previousState: evaluation.previousState,
    currentState: evaluation.currentState,
    percentageChange: evaluation.percentageChange,
    thresholdPercent: subscription.thresholdPercent,
    evaluatedAt: evaluation.evaluatedAt,
  });

  const payloadString = JSON.stringify(payload);
  const signature = computeWebhookSignature(
    payloadString,
    subscription.secret,
    timestamp,
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);

  try {
    const response = await deps.fetchFn(urlCheck.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-StellarCore-Signature": `sha256=${signature}`,
        "X-StellarCore-Timestamp": timestamp.toString(),
        "X-StellarCore-Event": "corridor.rate_change",
      },
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.ok) {
      await deps.repository.updateLastNotified(subscription.id, deps.now());
      return true;
    }
    return false;
  } catch {
    clearTimeout(timer);
    return false;
  }
}
