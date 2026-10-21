import assert from "node:assert/strict";
import test from "node:test";

import {
  createEgressFetch,
  EgressPolicyError,
  type ResolvedAddress,
} from "@/lib/stellar/outboundEgress";
import { fetchSep1Toml, Sep1DiscoveryError } from "@/lib/stellar/sep1";
import { getSep38Info, Sep38ClientError } from "@/lib/stellar/sep38";

const ORIGIN = "https://anchor.example";
const TOML_URL = `${ORIGIN}/.well-known/stellar.toml`;
const INFO_URL = `${ORIGIN}/info`;
const OFF_ORIGIN = "https://collector.example/evidence";

const ANSWERS: Readonly<Record<string, readonly ResolvedAddress[]>> = Object.freeze({
  "anchor.example": Object.freeze([
    Object.freeze({ address: "8.8.8.8", family: 4 as const }),
  ]),
  "collector.example": Object.freeze([
    Object.freeze({ address: "8.8.4.4", family: 4 as const }),
  ]),
  "metadata.internal": Object.freeze([
    Object.freeze({ address: "169.254.169.254", family: 4 as const }),
  ]),
});

type Route = () => Response;

function redirectTo(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

/**
 * Deterministic stand-in for the configured evidence origin. It runs behind the
 * real egress transport, records every DNS answer and socket request, and fails
 * the run if a policy regression turns a redirect into a request storm. No
 * socket is opened and no hostname outside this table can be resolved.
 */
function createSyntheticOrigin(
  routes: Readonly<Record<string, Route>> = {},
  requestBudget = 8,
) {
  const requested: string[] = [];
  const resolved: string[] = [];

  const fetcher = createEgressFetch({
    resolver: async (hostname) => {
      resolved.push(hostname);
      const answers = ANSWERS[hostname];
      if (!answers) throw new EgressPolicyError("DNS_FAILURE", hostname);
      return answers;
    },
    request: async (url) => {
      requested.push(url.href);
      if (requested.length > requestBudget) {
        throw new Error(
          `synthetic origin exceeded its ${requestBudget}-request redirect budget`,
        );
      }
      const route = routes[url.pathname];
      return route ? route() : new Response("not found", { status: 404 });
    },
    logger: () => {},
  });

  return { fetcher, requested, resolved };
}

test("egress transport surfaces upstream redirects instead of following them", async () => {
  const origin = createSyntheticOrigin({
    "/.well-known/stellar.toml": () => redirectTo(OFF_ORIGIN),
  });

  // Even a caller that asks to follow redirects cannot make the pinned
  // transport issue a second request.
  const response = await origin.fetcher(TOML_URL, { redirect: "follow" });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), OFF_ORIGIN);
  assert.deepEqual(origin.requested, [TOML_URL]);
  assert.deepEqual(origin.resolved, ["anchor.example"]);
});

test("redirect destinations that violate the protocol policy are rejected before DNS or socket work", async () => {
  const origin = createSyntheticOrigin();

  for (const destination of [
    "http://collector.example/evidence",
    "file:///etc/passwd",
    "https://127.0.0.1/evidence",
  ]) {
    await assert.rejects(
      origin.fetcher(destination),
      (error) =>
        error instanceof EgressPolicyError && error.code === "UNSUPPORTED_RUNTIME",
      destination,
    );
  }

  assert.deepEqual(origin.resolved, []);
  assert.deepEqual(origin.requested, []);
});

test("redirect destinations that fail the address policy are never contacted", async () => {
  const origin = createSyntheticOrigin({
    "/evidence": () => new Response("internal evidence"),
  });

  await assert.rejects(
    origin.fetcher("https://metadata.internal/evidence"),
    (error) =>
      error instanceof EgressPolicyError && error.code === "DISALLOWED_ADDRESS",
  );
  await assert.rejects(
    origin.fetcher("https://unknown.example/evidence"),
    (error) => error instanceof EgressPolicyError && error.code === "DNS_FAILURE",
  );

  assert.deepEqual(origin.requested, []);
});

test("SEP-1 evidence discovery refuses the redirect without reaching its destination", async () => {
  const origin = createSyntheticOrigin({
    "/.well-known/stellar.toml": () => redirectTo(OFF_ORIGIN),
  });

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher: origin.fetcher }),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "HTTP_FAILURE" &&
      error.status === 302,
  );

  assert.deepEqual(origin.requested, [TOML_URL]);
  assert.deepEqual(origin.resolved, ["anchor.example"]);
});

test("SEP-1 evidence discovery runs the platform boundary in redirect-error mode", async () => {
  let redirectMode: RequestRedirect | undefined;

  const boundary = (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    redirectMode = init?.redirect;
    // The platform fetch rejects instead of returning the 3xx response.
    throw new TypeError("fetch failed: unexpected redirect");
  }) as typeof fetch;

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher: boundary }),
    (error) => error instanceof Sep1DiscoveryError && error.code === "NETWORK_FAILURE",
  );
  assert.equal(redirectMode, "error");
});

test("SEP-38 evidence fetches reject redirects to an unapproved destination", async () => {
  const origin = createSyntheticOrigin({
    "/info": () => redirectTo(OFF_ORIGIN),
  });

  await assert.rejects(
    getSep38Info(ORIGIN, { fetcher: origin.fetcher }),
    (error) =>
      error instanceof Sep38ClientError &&
      error.code === "REDIRECT" &&
      error.status === 302,
  );

  assert.deepEqual(origin.requested, [INFO_URL]);
  assert.deepEqual(origin.resolved, ["anchor.example"]);
});

test("self-referential redirect loops terminate at the first hop", async () => {
  const origin = createSyntheticOrigin(
    {
      "/.well-known/stellar.toml": () => redirectTo(TOML_URL),
      "/info": () => redirectTo(INFO_URL),
    },
    2,
  );

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher: origin.fetcher }),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "HTTP_FAILURE" &&
      error.status === 302,
  );
  await assert.rejects(
    getSep38Info(ORIGIN, { fetcher: origin.fetcher }),
    (error) => error instanceof Sep38ClientError && error.code === "REDIRECT",
  );

  assert.deepEqual(origin.requested, [TOML_URL, INFO_URL]);
  assert.deepEqual(origin.resolved, ["anchor.example", "anchor.example"]);
});

test("long redirect chains stop at the first hop", async () => {
  const hops = 32;
  const routes: Record<string, Route> = {
    "/.well-known/stellar.toml": () => redirectTo(`${ORIGIN}/hop/0`),
  };

  for (let index = 0; index < hops; index += 1) {
    routes[`/hop/${index}`] = () =>
      redirectTo(
        index + 1 === hops ? OFF_ORIGIN : `${ORIGIN}/hop/${index + 1}`,
      );
  }

  const origin = createSyntheticOrigin(routes, 2);

  await assert.rejects(
    fetchSep1Toml("anchor.example", { fetcher: origin.fetcher }),
    (error) =>
      error instanceof Sep1DiscoveryError &&
      error.code === "HTTP_FAILURE" &&
      error.status === 302,
  );

  assert.equal(origin.requested.length, 1);
  assert.deepEqual(origin.requested, [TOML_URL]);
  assert.deepEqual(origin.resolved, ["anchor.example"]);
});
