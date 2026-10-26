import assert from "node:assert/strict";
import test from "node:test";

import { Keypair, Networks, Transaction, WebAuth } from "@stellar/stellar-sdk";

import { parseStellarAuthToken, StellarAuthError } from "@/lib/stellar/auth";
import {
  requestSep10Token,
  Sep10AuthError,
  type Sep10AuthConfig,
} from "@/lib/stellar/sep10";
import type { Sep10ChallengeSigner } from "@/types/stellarAuth";

const HOME_DOMAIN = "anchor.example";
const WEB_AUTH_DOMAIN = "auth.anchor.example";
const AUTH_ENDPOINT = `https://${WEB_AUTH_DOMAIN}/sep10/auth`;
const CLIENT_DOMAIN = "wallet.example";

type Fixture = ReturnType<typeof createFixture>;

function createFixture(withClientDomain = false) {
  const server = Keypair.random();
  const client = Keypair.random();
  const clientDomainKey = Keypair.random();
  const now = new Date();
  const build = () =>
    WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      HOME_DOMAIN,
      300,
      Networks.TESTNET,
      WEB_AUTH_DOMAIN,
      null,
      withClientDomain ? CLIENT_DOMAIN : null,
      withClientDomain ? clientDomainKey.publicKey() : null,
    );
  const config: Sep10AuthConfig = {
    homeDomain: HOME_DOMAIN,
    webAuthEndpoint: AUTH_ENDPOINT,
    serverSigningKey: server.publicKey(),
    networkPassphrase: Networks.TESTNET,
    account: client.publicKey(),
    ...(withClientDomain
      ? {
          clientDomain: CLIENT_DOMAIN,
          clientDomainSigningKey: clientDomainKey.publicKey(),
        }
      : {}),
  };
  return { server, client, clientDomainKey, now, build, config, challenge: build() };
}

function signWith(xdr: string, ...keys: Keypair[]): string {
  const tx = new Transaction(xdr, Networks.TESTNET);
  for (const key of keys) tx.sign(key);
  return tx.toXdr();
}

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.not-verified`;
}

function tokenClaims(f: Fixture, extra: Record<string, unknown> = {}) {
  const seconds = Math.floor(f.now.getTime() / 1_000);
  return {
    iss: `https://${WEB_AUTH_DOMAIN}`,
    sub: f.client.publicKey(),
    iat: seconds - 30,
    exp: seconds + 300,
    ...extra,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function exchange(
  f: Fixture,
  sign: (transaction: string) => string,
  claims: Record<string, unknown> = tokenClaims(f),
) {
  const state = { posts: 0, posted: "" };
  const signer: Sep10ChallengeSigner = {
    signChallenge: async ({ transaction }) => sign(transaction),
  };
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    if (!init?.method) {
      return jsonResponse({
        transaction: f.challenge,
        network_passphrase: Networks.TESTNET,
      });
    }
    state.posts += 1;
    state.posted = (JSON.parse(String(init.body)) as { transaction: string })
      .transaction;
    return jsonResponse({ token: jwt(claims) });
  }) as typeof fetch;

  return {
    state,
    result: requestSep10Token(f.config, { signer, fetcher, now: () => f.now }),
  };
}

const isSigningFailure = (error: unknown) =>
  error instanceof Sep10AuthError && error.code === "SIGNING_FAILURE";

const isClientDomainFailure = (error: unknown) =>
  error instanceof StellarAuthError && error.code === "INVALID_CLIENT_DOMAIN";

test("original challenge with added signatures passes and is the body posted", async () => {
  const f = createFixture();
  const extraSigner = Keypair.random();
  const { state, result } = exchange(f, (tx) =>
    signWith(tx, f.client, extraSigner),
  );

  const token = await result;

  assert.equal(token.subject, f.client.publicKey());
  assert.equal(state.posts, 1);
  assert.notEqual(state.posted, f.challenge);
  const posted = new Transaction(state.posted, Networks.TESTNET);
  const original = new Transaction(f.challenge, Networks.TESTNET);
  assert.deepEqual(posted.hash(), original.hash());
  assert.equal(posted.signatures.length, 3);
});

test("a different server-signed challenge for the same account/domain is rejected with zero POSTs", async () => {
  const f = createFixture();
  const other = f.build();
  const { state, result } = exchange(f, () => signWith(other, f.client));

  await assert.rejects(result, isSigningFailure);
  assert.equal(state.posts, 0);
});

test("a signer result without the original server signature is rejected with zero POSTs", async () => {
  const f = createFixture();
  const { state, result } = exchange(f, (tx) => {
    const stripped = new Transaction(tx, Networks.TESTNET);
    stripped.signatures.splice(0);
    stripped.sign(f.client);
    return stripped.toXdr();
  });

  await assert.rejects(result, isSigningFailure);
  assert.equal(state.posts, 0);
});

test("a signer result that is not a transaction is rejected with zero POSTs", async () => {
  const f = createFixture();
  const { state, result } = exchange(f, () => "not-xdr");

  await assert.rejects(result, isSigningFailure);
  assert.equal(state.posts, 0);
});

test("requested client_domain passes only with a present, well-formed, matching claim", async () => {
  const f = createFixture(true);
  const sign = (tx: string) => signWith(tx, f.client, f.clientDomainKey);

  const token = await exchange(
    f,
    sign,
    tokenClaims(f, { client_domain: CLIENT_DOMAIN }),
  ).result;
  assert.equal(token.subject, f.client.publicKey());

  for (const claims of [
    tokenClaims(f),
    tokenClaims(f, { client_domain: 42 }),
    tokenClaims(f, { client_domain: "" }),
    tokenClaims(f, { client_domain: "other.example" }),
    tokenClaims(f, { client_domain: "not a domain" }),
    tokenClaims(f, { client_domain: "x".repeat(400) }),
  ]) {
    await assert.rejects(exchange(f, sign, claims).result, isClientDomainFailure);
  }
});

test("without a requested client domain the claim is not required or inspected", async () => {
  const f = createFixture();
  const sign = (tx: string) => signWith(tx, f.client);

  await exchange(f, sign).result;
  await exchange(f, sign, tokenClaims(f, { client_domain: "whatever.example" }))
    .result;
});

test("claim checks are not JWT verification: a token with an unverifiable signature part is still parsed", () => {
  const f = createFixture(true);
  const parsed = parseStellarAuthToken(
    jwt(tokenClaims(f, { client_domain: CLIENT_DOMAIN })),
    {
      protocol: "sep10",
      homeDomain: HOME_DOMAIN,
      expectedSubject: f.client.publicKey(),
    },
    { now: f.now, expectedClientDomain: CLIENT_DOMAIN },
  );
  assert.equal(parsed.subject, f.client.publicKey());
});

test("generic SEP-45 token parsing stays compatible when no client domain is expected", () => {
  const f = createFixture();
  const parsed = parseStellarAuthToken(
    jwt(tokenClaims(f)),
    {
      protocol: "sep45",
      homeDomain: HOME_DOMAIN,
      expectedSubject: f.client.publicKey(),
    },
    { now: f.now },
  );
  assert.equal(parsed.protocol, "sep45");
});
