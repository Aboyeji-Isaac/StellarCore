export type StellarAuthProtocol = "sep10" | "sep45";

/**
 * A short-lived bearer token owned by the caller that requested it.
 *
 * StellarCore does not persist, cache, refresh, or revoke this value. The
 * caller is responsible for keeping it confidential and discarding it after
 * `expiresAt`.
 */
export type StellarAuthToken = Readonly<{
  token: string;
  protocol: StellarAuthProtocol;
  homeDomain: string;
  issuer: string;
  subject: string;
  issuedAt: string;
  expiresAt: string;
}>;

export interface StellarAuthProvider {
  getToken(): Promise<StellarAuthToken>;
}

export type StellarAuthTokenMetadata = Readonly<{
  protocol: StellarAuthProtocol;
  homeDomain: string;
  expectedSubject: string;
}>;

/**
 * Signing is intentionally caller-owned. Implementations may delegate to a
 * wallet, hardware signer, key-management service, or injected SDK keypair.
 */
export interface Sep10ChallengeSigner {
  signChallenge(input: Readonly<{
    account: string;
    transaction: string;
    networkPassphrase: string;
    clientDomain?: string;
    clientDomainSigningKey?: string;
  }>): Promise<string>;
}
