import type { AlertDeliveryMethodType } from "@/types/alerts";

export type CreateAlertSubscriptionRequestBody = Readonly<{
  corridor: string;
  deliveryMethod?: AlertDeliveryMethodType;
  destination: string;
  thresholdPercent?: number;
}>;

export type PublicAlertSubscriptionResponse = Readonly<{
  id: string;
  corridor: Readonly<{
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>;
  deliveryMethod: AlertDeliveryMethodType;
  destination: string;
  thresholdPercent: number;
  isActive: boolean;
  lastNotifiedAt: string | null;
  createdAt: string;
  secret?: string; // only provided once upon creation
}>;

export type AlertSubscriptionApiErrorCode =
  | "missing_corridor"
  | "invalid_corridor"
  | "corridor_not_found"
  | "missing_destination"
  | "invalid_destination"
  | "invalid_threshold"
  | "invalid_delivery_method"
  | "subscription_not_found"
  | "internal_error";

export type AlertSubscriptionApiErrorResponse = Readonly<{
  error: Readonly<{
    code: AlertSubscriptionApiErrorCode;
    message: string;
  }>;
}>;

export type AlertSubscriptionApiResult =
  | Readonly<{ status: 200 | 201; body: PublicAlertSubscriptionResponse }>
  | Readonly<{
      status: 200;
      body: Readonly<{
        subscriptions: readonly PublicAlertSubscriptionResponse[];
      }>;
    }>
  | Readonly<{
      status: 200;
      body: Readonly<{
        success: true;
        message: string;
      }>;
    }>
  | Readonly<{
      status: 400 | 404 | 500;
      body: AlertSubscriptionApiErrorResponse;
    }>;
