import { createHash } from "node:crypto";
import type { AnchorRegistryEntry } from "@/types/anchor";

const PROOF_VERSION = 1 as const;
const DEFAULT_EXPIRY_DAYS = 30;

export type DomainControlProof = Readonly<{
  version: typeof PROOF_VERSION;
  homeDomain: string;
  changeHash: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}>;

export type DomainControlVerificationResult = Readonly<{
  ok: boolean;
  proofId: string;
  verifiedAt: string;
  error?: string;
}>;

export type Clock = Readonly<{
  now: () => Date;
}>;

export type VerificationDependencies = Readonly<{
  clock: Clock;
  isNonceUsed: (nonce: string) => Promise<boolean>;
  markNonceUsed: (nonce: string) => Promise<void>;
}>;

function canonicalizeEntry(entry: AnchorRegistryEntry): string {
  return JSON.stringify(
    Object.freeze({
      slug: entry.slug,
      name: entry.name,
      homeDomain: entry.homeDomain,
    }),
  );
}

export function hashCanonicalEntry(entry: AnchorRegistryEntry): string {
  return createHash("sha256").update(canonicalizeEntry(entry)).digest("hex");
}

function hashProofData(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function createProofId(proof: DomainControlProof): string {
  return hashProofData(
    `${proof.homeDomain}|${proof.changeHash}|${proof.nonce}|${proof.issuedAt}`,
  );
}

export function generateChallenge(entry: AnchorRegistryEntry): string {
  const changeHash = hashCanonicalEntry(entry);
  return `stellarcore-domain-control:v1|${entry.homeDomain}|${changeHash}`;
}

export function createProof(
  entry: AnchorRegistryEntry,
  clock: Clock,
  expiryDays = DEFAULT_EXPIRY_DAYS,
): DomainControlProof {
  const now = clock.now();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
  const nonce = createHash("sha256")
    .update(`${entry.homeDomain}|${now.getTime()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 32);

  const changeHash = hashCanonicalEntry(entry);
  const dataToSign = `${PROOF_VERSION}|${entry.homeDomain}|${changeHash}|${issuedAt}|${expiresAt}|${nonce}`;
  const signature = hashProofData(dataToSign);

  return Object.freeze({
    version: PROOF_VERSION,
    homeDomain: entry.homeDomain,
    changeHash,
    issuedAt,
    expiresAt,
    nonce,
    signature,
  });
}

export function verifyProof(
  proof: DomainControlProof,
  entry: AnchorRegistryEntry,
  dependencies: VerificationDependencies,
): DomainControlVerificationResult {
  const verifiedAt = dependencies.clock.now().toISOString();
  const proofId = createProofId(proof);

  if (proof.version !== PROOF_VERSION) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: `Unsupported proof version: ${proof.version}`,
    });
  }

  if (proof.homeDomain !== entry.homeDomain) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: `Proof homeDomain "${proof.homeDomain}" does not match entry homeDomain "${entry.homeDomain}"`,
    });
  }

  const expectedChangeHash = hashCanonicalEntry(entry);
  if (proof.changeHash !== expectedChangeHash) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: "Proof changeHash does not match the proposed registry entry",
    });
  }

  const now = dependencies.clock.now();
  const issuedAt = new Date(proof.issuedAt);
  const expiresAt = new Date(proof.expiresAt);

  if (Number.isNaN(issuedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: "Invalid timestamp format in proof",
    });
  }

  if (issuedAt > now) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: "Proof issued in the future",
    });
  }

  if (expiresAt <= now) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: "Proof has expired",
    });
  }

  const expectedSignature = hashProofData(
    `${proof.version}|${proof.homeDomain}|${proof.changeHash}|${proof.issuedAt}|${proof.expiresAt}|${proof.nonce}`,
  );

  if (proof.signature !== expectedSignature) {
    return Object.freeze({
      ok: false,
      proofId,
      verifiedAt,
      error: "Invalid proof signature",
    });
  }

  return Object.freeze({
    ok: true,
    proofId,
    verifiedAt,
  });
}

export async function verifyProofAsync(
  proof: DomainControlProof,
  entry: AnchorRegistryEntry,
  dependencies: VerificationDependencies,
): Promise<DomainControlVerificationResult> {
  const result = verifyProof(proof, entry, dependencies);

  if (!result.ok) {
    return result;
  }

  const nonceUsed = await dependencies.isNonceUsed(result.proofId);
  if (nonceUsed) {
    return Object.freeze({
      ok: false,
      proofId: result.proofId,
      verifiedAt: dependencies.clock.now().toISOString(),
      error: "Proof has already been used (replay detected)",
    });
  }

  await dependencies.markNonceUsed(result.proofId);

  return Object.freeze({
    ...result,
    verifiedAt: dependencies.clock.now().toISOString(),
  });
}