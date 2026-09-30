import assert from "node:assert/strict";
import test from "node:test";

import {
  CRON_MAX_FUTURE_SKEW_SECONDS,
  CRON_MAX_PAST_SKEW_SECONDS,
  CRON_NONCE_HEADER,
  CRON_SIGNATURE_HEADER,
  CRON_TIMESTAMP_HEADER,
  signCronRequest,
  verifySignedCronRequest,
  type CronNonceStore,
} from "@/lib/scheduled/signedCronAuth";

const SECRET = "local-test-cron-secret";
const URL_ = "http://localhost/api/internal/cron/refresh";
const NOW = new Date("2026-09-30T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1_000;
const NONCE = "abcdefghijklmnop0123";

function memoryStore() {
  const seen = new Map<string, Date>();
  const store: CronNonceStore = {
    reserve: async (nonce, expiresAt, now) => {
      for (const [key, expiry] of seen) if (expiry < now) seen.delete(key);
      if (seen.has(nonce)) return false;
      seen.set(nonce, expiresAt);
      return true;
    },
  };
  return { seen, store };
}

function signed(overrides: Partial<Parameters<typeof signCronRequest>[0]> = {}, url = URL_, method = "GET") {
  const headers = signCronRequest({
    method,
    pathAndQuery: new URL(url).pathname + new URL(url).search,
    secret: SECRET,
    timestampSeconds: NOW_S,
    nonce: NONCE,
    ...overrides,
  });
  return new Request(url, { method, headers });
}

const verify = (request: Request, store: CronNonceStore, now = NOW, secret: string | undefined = SECRET) =>
  verifySignedCronRequest(request, { secret, nonceStore: store, now });

test("a valid signed request succeeds once and the identical replay is rejected", async () => {
  const { store } = memoryStore();
  assert.deepEqual(await verify(signed(), store), { ok: true });
  assert.deepEqual(await verify(signed(), store), { ok: false, reason: "REPLAYED" });
});

test("concurrent replays of one signed request admit exactly one", async () => {
  const { store } = memoryStore();
  const results = await Promise.all(Array.from({ length: 20 }, () => verify(signed(), store)));
  assert.equal(results.filter(({ ok }) => ok).length, 1);
  assert.ok(results.every((result) => result.ok || result.reason === "REPLAYED"));
});

test("timestamps outside the narrow window are rejected without reserving a nonce", async () => {
  const { store, seen } = memoryStore();
  const edge = async (offset: number) => verify(signed({ timestampSeconds: NOW_S + offset }), store);
  assert.deepEqual(await edge(-CRON_MAX_PAST_SKEW_SECONDS - 1), { ok: false, reason: "EXPIRED" });
  assert.deepEqual(await edge(CRON_MAX_FUTURE_SKEW_SECONDS + 1), { ok: false, reason: "FUTURE" });
  assert.equal(seen.size, 0);
  assert.deepEqual(await edge(CRON_MAX_FUTURE_SKEW_SECONDS), { ok: true });
});

test("the oldest acceptable timestamp is still accepted", async () => {
  const { store } = memoryStore();
  assert.deepEqual(
    await verify(signed({ timestampSeconds: NOW_S - CRON_MAX_PAST_SKEW_SECONDS, nonce: "oldestnonce0123456" }), store),
    { ok: true },
  );
});

test("tampering with method, path, query, body, nonce, timestamp, or secret invalidates the signature", async () => {
  const cases: Array<[string, Request]> = [
    ["method", new Request(URL_, { method: "POST", headers: signCronRequest({ method: "GET", pathAndQuery: "/api/internal/cron/refresh", secret: SECRET, timestampSeconds: NOW_S, nonce: NONCE }) })],
    ["path", new Request("http://localhost/api/internal/cron/other", { headers: signCronRequest({ method: "GET", pathAndQuery: "/api/internal/cron/refresh", secret: SECRET, timestampSeconds: NOW_S, nonce: NONCE }) })],
    ["query", new Request(`${URL_}?x=1`, { headers: signCronRequest({ method: "GET", pathAndQuery: "/api/internal/cron/refresh", secret: SECRET, timestampSeconds: NOW_S, nonce: NONCE }) })],
    ["body", new Request(URL_, { method: "POST", body: "tampered", headers: signCronRequest({ method: "POST", pathAndQuery: "/api/internal/cron/refresh", body: "original", secret: SECRET, timestampSeconds: NOW_S, nonce: NONCE }) })],
    ["secret", signed({ secret: "another-secret" })],
  ];
  for (const [label, request] of cases) {
    const { store } = memoryStore();
    assert.deepEqual(await verify(request, store), { ok: false, reason: "BAD_SIGNATURE" }, label);
  }

  const original = signed();
  const swap = (name: string, value: string) => {
    const headers = new Headers(original.headers);
    headers.set(name, value);
    return new Request(URL_, { headers });
  };
  const { store } = memoryStore();
  assert.deepEqual(await verify(swap(CRON_NONCE_HEADER, "differentnonce012345"), store), { ok: false, reason: "BAD_SIGNATURE" });
  assert.deepEqual(await verify(swap(CRON_TIMESTAMP_HEADER, String(NOW_S + 1)), store), { ok: false, reason: "BAD_SIGNATURE" });
});

test("a signed request with a body verifies when the body matches", async () => {
  const { store } = memoryStore();
  const headers = signCronRequest({ method: "POST", pathAndQuery: "/api/internal/cron/refresh", body: "payload", secret: SECRET, timestampSeconds: NOW_S, nonce: NONCE });
  assert.deepEqual(await verify(new Request(URL_, { method: "POST", body: "payload", headers }), store), { ok: true });
});

test("malformed or missing material and a missing secret are rejected", async () => {
  const { store } = memoryStore();
  const good = signed();
  const mutate = (name: string, value: string | null) => {
    const headers = new Headers(good.headers);
    if (value === null) headers.delete(name); else headers.set(name, value);
    return new Request(URL_, { headers });
  };
  for (const request of [
    mutate(CRON_TIMESTAMP_HEADER, null),
    mutate(CRON_TIMESTAMP_HEADER, "12ab"),
    mutate(CRON_TIMESTAMP_HEADER, "-5"),
    mutate(CRON_NONCE_HEADER, null),
    mutate(CRON_NONCE_HEADER, "short"),
    mutate(CRON_NONCE_HEADER, "has spaces in it 12345"),
    mutate(CRON_SIGNATURE_HEADER, null),
    mutate(CRON_SIGNATURE_HEADER, "v2=" + "0".repeat(64)),
    mutate(CRON_SIGNATURE_HEADER, "v1=zz"),
  ]) {
    assert.deepEqual(await verify(request, store), { ok: false, reason: "MALFORMED" });
  }
  for (const secret of [undefined, ""]) {
    assert.deepEqual(
      await verifySignedCronRequest(good, { secret, nonceStore: store, now: NOW }),
      { ok: false, reason: "UNCONFIGURED" },
    );
  }
});

test("nonce retention ends with the replay window and a stored nonce is bounded by it", async () => {
  const { store, seen } = memoryStore();
  await verify(signed({ nonce: "firstnonce0123456789" }), store);
  const expiry = [...seen.values()][0]!.getTime() / 1_000;
  assert.equal(expiry, NOW_S + CRON_MAX_PAST_SKEW_SECONDS + 1);

  const later = new Date((expiry + 1) * 1_000);
  const request = signed({ nonce: "secondnonce012345678", timestampSeconds: later.getTime() / 1_000 });
  assert.deepEqual(await verify(request, store, later), { ok: true });
  assert.equal(seen.size, 1);
});

test("verification never exposes the secret or signature in its result", async () => {
  const { store } = memoryStore();
  const request = signed();
  const outcomes = [await verify(request, store), await verify(signed(), store), await verify(signed({ secret: "x" , nonce: "othernonce0123456789" }), store)];
  const text = JSON.stringify(outcomes);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(request.headers.get(CRON_SIGNATURE_HEADER)!), false);
});
