#!/usr/bin/env npx tsx

import { createProof } from "@/lib/stellar/domainControl";
import type { AnchorRegistryEntry } from "@/types/anchor";

function createFixedClock(fixedTime: Date) {
  return Object.freeze({
    now: () => new Date(fixedTime.getTime()),
  });
}

function printUsage() {
  console.log(`
Usage: npx tsx scripts/create-anchor-proof.ts <slug> <name> <homeDomain> [expiryDays]

Generates a domain control proof for an anchor registry entry.

Arguments:
  slug         Anchor slug (e.g., "newanchor")
  name         Anchor display name (e.g., "New Anchor")
  homeDomain   Anchor home domain (e.g., "anchor.example.com")
  expiryDays   Optional: proof validity in days (default: 30)

Example:
  npx tsx scripts/create-anchor-proof.ts newanchor "New Anchor" anchor.example.com 30
`);
  process.exit(1);
}

const [slug, name, homeDomain, expiryDaysStr] = process.argv.slice(2);

if (!slug || !name || !homeDomain) {
  printUsage();
}

const expiryDays = expiryDaysStr ? parseInt(expiryDaysStr, 10) : 30;

if (isNaN(expiryDays) || expiryDays <= 0) {
  console.error("Error: expiryDays must be a positive number");
  process.exit(1);
}

const entry: AnchorRegistryEntry = Object.freeze({
  slug,
  name,
  homeDomain,
});

const clock = createFixedClock(new Date());
const proof = createProof(entry, clock, expiryDays);

console.log("=== Domain Control Proof ===");
console.log("");
console.log(`Entry: ${JSON.stringify(entry, null, 2)}`);
console.log("");
console.log(`Proof:`);
console.log(JSON.stringify(proof, null, 2));
console.log("");
console.log("=== Add to constants/anchorProofs.ts ===");
console.log("");
console.log(`${slug}: Object.freeze({`);
console.log(`  version: ${proof.version},`);
console.log(`  homeDomain: "${proof.homeDomain}",`);
console.log(`  changeHash: "${proof.changeHash}",`);
console.log(`  issuedAt: "${proof.issuedAt}",`);
console.log(`  expiresAt: "${proof.expiresAt}",`);
console.log(`  nonce: "${proof.nonce}",`);
console.log(`  signature: "${proof.signature}",`);
console.log(`}),`);
console.log("");
console.log("=== Verification ===");
console.log("");
console.log(`Challenge: stellarcore-domain-control:v1|${homeDomain}|${proof.changeHash}`);
console.log("");
console.log("To verify, run:");
console.log(`npx tsx -e "`);
console.log(`import { verifyProof } from '@/lib/stellar/domainControl';`);
console.log(`const entry = ${JSON.stringify(entry)};`);
console.log(`const proof = ${JSON.stringify(proof)};`);
console.log(`const result = verifyProof(proof, entry, {`);
console.log(`  clock: { now: () => new Date() },`);
console.log(`  isNonceUsed: async () => false,`);
console.log(`  markNonceUsed: async () => {},`);
console.log(`});`);
console.log(`console.log('Valid:', result.ok);`);
console.log(`console.log('Error:', result.error);`);
console.log(`\"`);