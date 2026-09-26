export type AlertDeliveryMethodType = "WEBHOOK" | "EMAIL";

export type RateAlertChangeType =
  | "RATE_MOVEMENT"
  | "RATE_AVAILABLE"
  | "RATE_UNAVAILABLE";

export type RateAlertSubscriptionRecord = Readonly<{
  id: string;
  corridorId: string;
  corridorSlug: string;
  deliveryMethod: AlertDeliveryMethodType;
  destination: string;
  secret: string;
  thresholdPercent: number;
  isActive: boolean;
  lastNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type RateAlertEventPayload = Readonly<{
  event: "corridor.rate_change";
  subscriptionId: string;
  corridor: Readonly<{
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>;
  changeType: RateAlertChangeType;
  previousRate: string | null;
  currentRate: string | null;
  previousState: "healthy" | "insufficient_fresh_sources";
  currentState: "healthy" | "insufficient_fresh_sources";
  percentageChange: number | null;
  thresholdPercent: number;
  evaluatedAt: string;
}>;

export type RateAlertEvaluationInput = Readonly<{
  corridor: Readonly<{
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>;
  previousEvaluation: Readonly<{
    state: "healthy" | "insufficient_fresh_sources";
    medianRate: string | null;
    evaluatedAt: Date | string;
  }> | null;
  currentEvaluation: Readonly<{
    state: "healthy" | "insufficient_fresh_sources";
    medianRate: string | null;
    evaluatedAt: Date | string;
  }>;
}>;

export type RateAlertEvaluationResult =
  | Readonly<{
      shouldAlert: true;
      changeType: RateAlertChangeType;
      percentageChange: number | null;
      previousRate: string | null;
      currentRate: string | null;
      previousState: "healthy" | "insufficient_fresh_sources";
      currentState: "healthy" | "insufficient_fresh_sources";
      evaluatedAt: string;
    }>
  | Readonly<{
      shouldAlert: false;
      reason:
        | "NO_PREVIOUS_EVALUATION"
        | "BOTH_INSUFFICIENT_SOURCES"
        | "BELOW_THRESHOLD"
        | "NO_RATE_CHANGE";
    }>;
