import assert from "node:assert/strict";
import test from "node:test";

import {
  probeAnchorsReachability,
  probeTomlReachability,
} from "@/lib/stellar/reachabilityProbe";

const ANCHOR = Object.freeze({
  slug: "moneygram",
  tomlUrl: "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
});

test("a successful TOML request is reported reachable with status and timing", async () => {
  const fetcher = (() => Promise.resolve(new Response("NETWORK_PASSPHRASE = \"...\"", {
    status: 200,
    headers: { "content-type": "text/plain" },
  }))) as typeof fetch;

  const result = await probeTomlReachability(ANCHOR, { fetcher });

  assert.equal(result.reachable, true);
  assert.equal(result.status, "reachable");
  assert.equal(result.slug, "moneygram");
  assert.equal(result.tomlUrl, ANCHOR.tomlUrl);
  assert.equal("httpStatus" in result, false);
  assert.equal("error" in result, false);
  assert.equal(typeof result.responseTimeMs, "number");
  assert.equal(Number.isFinite(result.checkedAt ? Date.parse(result.checkedAt) : NaN), true);
  assert.equal(Object.isFrozen(result), true);
});

test("a non-success HTTP response is reported unreachable with its status", async () => {
  const fetcher = (() => Promise.resolve(new Response("Not Found", {
    status: 404,
  }))) as typeof fetch;

  const result = await probeTomlReachability(ANCHOR, { fetcher });

  assert.equal(result.reachable, false);
  assert.equal(result.status, "unreachable");
  assert.equal(result.httpStatus, 404);
  assert.match(result.error ?? "", /404/);
});

test("a timeout aborts the probe and reports a timed-out unreachable result", async () => {
  const fetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      });
    })) as typeof fetch;

  const result = await probeTomlReachability(ANCHOR, { fetcher, timeoutMs: 5 });

  assert.equal(result.reachable, false);
  assert.equal(result.status, "unreachable");
  assert.match(result.error ?? "", /Timed out/);
});

test("a network failure is reported unreachable without throwing", async () => {
  const fetcher = (() => Promise.reject(new Error("DNS resolution failed"))) as typeof fetch;

  const result = await probeTomlReachability(ANCHOR, { fetcher });

  assert.equal(result.reachable, false);
  assert.equal(result.status, "unreachable");
  assert.match(result.error ?? "", /DNS resolution failed/);
});

test("one failed anchor does not prevent the remaining anchors from being probed", async () => {
  const moneygramUrl = "https://mgxanchor.moneygram.com/.well-known/stellar.toml";
  const cowrieUrl = "https://cowrie.exchange/.well-known/stellar.toml";
  const zeamUrl = "https://zeam.money/.well-known/stellar.toml";

  const fetchers: Record<string, typeof fetch> = {
    [moneygramUrl]: (() => Promise.reject(new Error("connection refused"))) as typeof fetch,
    [cowrieUrl]: (() => Promise.resolve(new Response("ok", { status: 200 }))) as typeof fetch,
    [zeamUrl]: (() => Promise.resolve(new Response("Service Unavailable", { status: 503 }))) as typeof fetch,
  };

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) =>
    fetchers[String(input)]!(input, init)) as typeof fetch;

  const results = await probeAnchorsReachability([
    ANCHOR,
    { slug: "cowrie", tomlUrl: cowrieUrl },
    { slug: "zeam", tomlUrl: zeamUrl },
  ], { fetcher });

  assert.equal(results.length, 3);
  assert.deepEqual(results.map(({ slug, reachable }) => [slug, reachable]), [
    ["moneygram", false],
    ["cowrie", true],
    ["zeam", false],
  ]);
  assert.equal(results.every((result) => Object.isFrozen(result)), true);
});