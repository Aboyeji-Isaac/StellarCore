# Domain Control Verification for Anchor Registry

This document describes the maintainer workflow for verifying domain control when adding new anchors or changing an anchor's `homeDomain` in the StellarCore anchor registry.

## Overview

The domain control proof mechanism ensures that only entities with control over an anchor's `homeDomain` can add or modify that anchor in the registry. This prevents unauthorized registry changes and maintains the integrity of the anchor directory.

## Proof Format

A domain control proof is a JSON object with the following fields:

```typescript
interface DomainControlProof {
  version: 1;
  homeDomain: string;           // The anchor's home domain (e.g., "mgxanchor.moneygram.com")
  changeHash: string;           // SHA-256 hash of the canonical registry entry
  issuedAt: string;             // ISO 8601 timestamp when proof was created
  expiresAt: string;            // ISO 8601 timestamp when proof expires
  nonce: string;                // 32-char hex, single-use identifier
  signature: string;            // SHA-256 hash of proof data (no secrets)
}
```

### Key Properties

1. **No Secrets**: The signature is a deterministic hash of the proof data, not a cryptographic signature requiring private keys. This makes proofs reviewable and verifiable by anyone.
2. **Bound to Domain AND Change**: The `changeHash` is computed from the exact registry entry (slug, name, homeDomain). A proof for one entry cannot be used for another.
3. **Deterministic Expiry**: Proofs expire after a configurable period (default 30 days for new proofs, 10 years for existing anchors).
4. **Replay Protection**: Each proof has a unique `nonce`. The verification system tracks used nonces to prevent replay attacks.
5. **Fresh Verification on homeDomain Change**: Changing an anchor's `homeDomain` requires a new proof.

## Maintainer Workflow

### Adding a New Anchor

1. **Prepare the registry entry**:
   ```json
   {
     "slug": "newanchor",
     "name": "New Anchor",
     "homeDomain": "anchor.example.com"
   }
   ```

2. **Generate the challenge** (for documentation/verification):
   ```bash
   npx tsx -e "
   import { generateChallenge } from './lib/stellar/domainControl.ts';
   const entry = { slug: 'newanchor', name: 'New Anchor', homeDomain: 'anchor.example.com' };
   console.log(generateChallenge(entry));
   "
   ```

3. **Create the proof** using the verification script:
   ```bash
   npx tsx scripts/create-anchor-proof.ts newanchor "New Anchor" anchor.example.com
   ```

4. **Add the proof to `constants/anchorProofs.ts`**:
   ```typescript
   export const ANCHOR_PROOFS = Object.freeze({
     // ... existing proofs
     newanchor: Object.freeze({
       version: 1,
       homeDomain: "anchor.example.com",
       changeHash: "<computed-hash>",
       issuedAt: "2026-06-15T12:00:00.000Z",
       expiresAt: "2026-07-15T12:00:00.000Z",
       nonce: "<generated-nonce>",
       signature: "<computed-signature>",
     }),
   });
   ```

5. **Add the anchor to `constants/anchors.ts`**:
   ```typescript
   const anchorRegistry = [
     // ... existing entries
     Object.freeze({
       slug: "newanchor",
       name: "New Anchor",
       homeDomain: "anchor.example.com",
     }),
   ] as const satisfies readonly AnchorRegistryEntry[];
   ```

6. **Run validation**:
   ```bash
   npm test
   ```
   The test suite will validate the registry and proofs automatically.

### Changing an Anchor's homeDomain

1. **Update the entry in `constants/anchors.ts`** with the new `homeDomain`.

2. **Generate a new proof** for the updated entry (same process as adding a new anchor).

3. **Update the proof in `constants/anchorProofs.ts`** with the new proof.

4. **Run validation**:
   ```bash
   npm test
   ```

### Verifying a Proof (Reviewer)

Any maintainer can verify a proof offline:

```bash
npx tsx -e "
import { verifyProof } from './lib/stellar/domainControl.ts';
import { ANCHOR_PROOFS } from './constants/anchorProofs.ts';
import { ANCHOR_REGISTRY } from './constants/anchors.ts';

const entry = ANCHOR_REGISTRY.find(a => a.slug === 'newanchor');
const proof = ANCHOR_PROOFS['newanchor'];

const result = verifyProof(proof, entry, {
  clock: { now: () => new Date() },
  isNonceUsed: async () => false,
  markNonceUsed: async () => {},
});

console.log('Valid:', result.ok);
console.log('Proof ID:', result.proofId);
console.log('Verified at:', result.verifiedAt);
if (!result.ok) console.log('Error:', result.error);
"
```

## Verification Logic

The verification process checks:

1. **Version compatibility** - Only version 1 is supported
2. **Home domain match** - Proof's `homeDomain` must equal entry's `homeDomain`
3. **Change hash match** - Proof's `changeHash` must equal hash of the proposed entry
4. **Timestamp validity** - `issuedAt` must be in the past, `expiresAt` must be in the future
5. **Signature validity** - Proof's `signature` must equal hash of proof data
6. **Nonce uniqueness** - Proof's `nonce` (via `proofId`) must not have been used before

## Files

| File | Purpose |
|------|---------|
| `lib/stellar/domainControl.ts` | Core proof generation and verification logic |
| `constants/anchorProofs.ts` | Stores proofs for each anchor (committed to repo) |
| `lib/stellar/anchorRegistry.ts` | Registry validation with proof verification |
| `tests/unit/stellar/domainControl.test.ts` | Unit tests for proof logic |
| `tests/unit/stellar/anchorRegistryValidation.test.ts` | Unit tests for registry validation |

## Security Considerations

- **No private keys**: Proofs use deterministic hashes, not asymmetric cryptography. This is intentional - the proof demonstrates the *ability to publish* to the domain (via the registry), not possession of a private key.
- **Offline verification**: All verification happens offline with no network calls.
- **Replay protection**: Nonce tracking prevents reuse of proofs.
- **Expiry enforcement**: Expired proofs are rejected.
- **Immutable evidence**: Verification results include timestamps and proof IDs for audit trails.

## Troubleshooting

### "Proof has expired"
The proof's `expiresAt` is in the past. Generate a new proof with a later expiry date.

### "Proof issued in the future"
The proof's `issuedAt` is after the verification clock. Ensure the system clock is correct, or wait until the issuedAt time passes.

### "Proof homeDomain does not match"
The proof was created for a different homeDomain. Generate a new proof for the correct domain.

### "Proof changeHash does not match"
The proof was created for a different registry entry (different slug, name, or homeDomain). Generate a new proof for the exact entry.

### "Proof has already been used (replay detected)"
The proof's nonce has been used before. Generate a new proof with a fresh nonce.

### "Invalid proof signature"
The proof data has been tampered with. Regenerate the proof from scratch.