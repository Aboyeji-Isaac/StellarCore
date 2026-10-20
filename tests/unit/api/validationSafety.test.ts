import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as anchorsRoute from "@/app/api/anchors/route";
import * as corridorsRoute from "@/app/api/corridors/route";
import * as rateHistoryRoute from "@/app/api/rates/history/route";
import * as ratesRoute from "@/app/api/rates/route";

const FAKE_SECRET = "sk_live_FAKE_SECRET_abc123";
const FAKE_JWT = "eyJhbGciOi.FAKEPAYLOAD.FAKESIG";
const LONG_VALUE = "x".repeat(5000);

const HOSTILE_VALUES = [FAKE_SECRET, FAKE_JWT, LONG_VALUE, "postgresql://u:pw@db.internal/x"];

type ErrorBody = { error: { code: string; message: string } };

async function assertSafeValidation(
  response: Response,
  code: string,
  field: string,
  hostile: string,
): Promise<void> {
  assert.equal(response.status, 400);
  const body = (await response.json()) as ErrorBody;
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message"]);
  assert.equal(body.error.code, code);
  assert.match(body.error.message, new RegExp(field, "i"));
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(hostile), false);
  assert.equal(serialized.includes(hostile.slice(0, 20)), false);
  assert.ok(serialized.length < 500);
}

test("rate history days errors name the parameter without echoing input", async () => {
  for (const hostile of HOSTILE_VALUES) {
    const response = await rateHistoryRoute.GET(
      new Request(
        `http://localhost/api/rates/history?corridor=usdc-us-brl-br&days=${encodeURIComponent(hostile)}`,
      ),
    );
    await assertSafeValidation(response, "invalid_days", "days", hostile);
  }
});

test("rate history and rates corridor errors do not echo the supplied slug", async () => {
  for (const hostile of HOSTILE_VALUES) {
    const encoded = encodeURIComponent(hostile);
    await assertSafeValidation(
      await rateHistoryRoute.GET(
        new Request(`http://localhost/api/rates/history?corridor=${encoded}`),
      ),
      "invalid_corridor",
      "corridor",
      hostile,
    );
    await assertSafeValidation(
      await ratesRoute.GET(new Request(`http://localhost/api/rates?corridor=${encoded}`)),
      "invalid_corridor",
      "corridor",
      hostile,
    );
  }
});

test("pagination errors on directory endpoints name the field without echoing input", async () => {
  for (const hostile of HOSTILE_VALUES) {
    const encoded = encodeURIComponent(hostile);
    for (const route of [anchorsRoute, corridorsRoute]) {
      await assertSafeValidation(
        await route.GET(new Request(`http://localhost/api/x?limit=${encoded}`)),
        "invalid_pagination",
        "limit",
        hostile,
      );
      await assertSafeValidation(
        await route.GET(new Request(`http://localhost/api/x?offset=${encoded}`)),
        "invalid_pagination",
        "offset",
        hostile,
      );
    }
  }
});

test("slug path errors do not echo the supplied slug", async () => {
  for (const hostile of HOSTILE_VALUES) {
    const response = await anchorDetailRoute.GET(
      new Request("http://localhost/api/anchors/x"),
      { params: Promise.resolve({ slug: hostile }) },
    );
    await assertSafeValidation(response, "invalid_anchor_slug", "slug", hostile);
  }
});
