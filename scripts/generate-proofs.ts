import { createHash } from "node:crypto";

const PROOF_VERSION = 1;

function canonicalizeEntry(entry: { slug: string; name: string; homeDomain: string }): string {
  return JSON.stringify({ slug: entry.slug, name: entry.name, homeDomain: entry.homeDomain });
}

function hashCanonicalEntry(entry: { slug: string; name: string; homeDomain: string }): string {
  return createHash("sha256").update(canonicalizeEntry(entry)).digest("hex");
}

function hashProofData(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function createProof(
  entry: { slug: string; name: string; homeDomain: string },
  issuedAt: string,
  expiresAt: string,
  nonce: string,
): {
  version: number;
  homeDomain: string;
  changeHash: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
} {
  const changeHash = hashCanonicalEntry(entry);
  const dataToSign = `${PROOF_VERSION}|${entry.homeDomain}|${changeHash}|${issuedAt}|${expiresAt}|${nonce}`;
  const signature = hashProofData(dataToSign);

  return {
    version: PROOF_VERSION,
    homeDomain: entry.homeDomain,
    changeHash,
    issuedAt,
    expiresAt,
    nonce,
    signature,
  };
}

const entries = [
  { slug: "moneygram", name: "MoneyGram", homeDomain: "mgxanchor.moneygram.com" },
  { slug: "cowrie", name: "Cowrie", homeDomain: "cowrie.exchange" },
  { slug: "zeam", name: "Zeam", homeDomain: "zeam.money" },
];

const issuedAt = "2026-01-01T00:00:00.000Z";
const expiresAt = "2036-01-01T00:00:00.000Z";

for (const entry of entries) {
  const nonce = createHash("sha256")
    .update(`${entry.homeDomain}|${issuedAt}|${entry.slug}`)
    .digest("hex")
    .slice(0, 32);

  const proof = createProof(entry, issuedAt, expiresAt, nonce);
  
  console.log(`${entry.slug}: ${JSON.stringify(proof, null, 2)}`);
}