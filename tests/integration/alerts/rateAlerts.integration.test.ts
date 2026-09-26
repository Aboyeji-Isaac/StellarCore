import assert from "node:assert/strict";
import test from "node:test";

import { dispatchRateAlertsForCorridor } from "@/lib/alerts/alertDispatcher";
import { evaluateRateChangeForAlert } from "@/lib/alerts/rateChangeEvaluator";
import { verifyWebhookSignature } from "@/lib/alerts/signature";
import type { AlertSubscriptionRepository } from "@/lib/alerts/alertSubscriptionRepository";
import type {
  RateAlertEvaluationInput,
  RateAlertEventPayload,
  RateAlertSubscriptionRecord,
} from "@/types/alerts";

const CORRIDOR = Object.freeze({
  id: "c-1",
  slug: "usdc-us-brl-br",
  sourceAsset: "USDC",
  sourceCountry: "US",
  destinationAsset: "BRL",
  destinationCountry: "BR",
});

const NOW = new Date("2026-08-28T12:00:00.000Z");

test("End-to-end evaluation and dispatch delivers signed webhook to subscriber", async () => {
  const secret = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
  const subscription: RateAlertSubscriptionRecord = Object.freeze({
    id: "sub-123",
    corridorId: CORRIDOR.id,
    corridorSlug: CORRIDOR.slug,
    deliveryMethod: "WEBHOOK",
    destination: "https://subscriber.example.com/rates-webhook",
    secret,
    thresholdPercent: 1.0,
    isActive: true,
    lastNotifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const repository: AlertSubscriptionRepository = {
    async findCorridorBySlug() {
      return {
        id: "c-1",
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      };
    },
    async createSubscription() {
      return subscription;
    },
    async findSubscriptionById() {
      return subscription;
    },
    async findSubscriptionsByCorridor() {
      return [subscription];
    },
    async deactivateSubscription() {
      return true;
    },
    async updateLastNotified() {},
  };

  const evaluationInput: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: {
      state: "healthy",
      medianRate: "5.0000",
      evaluatedAt: new Date(NOW.getTime() - 60_000),
    },
    currentEvaluation: {
      state: "healthy",
      medianRate: "5.1500", // 3.0% increase (exceeds 1.0% threshold)
      evaluatedAt: NOW,
    },
  };

  const evalResult = evaluateRateChangeForAlert(evaluationInput, 1.0);
  assert.equal(evalResult.shouldAlert, true);
  if (!evalResult.shouldAlert) return;

  let capturedUrl: string | undefined;
  let capturedHeaders: Record<string, string> = {};
  let capturedBody: string | undefined;

  const mockFetch: typeof fetch = async (input, init) => {
    capturedUrl = input.toString();
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const dispatchResult = await dispatchRateAlertsForCorridor(
    CORRIDOR,
    evalResult,
    {
      repository,
      fetchFn: mockFetch,
      now: () => NOW,
    },
  );

  assert.equal(dispatchResult.attempted, 1);
  assert.equal(dispatchResult.delivered, 1);
  assert.equal(dispatchResult.failed, 0);
  assert.equal(dispatchResult.skipped, 0);

  assert.equal(capturedUrl, "https://subscriber.example.com/rates-webhook");
  assert.equal(capturedHeaders["Content-Type"], "application/json");
  assert.equal(capturedHeaders["X-StellarCore-Event"], "corridor.rate_change");
  assert.ok(capturedHeaders["X-StellarCore-Signature"]);
  assert.ok(capturedHeaders["X-StellarCore-Timestamp"]);

  // Verify HMAC signature authenticity
  const isValidSignature = verifyWebhookSignature(
    capturedBody!,
    secret,
    capturedHeaders["X-StellarCore-Timestamp"]!,
    capturedHeaders["X-StellarCore-Signature"]!,
  );
  assert.equal(isValidSignature, true);

  const payload: RateAlertEventPayload = JSON.parse(capturedBody!);
  assert.equal(payload.event, "corridor.rate_change");
  assert.equal(payload.changeType, "RATE_MOVEMENT");
  assert.equal(payload.previousRate, "5.0000");
  assert.equal(payload.currentRate, "5.1500");
  assert.equal(payload.percentageChange, 3);
  assert.equal(payload.thresholdPercent, 1.0);
});
