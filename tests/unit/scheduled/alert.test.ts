import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCronFailureAlertContent,
  CRON_FAILURE_WEBHOOK_URL_ENV,
  sendCronFailureAlert,
  type CronFailureAlert,
} from "@/lib/scheduled/alert";

const ALERT: CronFailureAlert = Object.freeze({
  step: "rate snapshot",
  error: "quote request failed",
  timestamp: "2026-08-31T16:00:00.000Z",
});

test("alert payload contains the failed step, error message, and timestamp", () => {
  const content = buildCronFailureAlertContent(ALERT);
  assert.equal(typeof content.content, "string");
  assert.match(content.content, /rate snapshot/);
  assert.match(content.content, /quote request failed/);
  assert.match(content.content, /2026-08-31T16:00:00\.000Z/);
  assert.equal(Object.isFrozen(content), true);
});

test("no webhook is called when the env var is unset and a log notice is emitted", async () => {
  const calls: string[] = [];
  const fetcher = (() => {
    calls.push("fetcher");
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;

  const previous = process.env[CRON_FAILURE_WEBHOOK_URL_ENV];
  delete process.env[CRON_FAILURE_WEBHOOK_URL_ENV];
  try {
    await sendCronFailureAlert(ALERT, { fetcher, log: (message) => calls.push(message) });
  } finally {
    if (previous !== undefined) process.env[CRON_FAILURE_WEBHOOK_URL_ENV] = previous;
  }

  assert.deepEqual(calls, ["CRON_FAILURE_WEBHOOK_URL is not configured; skipping failure alert for rate snapshot"]);
});

test("a configured webhook receives exactly one POST with a JSON content payload", async () => {
  let posts = 0;
  const fetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    posts += 1;
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.match(body.content, /rate snapshot/);
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;

  await sendCronFailureAlert(ALERT, { webhookUrl: "https://hooks.example.test/failure", fetcher });

  assert.equal(posts, 1);
});

test("a webhook failure is logged and does not throw", async () => {
  const messages: string[] = [];
  const fetcher = (() => Promise.reject(new Error("connection refused"))) as typeof fetch;

  await sendCronFailureAlert(ALERT, {
    webhookUrl: "https://hooks.example.test/failure",
    fetcher,
    log: (message) => messages.push(message),
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /failed to deliver rate snapshot failure alert: connection refused/);
});

test("an explicit webhookUrl takes precedence over the environment variable", async () => {
  const previous = process.env[CRON_FAILURE_WEBHOOK_URL_ENV];
  process.env[CRON_FAILURE_WEBHOOK_URL_ENV] = "https://hooks.example.test/from-env";
  const received: string[] = [];
  try {
    const fetcher = ((input: Parameters<typeof fetch>[0]) => {
      received.push(String(input));
      return Promise.resolve(new Response("ok", { status: 200 }));
    }) as typeof fetch;

    await sendCronFailureAlert(ALERT, {
      webhookUrl: "https://hooks.example.test/explicit",
      fetcher,
    });
  } finally {
    if (previous !== undefined) process.env[CRON_FAILURE_WEBHOOK_URL_ENV] = previous;
    else delete process.env[CRON_FAILURE_WEBHOOK_URL_ENV];
  }

  assert.deepEqual(received, ["https://hooks.example.test/explicit"]);
});