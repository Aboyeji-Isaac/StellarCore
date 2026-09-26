import assert from "node:assert/strict";
import test from "node:test";

import { validateWebhookDestinationUrl } from "@/lib/alerts/ssrf";

test("valid public HTTPS URLs are accepted", () => {
  const result = validateWebhookDestinationUrl("https://example.com/webhooks/rates");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.url, "https://example.com/webhooks/rates");
});

test("HTTP is allowed when configured and rejected when disallowed", () => {
  const disallowed = validateWebhookDestinationUrl("http://example.com/webhook", {
    allowHttp: false,
  });
  assert.equal(disallowed.ok, false);
  if (!disallowed.ok) {
    assert.match(disallowed.error, /HTTPS/);
  }

  const allowed = validateWebhookDestinationUrl("http://example.com/webhook", {
    allowHttp: true,
  });
  assert.equal(allowed.ok, true);
});

test("SSRF validator blocks loopback and local hostnames", () => {
  const blockedHosts = [
    "https://localhost/webhook",
    "https://api.localhost/hook",
    "https://internal-service.local/rates",
    "https://metadata.internal/rates",
    "https://printer.lan/alerts",
  ];

  for (const url of blockedHosts) {
    const result = validateWebhookDestinationUrl(url);
    assert.equal(result.ok, false, `Expected ${url} to be blocked`);
    if (!result.ok) {
      assert.match(result.error, /local or internal/);
    }
  }
});

test("SSRF validator blocks private and loopback IPv4 addresses", () => {
  const privateIps = [
    "https://127.0.0.1/hook",
    "https://127.0.0.2/hook",
    "https://10.0.0.1/hook",
    "https://10.254.12.3/hook",
    "https://172.16.0.1/hook",
    "https://172.31.255.255/hook",
    "https://192.168.1.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://0.0.0.0/hook",
    "https://224.0.0.1/hook",
  ];

  for (const url of privateIps) {
    const result = validateWebhookDestinationUrl(url);
    assert.equal(result.ok, false, `Expected ${url} to be blocked`);
    if (!result.ok) {
      assert.match(result.error, /private or loopback/);
    }
  }
});

test("SSRF validator blocks private and loopback IPv6 addresses", () => {
  const privateIpv6 = [
    "https://[::1]/hook",
    "https://[fc00::1]/hook",
    "https://[fd12:3456:789a::1]/hook",
    "https://[fe80::1]/hook",
  ];

  for (const url of privateIpv6) {
    const result = validateWebhookDestinationUrl(url);
    assert.equal(result.ok, false, `Expected ${url} to be blocked`);
  }
});

test("URLs with embedded user credentials are rejected", () => {
  const result = validateWebhookDestinationUrl("https://admin:secret@example.com/webhook");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /embedded user credentials/);
  }
});

test("empty and invalid URLs are rejected", () => {
  assert.equal(validateWebhookDestinationUrl("").ok, false);
  assert.equal(validateWebhookDestinationUrl("not-a-url").ok, false);
});
