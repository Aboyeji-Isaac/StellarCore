import assert from "node:assert/strict";
import test from "node:test";

import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";

import { acquireStellarAuthToken } from "@/lib/stellar/auth";
import {
  buildSep10ChallengeUrl,
  createSep10AuthProvider,
  normalizeSep10AuthEndpoint,
  requestSep10Token,
  Sep10AuthError,
  type Sep10AuthConfig,
} from "@/lib/stellar/sep10";
import {
  getSep38Info,
  requestSep38FirmQuote,
} from "@/lib/stellar/sep38";
import type { Sep10ChallengeSigner } from "@/types/stellarAuth";

const AUTH_ENDPOINT = "https://auth.anchor.example/sep10/auth";
const QUOTE_SERVER = "https://quotes.anchor.example/sep38";

test("SEP-10 provider verifies, signs, exchanges, and returns a usable token", async () => {
  const fixture = createFixture();
  let signCount = 0;
  let challengeUrl = "";
  let postedTransaction = "";
  const signer = signingWith(fixture.client, () => {
    signCount += 1;
  });
  const provider = createSep10AuthProvider(fixture.config, {
    signer,
    now: () => fixture.now,
    fetcher: (async (input, init) => {
      if (!init?.method) {
        challengeUrl = String(input);
        return jsonResponse({
          transaction: fixture.challenge,
          network_passphrase: Networks.TESTNET,
        });
      }

      postedTransaction = String(
        (JSON.parse(String(init.body)) as { transaction: string }).transaction,
      );
      return jsonResponse({ token: fixture.token });
    }) as typeof fetch,
  });

  const token = await acquireStellarAuthToken(provider, { now: fixture.now });

  assert.equal(signCount, 1);
  assert.equal(token.protocol, "sep10");
  assert.equal(token.subject, fixture.client.publicKey());
  assert.equal(Object.isFrozen(token), true);
  assert.notEqual(postedTransaction, fixture.challenge);
  const query = new URL(challengeUrl).searchParams;
  assert.equal(query.get("account"), fixture.client.publicKey());
  assert.equal(query.get("home_domain"), "anchor.example");
});

test("provider-produced authentication integrates with SEP-38 while public calls remain unauthenticated", async () => {
  const fixture = createFixture();
  const provider = createSep10AuthProvider(fixture.config, {
    signer: signingWith(fixture.client),
    now: () => fixture.now,
    fetcher: sep10Fetcher(fixture),
  });
  const authentication = await provider.getToken();
  let firmAuthorization: string | null = null;

  await requestSep38FirmQuote(
    QUOTE_SERVER,
    {
      sellAsset: "stellar:native",
      buyAsset: "iso4217:USD",
      sellAmount: "1",
      context: "sep31",
    },
    authentication,
    {
      fetcher: (async (_input, init) => {
        firmAuthorization = new Headers(init?.headers).get("authorization");
        return jsonResponse(firmQuoteResponse(), 201);
      }) as typeof fetch,
    },
  );
  assert.equal(firmAuthorization, `Bearer ${fixture.token}`);

  let publicAuthorization: string | null = "unexpected";
  await getSep38Info(QUOTE_SERVER, {
    fetcher: (async (_input, init) => {
      publicAuthorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({ assets: [] });
    }) as typeof fetch,
  });
  assert.equal(publicAuthorization, null);
});

test("SEP-10 endpoint and request validation rejects unsafe inputs", () => {
  for (const endpoint of [
    "http://auth.anchor.example/auth",
    "https://localhost/auth",
    "https://127.0.0.1/auth",
    "https://user:secret@auth.anchor.example/auth",
    "https://auth.anchor.example:8443/auth",
    "https://auth.anchor.example/auth?token=secret",
  ]) {
    assert.throws(
      () => normalizeSep10AuthEndpoint(endpoint),
      (error) =>
        error instanceof Sep10AuthError &&
        error.code === "INVALID_ENDPOINT" &&
        !error.message.includes("secret") &&
        !error.endpoint.includes("secret"),
    );
  }

  const fixture = createFixture();
  assert.throws(
    () =>
      buildSep10ChallengeUrl({
        ...fixture.config,
        memo: "18446744073709551616",
      }),
    hasSep10Code("INVALID_CONFIGURATION"),
  );

  assert.throws(
    () =>
      buildSep10ChallengeUrl({
        ...fixture.config,
        clientDomain: "wallet.example",
      }),
    hasSep10Code("INVALID_CONFIGURATION"),
  );

});

