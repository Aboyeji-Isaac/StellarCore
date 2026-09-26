import { generateSubscriptionSecret } from "@/lib/alerts/signature";
import { validateWebhookDestinationUrl } from "@/lib/alerts/ssrf";
import type {
  AlertSubscriptionRepository,
} from "@/lib/alerts/alertSubscriptionRepository";
import { PRISMA_ALERT_SUBSCRIPTION_REPOSITORY } from "@/lib/alerts/alertSubscriptionRepository";
import type { AlertDeliveryMethodType, RateAlertSubscriptionRecord } from "@/types/alerts";
import type {
  AlertSubscriptionApiErrorCode,
  AlertSubscriptionApiResult,
  CreateAlertSubscriptionRequestBody,
  PublicAlertSubscriptionResponse,
} from "@/types/api/alerts";

const MAX_CORRIDOR_SLUG_LENGTH = 100;
const CORRIDOR_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MIN_THRESHOLD_PERCENT = 0.01;
const MAX_THRESHOLD_PERCENT = 100.0;
const DEFAULT_THRESHOLD_PERCENT = 1.0;

export type AlertSubscriptionsApiDependencies = Readonly<{
  repository?: AlertSubscriptionRepository;
}>;

export async function createAlertSubscription(
  body: CreateAlertSubscriptionRequestBody | null,
  dependencies: AlertSubscriptionsApiDependencies = {},
): Promise<AlertSubscriptionApiResult> {
  if (!body || typeof body !== "object") {
    return errorResult(400, "missing_corridor", "Request body is required.");
  }

  const corridorValidation = validateCorridorParameter(body.corridor);
  if (!corridorValidation.ok) return corridorValidation.result;

  const destinationValidation = validateDestination(body.destination);
  if (!destinationValidation.ok) return destinationValidation.result;

  const thresholdValidation = validateThreshold(body.thresholdPercent);
  if (!thresholdValidation.ok) return thresholdValidation.result;

  const deliveryMethod: AlertDeliveryMethodType =
    body.deliveryMethod === "EMAIL" ? "EMAIL" : "WEBHOOK";

  const repository =
    dependencies.repository ?? PRISMA_ALERT_SUBSCRIPTION_REPOSITORY;

  let corridor;
  try {
    corridor = await repository.findCorridorBySlug(
      corridorValidation.corridorSlug,
    );
  } catch {
    return errorResult(500, "internal_error", "Unable to access database.");
  }

  if (!corridor) {
    return errorResult(404, "corridor_not_found", "Corridor not found.");
  }

  const secret = generateSubscriptionSecret();

  let created: RateAlertSubscriptionRecord;
  try {
    created = await repository.createSubscription({
      corridorId: corridor.id,
      deliveryMethod,
      destination: destinationValidation.destination,
      secret,
      thresholdPercent: thresholdValidation.threshold,
    });
  } catch {
    return errorResult(
      500,
      "internal_error",
      "Unable to create alert subscription.",
    );
  }

  return Object.freeze({
    status: 201,
    body: serializeSubscription(created, corridor, true),
  });
}

export async function getAlertSubscription(
  id: string | null,
  dependencies: AlertSubscriptionsApiDependencies = {},
): Promise<AlertSubscriptionApiResult> {
  if (!id || typeof id !== "string" || id.trim() === "") {
    return errorResult(
      400,
      "subscription_not_found",
      "Subscription ID is required.",
    );
  }

  const repository =
    dependencies.repository ?? PRISMA_ALERT_SUBSCRIPTION_REPOSITORY;

  let record: RateAlertSubscriptionRecord | null;
  try {
    record = await repository.findSubscriptionById(id.trim());
  } catch {
    return errorResult(
      500,
      "internal_error",
      "Unable to query subscription.",
    );
  }

  if (!record) {
    return errorResult(
      404,
      "subscription_not_found",
      "Subscription not found.",
    );
  }

  const corridor = await repository.findCorridorBySlug(record.corridorSlug);
  if (!corridor) {
    return errorResult(404, "corridor_not_found", "Corridor not found.");
  }

  return Object.freeze({
    status: 200,
    body: serializeSubscription(record, corridor, false),
  });
}

export async function listAlertSubscriptionsByCorridor(
  corridorSlug: string | null,
  dependencies: AlertSubscriptionsApiDependencies = {},
): Promise<AlertSubscriptionApiResult> {
  const corridorValidation = validateCorridorParameter(corridorSlug);
  if (!corridorValidation.ok) return corridorValidation.result;

  const repository =
    dependencies.repository ?? PRISMA_ALERT_SUBSCRIPTION_REPOSITORY;

  let corridor;
  try {
    corridor = await repository.findCorridorBySlug(
      corridorValidation.corridorSlug,
    );
  } catch {
    return errorResult(500, "internal_error", "Unable to query corridor.");
  }

  if (!corridor) {
    return errorResult(404, "corridor_not_found", "Corridor not found.");
  }

  let records: readonly RateAlertSubscriptionRecord[];
  try {
    records = await repository.findSubscriptionsByCorridor(corridor.id, true);
  } catch {
    return errorResult(
      500,
      "internal_error",
      "Unable to list subscriptions.",
    );
  }

  const subscriptions = Object.freeze(
    records.map((rec) => serializeSubscription(rec, corridor, false)),
  );

  return Object.freeze({
    status: 200,
    body: Object.freeze({ subscriptions }),
  });
}

