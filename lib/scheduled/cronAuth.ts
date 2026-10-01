import { createHash, timingSafeEqual } from "node:crypto";

import { getRuntimeConfig } from "@/lib/config/runtimeConfig";

export function hasValidCronAuthorization(
  authorization: string | null,
  secret?: string,
): boolean {
  const effectiveSecret = secret ?? getRuntimeConfig().cronSecret;
  if (!effectiveSecret || !authorization) return false;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;

  return timingSafeEqual(digest(effectiveSecret), digest(match[1]!));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
