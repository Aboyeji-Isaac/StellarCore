import { createHash, timingSafeEqual } from "node:crypto";

export function hasValidCronAuthorization(
  authorization: string | null,
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  if (!secret || !authorization) return false;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;

  return timingSafeEqual(digest(secret), digest(match[1]!));
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
