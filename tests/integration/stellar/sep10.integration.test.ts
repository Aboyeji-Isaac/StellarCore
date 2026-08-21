import assert from "node:assert/strict";
import test from "node:test";

import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";

import { acquireStellarAuthToken } from "@/lib/stellar/auth";
import { fetchSep1Toml } from "@/lib/stellar/sep1";
import {
  createSep10AuthProvider,
  Sep10AuthError,
  type Sep10AuthConfig,
} from "@/lib/stellar/sep10";
import {
  requestSep38FirmQuote,
  Sep38ClientError,
} from "@/lib/stellar/sep38";
import type { StellarAuthProvider } from "@/types/stellarAuth";

const HOME_DOMAIN = "reference.test";
const AUTH_ENDPOINT = "https://auth.reference.test/auth";
const QUOTE_SERVER = "https://quotes.reference.test/sep38";

type ControlledOptions = Readonly<{
  authEndpoint?: string;
  challengeHomeDomain?: string;
  challengeNetworkPassphrase?: string;
  challengeTimeout?: boolean;
  expiredChallenge?: boolean;
  metadataSigningKey?: string;
  signerRejects?: boolean;
  tokenMode?: "valid" | "expired" | "mismatched" | "malformed-response";
  tokenStatus?: number;
}>;

test("offline flow composes SEP-1, SEP-10, auth, and SEP-38", async () => {
  const harness = await createControlledHarness();
  const authentication = await acquireStellarAuthToken(harness.provider, {
    now: harness.now,
  });

  assert.equal(authentication.protocol, "sep10");
  assert.equal(authentication.subject, harness.account);
  assert.equal(Object.isFrozen(authentication), true);

  const quote = await requestSep38FirmQuote(
    harness.quoteServer,
    firmQuoteRequest(),
    authentication,
    { fetcher: harness.fetcher },
  );

  assert.equal(quote.id, "controlled-quote");
  assert.equal(harness.state.authorization?.startsWith("Bearer "), true);
  assert.equal(
    harness.state.authorization?.slice("Bearer ".length) ===
      authentication.token,
    true,
  );

  harness.state.quoteFailure = true;
  harness.state.sensitiveToken = authentication.token;
  let quoteError: unknown;
  try {
    await requestSep38FirmQuote(
      harness.quoteServer,
      firmQuoteRequest(),
      authentication,
      { fetcher: harness.fetcher },
    );
  } catch (error) {
    quoteError = error;
  }

  assert.equal(quoteError instanceof Sep38ClientError, true);
  assert.equal(
    JSON.stringify(quoteError).includes(authentication.token),
    false,
  );
});

test("discovered trust metadata rejects wrong-key, domain, network, and expired challenges", async () => {
  const wrongSigningKey = Keypair.random().publicKey();
  const cases: readonly ControlledOptions[] = [
    { metadataSigningKey: wrongSigningKey },
    { challengeHomeDomain: "wrong.reference.test" },
    { challengeNetworkPassphrase: Networks.PUBLIC },
    { expiredChallenge: true },
  ];

  for (const options of cases) {
    const harness = await createControlledHarness(options);
    await assert.rejects(
      harness.provider.getToken(),
      hasCode("INVALID_CHALLENGE"),
    );
    assert.equal(harness.state.signerCalls, 0);
  }
});

test("signer rejection is normalized without exposing signer details", async () => {
  const harness = await createControlledHarness({ signerRejects: true });
  let caught: unknown;

  try {
    await harness.provider.getToken();
  } catch (error) {
    caught = error;
  }

  assert.equal(
    caught instanceof Sep10AuthError && caught.code === "SIGNING_FAILURE",
    true,
  );
  assert.equal(JSON.stringify(caught).includes("signer-only-detail"), false);
  assert.equal(harness.state.signerCalls, 1);
});