test("malformed and identity-mismatched challenges are rejected before signing", async () => {
  const fixture = createFixture();
  const wrongServer = Keypair.random();
  const invalidChallenges = [
    "not-xdr",
    WebAuth.buildChallengeTx(
      fixture.server,
      fixture.client.publicKey(),
      "anchor.example",
      300,
      Networks.TESTNET,
      "wrong-auth.example",
    ),
    WebAuth.buildChallengeTx(
      fixture.server,
      Keypair.random().publicKey(),
      "anchor.example",
      300,
      Networks.TESTNET,
      "auth.anchor.example",
    ),
    challengeWithoutWebAuthDomain(fixture),
    WebAuth.buildChallengeTx(
      fixture.server,
      fixture.client.publicKey(),
      "wrong.example",
      300,
      Networks.TESTNET,
      "auth.anchor.example",
    ),
    WebAuth.buildChallengeTx(
      wrongServer,
      fixture.client.publicKey(),
      "anchor.example",
      300,
      Networks.TESTNET,
      "auth.anchor.example",
    ),
    WebAuth.buildChallengeTx(
      fixture.server,
      fixture.client.publicKey(),
      "anchor.example",
      300,
      Networks.TESTNET,
      "auth.anchor.example",
      null,
      "wallet.example",
      Keypair.random().publicKey(),
    ),
  ];

  for (const transaction of invalidChallenges) {
    let signed = false;
    await assert.rejects(
      requestSep10Token(fixture.config, {
        signer: {
          signChallenge: async () => {
            signed = true;
            return transaction;
          },
        },
        now: () => fixture.now,
        fetcher: async () => jsonResponse({ transaction }),
      }),
      hasSep10Code("INVALID_CHALLENGE"),
    );
    assert.equal(signed, false);
  }
});

test("network boundary rejects redirects, oversized responses, and timeouts", async () => {
  const fixture = createFixture();
  const signer = signingWith(fixture.client);

  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer,
      fetcher: async () =>
        new Response("{}", {
          headers: { "content-type": "text/plain" },
        }),
    }),
    hasSep10Code("INVALID_CONTENT_TYPE"),
  );

  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer,
      fetcher: async () =>
        new Response("not-json", {
          headers: { "content-type": "application/json" },
        }),
    }),
    hasSep10Code("INVALID_JSON"),
  );

  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer,
      fetcher: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example/auth" },
        }),
    }),
    hasSep10Code("REDIRECT"),
  );

  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer,
      fetcher: async () =>
        new Response(`{"padding":"${"x".repeat(100_001)}"}`, {
          headers: { "content-type": "application/json" },
        }),
    }),
    hasSep10Code("RESPONSE_TOO_LARGE"),
  );

  const slowFetcher = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer,
      fetcher: slowFetcher,
      timeoutMs: 5,
    }),
    hasSep10Code("TIMEOUT"),
  );
});

test("signing and token-exchange failures are typed and redact sensitive data", async () => {
  const fixture = createFixture();
  const sensitive = "private.bearer.material";

  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer: {
        signChallenge: async () => {
          throw new Error(sensitive);
        },
      },
      fetcher: async () => jsonResponse({ transaction: fixture.challenge }),
    }),
    (error) =>
      error instanceof Sep10AuthError &&
      error.code === "SIGNING_FAILURE" &&
      !error.message.includes(sensitive) &&
      !("cause" in error),
  );

  let calls = 0;
  await assert.rejects(
    requestSep10Token(fixture.config, {
      signer: signingWith(fixture.client),
      fetcher: async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ transaction: fixture.challenge })
          : jsonResponse({ error: sensitive }, 403);
      },
    }),
    (error) =>
      error instanceof Sep10AuthError &&
      error.code === "HTTP_FAILURE" &&
      !error.message.includes(sensitive) &&
      !error.endpoint.includes(sensitive),
  );
});

