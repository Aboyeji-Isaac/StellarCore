import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Versioned HMAC request authentication for the internal cron endpoint.
 *
 * The signature covers a canonical string of the protocol version, method,
 * path and query, timestamp, nonce and SHA-256 of the body, so tampering with
 * any of them invalidates it. Requests are accepted only inside a narrow
 * timestamp window and only once: the nonce of every authenticated request is
 * reserved in shared storage until the window in which it could be replayed
 * has closed.
 */
export const CRON_SIGNATURE_VERSION = "v1";
export const CRON_TIMESTAMP_HEADER = "x-cron-timestamp";
export const CRON_NONCE_HEADER = "x-cron-nonce";
export const CRON_SIGNATURE_HEADER = "x-cron-signature";
/** A request is rejected when its timestamp is older than this. */
export const CRON_MAX_PAST_SKEW_SECONDS = 60;
/** A request is rejected when its timestamp is further ahead than this. */
export const CRON_MAX_FUTURE_SKEW_SECONDS = 10;

const CONTEXT = "stellarcore-cron";
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE_PATTERN = /^v1=([0-9a-f]{64})$/;

export type CronNonceStore = Readonly<{
  /**
   * Atomically records the nonce until `expiresAt` and returns whether this
   * call was the first to do so. Also drops nonces already expired at `now`.
   */
  reserve: (nonce: string, expiresAt: Date, now: Date) => Promise<boolean>;
}>;

export type SignedCronRejection =
  | "UNCONFIGURED"
  | "MALFORMED"
  | "EXPIRED"
  | "FUTURE"
  | "BAD_SIGNATURE"
  | "REPLAYED";

export type SignedCronVerification =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: SignedCronRejection }>;

export function hasSignedCronHeaders(headers: Headers): boolean {
  return headers.has(CRON_TIMESTAMP_HEADER)
    || headers.has(CRON_NONCE_HEADER)
    || headers.has(CRON_SIGNATURE_HEADER);
}

/** Builds the headers a scheduler sends. Also used by the tests. */
export function signCronRequest(input: Readonly<{
  method: string;
  pathAndQuery: string;
  body?: Uint8Array | string;
  secret: string;
  timestampSeconds: number;
  nonce: string;
}>): Record<string, string> {
  const timestamp = String(input.timestampSeconds);
  return {
    [CRON_TIMESTAMP_HEADER]: timestamp,
    [CRON_NONCE_HEADER]: input.nonce,
    [CRON_SIGNATURE_HEADER]: `${CRON_SIGNATURE_VERSION}=${mac(
      input.secret,
      input.method,
      input.pathAndQuery,
      timestamp,
      input.nonce,
      input.body ?? "",
    ).toString("hex")}`,
  };
}

export async function verifySignedCronRequest(
  request: Request,
  options: Readonly<{
    secret: string | undefined;
    nonceStore: CronNonceStore;
    now: Date;
  }>,
): Promise<SignedCronVerification> {
  if (!options.secret) return reject("UNCONFIGURED");

  const timestamp = request.headers.get(CRON_TIMESTAMP_HEADER);
  const nonce = request.headers.get(CRON_NONCE_HEADER);
  const signature = SIGNATURE_PATTERN.exec(request.headers.get(CRON_SIGNATURE_HEADER) ?? "");
  if (
    timestamp === null || !TIMESTAMP_PATTERN.test(timestamp)
    || nonce === null || !NONCE_PATTERN.test(nonce)
    || !signature
  ) return reject("MALFORMED");

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(options.now.getTime() / 1_000);
  if (timestampSeconds < nowSeconds - CRON_MAX_PAST_SKEW_SECONDS) return reject("EXPIRED");
  if (timestampSeconds > nowSeconds + CRON_MAX_FUTURE_SKEW_SECONDS) return reject("FUTURE");

  const url = new URL(request.url);
  const expected = mac(
    options.secret,
    request.method,
    url.pathname + url.search,
    timestamp,
    nonce,
    new Uint8Array(await request.arrayBuffer()),
  );
  const presented = Buffer.from(signature[1]!, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    return reject("BAD_SIGNATURE");
  }

  // Only authenticated requests reach the store, so unauthenticated traffic
  // cannot grow it. The nonce is kept until no request carrying this timestamp
  // could still pass the skew check above.
  const expiresAt = new Date((timestampSeconds + CRON_MAX_PAST_SKEW_SECONDS + 1) * 1_000);
  return await options.nonceStore.reserve(nonce, expiresAt, options.now)
    ? Object.freeze({ ok: true })
    : reject("REPLAYED");
}

function mac(
  secret: string,
  method: string,
  pathAndQuery: string,
  timestamp: string,
  nonce: string,
  body: Uint8Array | string,
): Buffer {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return createHmac("sha256", secret)
    .update([CONTEXT, CRON_SIGNATURE_VERSION, method.toUpperCase(), pathAndQuery, timestamp, nonce, bodyHash].join("\n"))
    .digest();
}

function reject(reason: SignedCronRejection): SignedCronVerification {
  return Object.freeze({ ok: false, reason });
}
