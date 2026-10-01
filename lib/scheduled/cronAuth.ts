import { createHash, timingSafeEqual } from "node:crypto";

import { getRuntimeConfig } from "@/lib/config/runtimeConfig";

export function hasValidCronAuthorization(
  authorization: string | null,
  secret?: string,
): boolean {
  // If secret is explicitly provided, use it without validating full runtime config.
  // This allows tests to inject secrets without requiring full environment setup.
  if (secret !== undefined) {
    const effectiveSecret = secret;
    if (!effectiveSecret || !authorization) return false;

    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) return false;

    return timingSafeEqual(digest(effectiveSecret), digest(match[1]!));
  }

  // No explicit secret: use runtime config (requires valid environment setup).
  const config = getRuntimeConfig();
  const effectiveSecret = config.cronSecret;

  if (!effectiveSecret || !authorization) return false;

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;

  return timingSafeEqual(digest(effectiveSecret), digest(match[1]!));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}