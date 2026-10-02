# Verification: second independent SEP-38 rate source for USDC -> BRL

- **Status:** No qualifying candidate found
- **Date checked:** 2026-09-26 (all endpoint probes listed below)
- **Target pair:** `stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` -> `iso4217:BRL`

## Scope and standard

This report follows the four-requirement standard in
[`runbook-onboarding-rate-source.md`](runbook-onboarding-rate-source.md). A
candidate qualifies only if **all** of the following are directly observed:

1. A reachable production `stellar.toml` at the anchor's home domain.
2. The TOML advertises an `ANCHOR_QUOTE_SERVER`.
3. `GET /prices` returns the **exact issuer-bearing** USDC pair above paired
   with `iso4217:BRL` (a generic `USDC` entry without the issuer does not
   count).
4. `GET /price` for the exact pair returns a real indicative rate.

The previously rejected candidates (nTokens, Settle, Transfero, BlindPay,
Bitso, VANK) were not re-confirmed unless new evidence warranted it. A
second observation from Zeam does not count as an independent source; Zeam
is included below only as the recorded baseline for the exact issuer pair.

## Baseline: Zeam (already the sole reviewed source)

- **Candidate:** Zeam
- **Home domain:** `zeam.money`
- **stellar.toml URL:** `https://zeam.money/.well-known/stellar.toml`
- **Quote server URL:** `https://anchor.zeam.money/sep38` (advertised as
  `ANCHOR_QUOTE_SERVER`)
- **/prices URL:**
  `https://anchor.zeam.money/sep38/prices?sell_asset=stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&sell_amount=100`
- **Observed /prices response:**

  ```json
  {"buy_assets":[{"asset":"iso4217:BRL","price":"0.18","decimals":2}]}
  ```

- **/price request:**
  `https://anchor.zeam.money/sep38/price?sell_asset=stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&sell_amount=100&buy_asset=iso4217:BRL&context=sep31`
- **Observed /price response:**

  ```json
  {"total_price":"0.18","price":"0.17","sell_amount":"100","buy_amount":"17","fee":{"total":"1.00","asset":"iso4217:BRL","details":[{"name":"Service fee","amount":"1.00"}]}}
  ```

- **Requirement-by-requirement verification:** R1 pass, R2 pass, R3 pass
  (saw the exact issuer-bearing pair), R4 pass.
- **Final qualification:** YES (baseline only; **a second observation of the
  same anchor is not independent** per the issue).
- **Reasoning:** Zeam is the single existing entry in
  `REVIEWED_LIVE_RATE_SOURCES` ([`constants/liveRateSources.ts`](../constants/liveRateSources.ts))
  for corridor `usdc-us-brl-br`. It confirms the exact asset identity and
  endpoint shapes used in this report.

## Candidates that qualified on the first two requirements

### MoneyGram

- **Candidate:** MoneyGram Stellar
- **Home domain:** `mgxanchor.moneygram.com`
- **stellar.toml URL:** `https://mgxanchor.moneygram.com/.well-known/stellar.toml`
- **Observed TOML:** serves `WEB_AUTH_ENDPOINT`,
  `TRANSFER_SERVER_SEP0024`, `WEB_AUTH_FOR_CONTRACTS_ENDPOINT`,
  `SIGNING_KEY`; `[[CURRENCIES]]` lists USDC with the **exact issuer**
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, status
  `live`.
- **Quote server URL:** none found.
- **/prices URL:** n/a.
- **Observed /prices response:** n/a.
- **/price request:** n/a.
- **Observed /price response:** n/a.
- **Requirement-by-requirement verification:** R1 pass. R2 **fail** — no
  `ANCHOR_QUOTE_SERVER` key in the production TOML. R3/R4 not applicable.
- **Final qualification:** NO.
- **Reasoning:** A reachable TOML that confirms the exact USDC issuer is not
  sufficient; the anchor does not advertise a SEP-38 quote server. The
  preview domain (`previewstellar.moneygram.com/.well-known/stellar.toml`)
  was also checked and likewise advertises no `ANCHOR_QUOTE_SERVER`.

### Cowrie Exchange

