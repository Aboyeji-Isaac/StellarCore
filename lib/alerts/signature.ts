import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_BYTES = 32;

export function generateSubscriptionSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

export function computeWebhookSignature(
  payloadString: string,
  secret: string,
  timestamp: number | string,
): string {
  const message = `${timestamp}.${payloadString}`;
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function verifyWebhookSignature(
  payloadString: string,
  secret: string,
  timestamp: number | string,
  expectedSignature: string,
): boolean {
  const computed = computeWebhookSignature(payloadString, secret, timestamp);
  const sig = expectedSignature.startsWith("sha256=")
    ? expectedSignature.slice(7)
    : expectedSignature;

  const computedBuffer = Buffer.from(computed, "utf8");
  const expectedBuffer = Buffer.from(sig, "utf8");

  if (computedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(computedBuffer, expectedBuffer);
}
