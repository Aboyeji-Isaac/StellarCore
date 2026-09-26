import assert from "node:assert/strict";
import test from "node:test";

import {
  createAlertSubscription,
  deleteAlertSubscription,
  getAlertSubscription,
  listAlertSubscriptionsByCorridor,
} from "@/lib/api/alertSubscriptions";
import type { AlertSubscriptionRepository } from "@/lib/alerts/alertSubscriptionRepository";
import type { RateAlertSubscriptionRecord } from "@/types/alerts";

const CORRIDOR_SLUG = "usdc-us-brl-br";
const CORRIDOR = Object.freeze({
  id: "corridor-id-1",
  slug: CORRIDOR_SLUG,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

test("createAlertSubscription validates input parameters and returns secret once", async () => {
  const repository = mockRepository();
  const result = await createAlertSubscription(
    {
      corridor: CORRIDOR_SLUG,
      deliveryMethod: "WEBHOOK",
      destination: "https://api.example.com/alerts",
      thresholdPercent: 2.5,
    },
    { repository },
  );

  assert.equal(result.status, 201);
  if (result.status !== 201 || !("secret" in result.body) || !result.body.secret) return;
  assert.equal(result.body.corridor.slug, CORRIDOR_SLUG);
  assert.equal(result.body.destination, "https://api.example.com/alerts");
  assert.equal(result.body.thresholdPercent, 2.5);
  assert.equal(typeof result.body.secret, "string");
  assert.equal(result.body.secret.length, 64);
});

test("createAlertSubscription blocks SSRF targets with 400 invalid_destination", async () => {
  const repository = mockRepository();
  const result = await createAlertSubscription(
    {
      corridor: CORRIDOR_SLUG,
      destination: "https://127.0.0.1/internal",
    },
    { repository },
  );

  assert.equal(result.status, 400);
  if (result.status !== 400) return;
  assert.equal(result.body.error.code, "invalid_destination");
});

test("createAlertSubscription returns 404 for unknown corridor", async () => {
  const repository = mockRepository();
  const result = await createAlertSubscription(
    {
      corridor: "unknown-corridor",
      destination: "https://api.example.com/alerts",
    },
    { repository },
  );

  assert.equal(result.status, 404);
  if (result.status !== 404) return;
  assert.equal(result.body.error.code, "corridor_not_found");
});

test("getAlertSubscription redacts secret on read", async () => {
  const repository = mockRepository();
  const created = await createAlertSubscription(
    {
      corridor: CORRIDOR_SLUG,
      destination: "https://api.example.com/alerts",
    },
    { repository },
  );

  assert.equal(created.status, 201);
  if (created.status !== 201 || !("id" in created.body)) return;

  const read = await getAlertSubscription(created.body.id, { repository });
  assert.equal(read.status, 200);
  if (read.status !== 200 || !("destination" in read.body)) return;
  assert.equal("secret" in read.body, false);
  assert.equal(read.body.destination, "https://api.example.com/alerts");
});

test("listAlertSubscriptionsByCorridor returns all active subscriptions without secrets", async () => {
  const repository = mockRepository();
  await createAlertSubscription(
    { corridor: CORRIDOR_SLUG, destination: "https://api.example.com/1" },
    { repository },
  );
  await createAlertSubscription(
    { corridor: CORRIDOR_SLUG, destination: "https://api.example.com/2" },
    { repository },
  );

  const list = await listAlertSubscriptionsByCorridor(CORRIDOR_SLUG, {
    repository,
  });
  assert.equal(list.status, 200);
  if (list.status !== 200 || !("subscriptions" in list.body)) return;
  assert.equal(list.body.subscriptions.length, 2);
  assert.equal("secret" in list.body.subscriptions[0]!, false);
});

test("deleteAlertSubscription deactivates subscription", async () => {
  const repository = mockRepository();
  const created = await createAlertSubscription(
    { corridor: CORRIDOR_SLUG, destination: "https://api.example.com/del" },
    { repository },
  );

  assert.equal(created.status, 201);
  if (created.status !== 201) return;

  const deleted = await deleteAlertSubscription(created.body.id, { repository });
  assert.equal(deleted.status, 200);

  const readAfter = await getAlertSubscription(created.body.id, { repository });
  assert.equal(readAfter.status, 200);
  if (readAfter.status === 200 && "isActive" in readAfter.body) {
    assert.equal(readAfter.body.isActive, false);
  }
});

function mockRepository(): AlertSubscriptionRepository {
  const subscriptions = new Map<string, RateAlertSubscriptionRecord>();
  let idCounter = 1;

  return {
    async findCorridorBySlug(slug) {
      if (slug === CORRIDOR_SLUG) return CORRIDOR;
      return null;
    },

    async createSubscription(input) {
      const id = `sub-${idCounter++}`;
      const record: RateAlertSubscriptionRecord = Object.freeze({
        id,
        corridorId: input.corridorId,
        corridorSlug: CORRIDOR_SLUG,
        deliveryMethod: input.deliveryMethod,
        destination: input.destination,
        secret: input.secret,
        thresholdPercent: input.thresholdPercent,
        isActive: true,
        lastNotifiedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      subscriptions.set(id, record);
      return record;
    },

    async findSubscriptionById(id) {
      return subscriptions.get(id) ?? null;
    },

    async findSubscriptionsByCorridor(corridorId, activeOnly = true) {
      return [...subscriptions.values()].filter(
        (s) => s.corridorId === corridorId && (!activeOnly || s.isActive),
      );
    },

    async deactivateSubscription(id) {
      const record = subscriptions.get(id);
      if (!record) return false;
      subscriptions.set(id, { ...record, isActive: false });
      return true;
    },

    async updateLastNotified(id, notifiedAt) {
      const record = subscriptions.get(id);
      if (record) {
        subscriptions.set(id, { ...record, lastNotifiedAt: notifiedAt });
      }
    },
  };
}
