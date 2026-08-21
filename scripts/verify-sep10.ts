import { pathToFileURL } from "node:url";

import {
  Keypair,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import {
  acquireStellarAuthToken,
  StellarAuthError,
} from "@/lib/stellar/auth";
import {
  fetchSep1Toml,
  Sep1DiscoveryError,
} from "@/lib/stellar/sep1";
import {
  createSep10AuthProvider,
  Sep10AuthError,
} from "@/lib/stellar/sep10";
import type { StellarAuthToken } from "@/types/stellarAuth";

const REFERENCE_HOME_DOMAIN = "testanchor.stellar.org";

type VerificationPhase =
  | "sep1-discovery"
  | "sep10-configuration"
  | "sep10-authentication"
  | "complete";

type Sep10VerificationResult =
  | Readonly<{
      success: true;
      phase: "complete";
      homeDomain: string;
      networkPassphrase: string;
      webAuthEndpoint: string;
      serverSigningKey: string;
      sep38Endpoint?: string;
      account: string;
      authProtocol: "sep10";
      issuer: string;
      issuedAt: string;
      expiresAt: string;
    }>
  | Readonly<{
      success: false;
      phase: Exclude<VerificationPhase, "complete">;
      homeDomain: string;
      code: string;
      account?: string;
    }>;

export async function verifyReferenceSep10(
  fetcher: typeof fetch = fetch,
): Promise<Sep10VerificationResult> {
  let phase: Exclude<VerificationPhase, "complete"> = "sep1-discovery";
  let keypair: Keypair | undefined;
  let token: StellarAuthToken | undefined;
  let account: string | undefined;

  try {
    const { data } = await fetchSep1Toml(REFERENCE_HOME_DOMAIN, { fetcher });
    phase = "sep10-configuration";

    const webAuthEndpoint = data.endpoints.webAuthEndpoint;
    const serverSigningKey = data.signingKey;
    if (
      data.networkPassphrase !== Networks.TESTNET ||
      !webAuthEndpoint ||
      !serverSigningKey
    ) {
      return failureResult(phase, "UNSAFE_REFERENCE_CONFIGURATION");
    }

    keypair = Keypair.random();
    account = keypair.publicKey();
    const provider = createSep10AuthProvider(
      {
        homeDomain: REFERENCE_HOME_DOMAIN,
        webAuthEndpoint,
        serverSigningKey,
        networkPassphrase: data.networkPassphrase,
        account,
      },
      {
        fetcher,
        signer: {
          signChallenge: async (input) => {
            if (!keypair || input.account !== account) {
              throw new Error("Ephemeral signer is unavailable");
            }
            const transaction = TransactionBuilder.fromXdr(
              input.transaction,
              input.networkPassphrase,
            );
            transaction.sign(keypair);
            return transaction.toXdr();
          },
        },
      },
    );

    phase = "sep10-authentication";
    token = await acquireStellarAuthToken(provider);

    return Object.freeze({
      success: true,
      phase: "complete",
      homeDomain: REFERENCE_HOME_DOMAIN,
      networkPassphrase: data.networkPassphrase,
      webAuthEndpoint,
      serverSigningKey,
      ...(data.endpoints.anchorQuoteServer
        ? { sep38Endpoint: data.endpoints.anchorQuoteServer }
        : {}),
      account,
      authProtocol: "sep10",
      issuer: token.issuer,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
    });
  } catch (error) {
    return failureResult(phase, safeErrorCode(error), account);
  } finally {
    token = undefined;
    keypair = undefined;
  }
}

function failureResult(
  phase: Exclude<VerificationPhase, "complete">,
  code: string,
  account?: string,
): Sep10VerificationResult {
  return Object.freeze({
    success: false,
    phase,
    homeDomain: REFERENCE_HOME_DOMAIN,
    code,
    ...(account ? { account } : {}),
  });
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof Sep1DiscoveryError ||
    error instanceof Sep10AuthError ||
    error instanceof StellarAuthError
  ) {
    return error.code;
  }
  return "UNEXPECTED_FAILURE";
}

async function main(): Promise<void> {
  const result = await verifyReferenceSep10();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.success) process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