- **Candidate:** Cowrie Exchange
- **Home domain:** `cowrie.exchange`
- **stellar.toml URL:** `https://cowrie.exchange/.well-known/stellar.toml`
- **Observed TOML:** serves `TRANSFER_SERVER`, `DIRECT_PAYMENT_SERVER`,
  `WEB_AUTH_ENDPOINT`, `KYC_SERVER`, `FEDERATION_SERVER`, `SIGNING_KEY`;
  currencies are NGNT and related NGN assets only.
- **Quote server URL:** none found.
- **/prices URL:** n/a.
- **Observed /prices response:** n/a.
- **/price request:** n/a.
- **Observed /price response:** n/a.
- **Requirement-by-requirement verification:** R1 pass. R2 **fail** — no
  `ANCHOR_QUOTE_SERVER` key. R3/R4 not applicable.
- **Final qualification:** NO.
- **Reasoning:** Cowrie is a Nigerian NGN corridor anchor and does not
  advertise SEP-38.

## Candidates that failed on Requirement 1 (no reachable production TOML)

| Candidate | Home domain tried | stellar.toml attempt | Observation | Failing requirement |
|---|---|---|---|---|
| Lumx | `lumx.io`, `www.lumx.io` | `/.well-known/stellar.toml` | 404/Not found on both | R1 |
| Anclap | `anclap.com` | `https://anclap.com/.well-known/stellar.toml` | TOML reachable but advertises `TRANSFER_SERVER`, `WEB_AUTH_ENDPOINT`, `KYC_SERVER`, `FEDERATION_SERVER` only — no `ANCHOR_QUOTE_SERVER`; assets ARS/PEN, no BRL | R2 |
| Amero Exchange | `amero.exchange` | `/.well-known/stellar.toml` | Returns homepage HTML, not TOML | R1 |
| Alfred Pay | `alfredpay.io`, `app.alfredpay.io` | `/.well-known/stellar.toml` | Invalid `.well-known` request / error, no TOML | R1 |
| Truust | `truust.io` | `/.well-known/stellar.toml` | Marketing page HTML; payment orchestrator, not Stellar anchor | R1 |
| Mercuryo | `mercuryo.io` | `/.well-known/stellar.toml` | Legal page, no TOML | R1 |
| Abroad Finance | `abroad.finance` | `/.well-known/stellar.toml` | Firebase 404 | R1 |
| Zro Bank | `zro.bank.bz`, `www.zro.bank` | `/.well-known/stellar.toml` | Fetch errors, no TOML | R1 |
| Ripio | `www.ripio.com` | `/.well-known/stellar.toml` | Cloudflare block, TOML not retrievable | R1 |
| Bitstamp | `bitstamp.net` | `/.well-known/stellar.toml` | Legal page, no TOML | R1 |

Notes:

- **Lumx** is a Brazilian BRL / USDC corridor operator with production
  announcements (2026-08), but it serves no public SEP-1 `stellar.toml`;
  Requirement 1 fails.
- **nTokens** (BRL asset) was not re-tested as a candidate: it appears on
  Stellar Expert with a "reported for illicit or fraudulent activity" warning
  and is already on the pre-rejected list.
- The official Stellar anchor directory lists several Brazil-onramp anchors
  (APS, Alfred Pay, Amero, Binance, Bitnovo, Bitso, Bitstamp, BlindPay,
  Ripio); with a PIX delivery filter the set narrows to Bitstamp, BlindPay,
  and Ripio — Bitstamp and Ripio have no reachable TOML and BlindPay is
  pre-rejected. None advertise a verified public SEP-38 quote server.

## Conclusion

**Final qualification: NO** — no second independent anchor satisfies all four
requirements for `stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
-> `iso4217:BRL` as checked on 2026-09-26.

Every candidate failed either Requirement 1 (no reachable production
`stellar.toml`) or Requirement 2 (no advertised `ANCHOR_QUOTE_SERVER`), so no
`/prices` or `/price` verification was possible. No registry change is
proposed; `REVIEWED_LIVE_RATE_SOURCES` is intentionally untouched.

**Strongest near-misses to revisit later:**

- **MoneyGram** — passes R1 with the exact issuer in its TOML; would qualify
  if it ever advertises an `ANCHOR_QUOTE_SERVER`.
- **Lumx** — production BRL-USDC corridor, but needs a public SEP-1
  `stellar.toml` and advertised quote server before it can be verified.