test("token exchange integration rejects malformed, expired, mismatched, and non-2xx responses", async () => {
  const cases = [
    { options: { tokenMode: "malformed-response" }, code: "INVALID_CHALLENGE" },
    { options: { tokenMode: "expired" }, code: "TOKEN_EXPIRED" },
    { options: { tokenMode: "mismatched" }, code: "INVALID_TOKEN" },
    { options: { tokenStatus: 403 }, code: "HTTP_FAILURE" },
  ] as const;

  for (const { options, code } of cases) {
    const harness = await createControlledHarness(options);
    await assert.rejects(harness.provider.getToken(), hasCode(code));
  }
});

test("unsafe discovered endpoints and challenge timeouts fail at their boundaries", async () => {
  await assert.rejects(
    createControlledHarness({ authEndpoint: "https://localhost/auth" }),
    hasCode("INVALID_ENDPOINT"),
  );

  const timeoutHarness = await createControlledHarness({
    challengeTimeout: true,
  });
  await assert.rejects(
    timeoutHarness.provider.getToken(),
    hasCode("TIMEOUT"),
  );
  assert.equal(timeoutHarness.state.signerCalls, 0);
});

async function createControlledHarness(options: ControlledOptions = {}) {
  const now = new Date();
  const server = Keypair.random();
  const client = Keypair.random();
  const account = client.publicKey();
  const authEndpoint = options.authEndpoint ?? AUTH_ENDPOINT;
  const metadataSigningKey = options.metadataSigningKey ?? server.publicKey();
  const challengeNetwork =
    options.challengeNetworkPassphrase ?? Networks.TESTNET;
  const challenge = options.expiredChallenge
    ? buildExpiredChallenge(server, client)
    : WebAuth.buildChallengeTx(
        server,
        account,
        options.challengeHomeDomain ?? HOME_DOMAIN,
        300,
        challengeNetwork,
        "auth.reference.test",
      );
  const tokenSubject =
    options.tokenMode === "mismatched"
      ? Keypair.random().publicKey()
      : account;
  const token = makeJwt(
    now,
    tokenSubject,
    options.tokenMode === "expired" ? -1 : 300,
  );
  const state: {
    authorization?: string;
    quoteFailure: boolean;
    sensitiveToken?: string;
    signerCalls: number;
  } = {
    quoteFailure: false,
    signerCalls: 0,
  };

  const fetcher = createControlledFetcher({
    authEndpoint,
    challenge,
    challengeTimeout: options.challengeTimeout ?? false,
    metadataSigningKey,
    state,
    token,
    tokenMode: options.tokenMode ?? "valid",
    tokenStatus: options.tokenStatus,
  });
  const { data } = await fetchSep1Toml(HOME_DOMAIN, { fetcher });
  const webAuthEndpoint = data.endpoints.webAuthEndpoint;
  const serverSigningKey = data.signingKey;
  const quoteServer = data.endpoints.anchorQuoteServer;
  if (!webAuthEndpoint || !serverSigningKey || !quoteServer) {
    throw new Error("Controlled SEP-1 metadata is incomplete");
  }

  const config = Object.freeze({
    homeDomain: HOME_DOMAIN,
    webAuthEndpoint,
    serverSigningKey,
    networkPassphrase: data.networkPassphrase,
    account,
  }) satisfies Sep10AuthConfig;
  const provider: StellarAuthProvider = createSep10AuthProvider(config, {
    fetcher,
    timeoutMs: options.challengeTimeout ? 5 : 1_000,
    now: () => now,
    signer: {
      signChallenge: async (input) => {
        state.signerCalls += 1;
        if (options.signerRejects) {
          throw new Error("signer-only-detail");
        }
        const transaction = TransactionBuilder.fromXdr(
          input.transaction,
          input.networkPassphrase,
        );
        transaction.sign(client);
        return transaction.toXdr();
      },
    },
  });

  return { account, fetcher, now, provider, quoteServer, state };
}