export async function deleteAlertSubscription(
  id: string | null,
  dependencies: AlertSubscriptionsApiDependencies = {},
): Promise<AlertSubscriptionApiResult> {
  if (!id || typeof id !== "string" || id.trim() === "") {
    return errorResult(
      400,
      "subscription_not_found",
      "Subscription ID is required.",
    );
  }

  const repository =
    dependencies.repository ?? PRISMA_ALERT_SUBSCRIPTION_REPOSITORY;

  let existing;
  try {
    existing = await repository.findSubscriptionById(id.trim());
  } catch {
    return errorResult(
      500,
      "internal_error",
      "Unable to query subscription.",
    );
  }

  if (!existing || !existing.isActive) {
    return errorResult(
      404,
      "subscription_not_found",
      "Subscription not found.",
    );
  }

  const success = await repository.deactivateSubscription(id.trim());
  if (!success) {
    return errorResult(
      500,
      "internal_error",
      "Unable to cancel subscription.",
    );
  }

  return Object.freeze({
    status: 200,
    body: Object.freeze({
      success: true,
      message: "Subscription cancelled successfully.",
    }),
  });
}

function serializeSubscription(
  record: RateAlertSubscriptionRecord,
  corridor: Readonly<{
    slug: string;
    assetCodeFrom: string;
    countryFrom: string;
    assetCodeTo: string;
    countryTo: string;
  }>,
  includeSecret: boolean,
): PublicAlertSubscriptionResponse {
  return Object.freeze({
    id: record.id,
    corridor: Object.freeze({
      slug: corridor.slug,
      sourceAsset: corridor.assetCodeFrom,
      sourceCountry: corridor.countryFrom,
      destinationAsset: corridor.assetCodeTo,
      destinationCountry: corridor.countryTo,
    }),
    deliveryMethod: record.deliveryMethod,
    destination: record.destination,
    thresholdPercent: record.thresholdPercent,
    isActive: record.isActive,
    lastNotifiedAt: record.lastNotifiedAt
      ? record.lastNotifiedAt.toISOString()
      : null,
    createdAt: record.createdAt.toISOString(),
    ...(includeSecret ? { secret: record.secret } : {}),
  });
}

function validateCorridorParameter(
  value: unknown,
):
  | Readonly<{ ok: true; corridorSlug: string }>
  | Readonly<{ ok: false; result: AlertSubscriptionApiResult }> {
  if (typeof value !== "string" || value.trim() === "") {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "missing_corridor",
        "A corridor slug is required.",
      ),
    });
  }

  const trimmed = value.trim();
  if (
    trimmed.length > MAX_CORRIDOR_SLUG_LENGTH ||
    !CORRIDOR_SLUG_PATTERN.test(trimmed)
  ) {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "invalid_corridor",
        "The corridor slug is invalid.",
      ),
    });
  }

  return Object.freeze({ ok: true, corridorSlug: trimmed });
}

function validateDestination(
  value: unknown,
):
  | Readonly<{ ok: true; destination: string }>
  | Readonly<{ ok: false; result: AlertSubscriptionApiResult }> {
  if (typeof value !== "string" || value.trim() === "") {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "missing_destination",
        "A destination URL is required.",
      ),
    });
  }

  const ssrfCheck = validateWebhookDestinationUrl(value);
  if (!ssrfCheck.ok) {
    return Object.freeze({
      ok: false,
      result: errorResult(400, "invalid_destination", ssrfCheck.error),
    });
  }

  return Object.freeze({ ok: true, destination: ssrfCheck.url });
}

function validateThreshold(
  value: unknown,
):
  | Readonly<{ ok: true; threshold: number }>
  | Readonly<{ ok: false; result: AlertSubscriptionApiResult }> {
  if (value === undefined || value === null) {
    return Object.freeze({ ok: true, threshold: DEFAULT_THRESHOLD_PERCENT });
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "invalid_threshold",
        `Threshold must be a number between ${MIN_THRESHOLD_PERCENT} and ${MAX_THRESHOLD_PERCENT}.`,
      ),
    });
  }

  if (value < MIN_THRESHOLD_PERCENT || value > MAX_THRESHOLD_PERCENT) {
    return Object.freeze({
      ok: false,
      result: errorResult(
        400,
        "invalid_threshold",
        `Threshold must be a number between ${MIN_THRESHOLD_PERCENT} and ${MAX_THRESHOLD_PERCENT}.`,
      ),
    });
  }

  return Object.freeze({ ok: true, threshold: value });
}

function errorResult(
  status: 400 | 404 | 500,
  code: AlertSubscriptionApiErrorCode,
  message: string,
): AlertSubscriptionApiResult {
  return Object.freeze({
    status,
    body: Object.freeze({
      error: Object.freeze({ code, message }),
    }),
  });
}