test("token exchange rejects wrong subjects and expired JWTs", async () => {
  const fixture = createFixture();

  for (const token of [
    makeJwt(fixture.now, Keypair.random().publicKey()),
    makeJwt(fixture.now, fixture.client.publicKey(), -1),
  ]) {
    await assert.rejects(
      requestSep10Token(fixture.config, {
        signer: signingWith(fixture.client),
        now: () => fixture.now,
        fetcher: sep10Fetcher({ ...fixture, token }),
      }),
      (error) =>
        error instanceof Error &&
        ("code" in error) &&
        (error.code === "INVALID_TOKEN" || error.code === "TOKEN_EXPIRED"),
    );
  }
});

function challengeWithoutWebAuthDomain(fixture: Readonly<{
  server: Keypair;
  client: Keypair;
  config: Sep10AuthConfig;
}>): string {
  const now = Math.floor(Date.now() / 1_000);
  const transaction = new TransactionBuilder(
    new Account(fixture.server.publicKey(), "-1"),
    {
      fee: BASE_FEE,
      networkPassphrase: fixture.config.networkPassphrase,
      timebounds: { minTime: now, maxTime: now + 300 },
    },
  )
    .addOperation(
      Operation.manageData({
        name: `${fixture.config.homeDomain} auth`,
        value: Buffer.alloc(48, 1).toString("base64"),
        source: fixture.client.publicKey(),
      }),
    )
    .build();

  transaction.sign(fixture.server);
  return transaction.toXdr();
}

function createFixture() {
  const now = new Date();
  const server = Keypair.random();
  const client = Keypair.random();
  const config = Object.freeze({
    homeDomain: "anchor.example",
    webAuthEndpoint: AUTH_ENDPOINT,
    serverSigningKey: server.publicKey(),
    networkPassphrase: Networks.TESTNET,
    account: client.publicKey(),
  }) satisfies Sep10AuthConfig;
  const challenge = WebAuth.buildChallengeTx(
    server,
    client.publicKey(),
    config.homeDomain,
    300,
    config.networkPassphrase,
    "auth.anchor.example",
  );
  const token = makeJwt(now, client.publicKey());

  return { now, server, client, config, challenge, token };
}

function signingWith(
  keypair: Keypair,
  beforeSign: () => void = () => undefined,
): Sep10ChallengeSigner {
  return {
    signChallenge: async (input) => {
      beforeSign();
      const transaction = TransactionBuilder.fromXdr(
        input.transaction,
        input.networkPassphrase,
      );
      assert.equal(transaction instanceof Transaction, true);
      transaction.sign(keypair);
      return transaction.toXdr();
    },
  };
}

function sep10Fetcher(fixture: {
  challenge: string;
  token: string;
}): typeof fetch {
  return (async (_input, init) =>
    init?.method
      ? jsonResponse({ token: fixture.token })
      : jsonResponse({ transaction: fixture.challenge })) as typeof fetch;
}

function makeJwt(now: Date, subject: string, lifetimeSeconds = 300): string {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 1;
  const header = Buffer.from(JSON.stringify({ alg: "test" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://auth.anchor.example",
      sub: subject,
      iat: issuedAt,
      exp: issuedAt + lifetimeSeconds,
    }),
  ).toString("base64url");
  return `${header}.${payload}.synthetic-signature`;
}

function firmQuoteResponse(): Record<string, unknown> {
  return {
    id: "quote-reference",
    expires_at: "2026-08-21T12:05:00Z",
    total_price: "1",
    price: "1",
    sell_asset: "stellar:native",
    sell_amount: "1",
    buy_asset: "iso4217:USD",
    buy_amount: "1",
    fee: { total: "0", asset: "iso4217:USD", details: [] },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hasSep10Code(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Sep10AuthError && error.code === code;
}