function createControlledFetcher(input: Readonly<{
  authEndpoint: string;
  challenge: string;
  challengeTimeout: boolean;
  metadataSigningKey: string;
  state: {
    authorization?: string;
    quoteFailure: boolean;
    sensitiveToken?: string;
    signerCalls: number;
  };
  token: string;
  tokenMode: NonNullable<ControlledOptions["tokenMode"]>;
  tokenStatus?: number;
}>): typeof fetch {
  return (async (request, init) => {
    const url = new URL(String(request));

    if (url.pathname === "/.well-known/stellar.toml") {
      return new Response(
        controlledToml(input.authEndpoint, input.metadataSigningKey),
        { headers: { "content-type": "text/plain" } },
      );
    }

    if (url.pathname === "/auth" && init?.method !== "POST") {
      if (input.challengeTimeout) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        });
      }
      return jsonResponse({
        transaction: input.challenge,
        network_passphrase: Networks.TESTNET,
      });
    }

    if (url.pathname === "/auth" && init?.method === "POST") {
      if (input.tokenStatus !== undefined) {
        return jsonResponse({ error: "private-token-response" }, input.tokenStatus);
      }
      if (input.tokenMode === "malformed-response") {
        return jsonResponse({ unexpected: "missing token" });
      }
      return jsonResponse({ token: input.token });
    }

    if (url.pathname === "/sep38/quote") {
      input.state.authorization = new Headers(init?.headers).get(
        "authorization",
      ) ?? undefined;
      if (input.state.quoteFailure) {
        return jsonResponse(
          { error: input.state.sensitiveToken },
          403,
        );
      }
      return jsonResponse(firmQuoteResponse(), 201);
    }

    throw new Error("Unexpected controlled integration URL");
  }) as typeof fetch;
}

function controlledToml(authEndpoint: string, signingKey: string): string {
  return `
NETWORK_PASSPHRASE = "${Networks.TESTNET}"
WEB_AUTH_ENDPOINT = "${authEndpoint}"
SIGNING_KEY = "${signingKey}"
ANCHOR_QUOTE_SERVER = "${QUOTE_SERVER}"

[DOCUMENTATION]
ORG_NAME = "Controlled Reference Anchor"
`;
}

function buildExpiredChallenge(server: Keypair, client: Keypair): string {
  const now = Math.floor(Date.now() / 1_000);
  const transaction = new TransactionBuilder(
    new Account(server.publicKey(), "-1"),
    {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
      timebounds: { minTime: now - 1_200, maxTime: now - 601 },
    },
  )
    .addOperation(
      Operation.manageData({
        name: `${HOME_DOMAIN} auth`,
        value: Buffer.alloc(48, 1).toString("base64"),
        source: client.publicKey(),
      }),
    )
    .addOperation(
      Operation.manageData({
        name: "web_auth_domain",
        value: "auth.reference.test",
        source: server.publicKey(),
      }),
    )
    .build();

  transaction.sign(server);
  return transaction.toXdr();
}

function makeJwt(now: Date, subject: string, lifetimeSeconds: number): string {
  const current = Math.floor(now.getTime() / 1_000);
  const issuedAt = lifetimeSeconds < 0 ? current - 600 : current - 1;
  const expiresAt =
    lifetimeSeconds < 0 ? current - 1 : issuedAt + lifetimeSeconds;
  const header = Buffer.from(JSON.stringify({ alg: "test" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: AUTH_ENDPOINT,
      sub: subject,
      iat: issuedAt,
      exp: expiresAt,
    }),
  ).toString("base64url");
  return `${header}.${payload}.integration-signature`;
}

function firmQuoteRequest() {
  return {
    sellAsset: "stellar:native",
    buyAsset: "iso4217:USD",
    sellAmount: "1",
    context: "sep31",
  } as const;
}

function firmQuoteResponse(): Record<string, unknown> {
  return {
    id: "controlled-quote",
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code: unknown }).code === code;
}
