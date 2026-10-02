---
name: Propose a new corridor
about: Propose adding a new asset/country pair corridor to the StellarCore registry
title: "feat(corridor): Propose [source_asset]-[source_country] to [dest_asset]-[dest_country] corridor"
labels: ["corridor", "registry"]
assignees: ""
---

### Source Asset & Country

- **Source Asset Code:** <!-- e.g., USDC -->
- **Source Country (ISO 3166-1 alpha-2):** <!-- e.g., US -->

### Destination Asset & Country

- **Destination Asset Code:** <!-- e.g., NGN -->
- **Destination Country (ISO 3166-1 alpha-2):** <!-- e.g., NG -->

### Proposed Corridor Slug

- **Corridor Slug:** <!-- e.g., usdc-us-ngn-ng (lowercase format: [assetCodeFrom]-[countryFrom]-[assetCodeTo]-[countryTo]) -->

---

### Supporting Anchor(s)

> **Important:** A corridor cannot exist in the registry without at least one anchor serving it. If the anchor is not yet in the registry, please link the corresponding add-anchor issue.

- **Anchor Name / Slug:** <!-- e.g., Cowrie (slug: cowrie) -->
- **Anchor Status:**
  - [ ] Anchor is already registered in `constants/anchors.ts`
  - [ ] Anchor is proposed in an accompanying issue (Issue #: <!-- link or issue number -->)

---

### Asset Verification & Issuer Confirmation

- [ ] **Exact Issuer-Bearing Asset Confirmation:** I confirm that the serving anchor supports the exact issuer-bearing asset for this pair on Stellar, not merely a matching asset code.
- **Anchor Issuing Account / Asset Details:** <!-- Provide the Stellar asset issuer public key or SEP-1 stellar.toml reference -->

---

### Additional Context

<!-- Provide any additional details, relevant documentation, SEP-38 / SEP-24 support details, or Stellar Expert links -->

---

### Maintainer Review Notice

*Note: All proposed corridors are reviewed by the StellarCore maintainer team for correctness, evidence integrity, and anchor verification before inclusion and merge into the registry.*
