# Runbook: onboarding a reviewed SEP-38 rate source

This procedure verifies a candidate source without treating an advertised
interface as proof of a working quote. A contributor reports evidence for
maintainer review; contributors never add entries directly to
`REVIEWED_LIVE_RATE_SOURCES`.

## 1. Record the candidate

Capture the provider name, production home domain, source asset and issuer,
destination asset and issuer, quote endpoint, the date/time of each check, and
the exact URLs and response snippets used as evidence. Keep the candidate
separate from the reviewed live-source registry while investigating it.

## 2. Verify the reachable production TOML

1. Resolve the provider's production `stellar.toml` URL over HTTPS.
2. Confirm the response is reachable, valid TOML, and belongs to the claimed
   production domain.
3. Record the advertised `TRANSFER_SERVER_SEP0024`,
   `DIRECT_PAYMENT_SERVER`, and `WEB_AUTH_ENDPOINT` values when present.
4. Confirm the home domain and issuer information are consistent with the
   candidate. A reachable TOML alone is not enough to approve a rate source.

## 3. Verify the advertised quote server

1. Follow the advertised quote-server URL and record the final origin.
2. Confirm the server is reachable over HTTPS and responds with the expected
   JSON content type.
3. Use the provider's documented authentication and request shape if the
   endpoint requires it; never submit funds or credentials during this check.
4. Record status codes, bounded response samples, and any clear error body.

## 4. Verify `/prices` contains the exact pair

1. Request the quote server's `/prices` endpoint using its documented query
   parameters.
2. Find the exact source/destination pair, including the issuer-bearing asset
   identity. Matching only `USDC` or another code without the issuer is not a
   match.
3. Confirm the pair is enabled and its response shape is parseable.
4. Save the exact pair identity and response timestamp in the findings.

## 5. Verify `/price` returns a quote

1. Request `/price` for the exact issuer-bearing pair and a small, documented
   amount.
2. Confirm the response is successful, parseable, and contains the expected
   price/fee fields.
3. Repeat once when practical to distinguish a transient response from a
   stable endpoint. Do not describe a quote as live if the endpoint is stale,
   unsupported, or returning an error.

## 6. Submit findings for review

Open or update the issue with:

- candidate name and production domain;
- TOML URL and the advertised quote-server URL;
- exact issuer-bearing pair found in `/prices`;
- `/price` request shape, timestamp, and bounded response evidence;
- any authentication, freshness, or reproducibility limitations;
- any publicly documented operator, ownership, or upstream-dependency evidence
  that may bear on whether the candidate is commonly controlled with an
  already-reviewed source; and
- a clear recommendation: verified, needs follow-up, or rejected.

The maintainer decides whether the candidate is reviewed and eligible for the
registry. A contributor must not edit `constants/liveRateSources.ts` or add an
entry directly to `REVIEWED_LIVE_RATE_SOURCES` as part of this investigation.

## 7. Record the reviewed source authority

The maintainer — not the contributor — records which reviewed operator is
behind the candidate:

1. Decide whether the candidate belongs to an existing reviewed authority. A
   different anchor slug, host, issuer account, or brand is not by itself
   evidence of independent control, and neither is price similarity.
2. If it is a new independent operator, add one entry to
   `constants/sourceAuthorities.ts` with a newly assigned opaque `authorityId`
   of the form `auth-NNNN`, a display name, and configuration version `1`.
   Identifiers are assigned once and never derived from display text, anchor
   slugs, home domains, or endpoint hostnames.
3. If it shares an operator with an existing reviewed source, reuse that
   existing `authorityId` in `constants/liveRateSources.ts`.
4. If only the reviewed label changed, keep the existing `authorityId` and
   update `displayName`, bumping `configurationVersion` only when the reviewed
   identity itself changed.
5. Run `npm run audit:config` and `npm run registry:print`, then open the pull
   request with the authority decision and its supporting public evidence.

Two reviewed anchors under one authority remain valid configuration, but they
contribute at most one value toward the median requirement.

## 8. Reference investigation set

Use the same evidence standard used while investigating nTokens, Settle,
Transfero, BlindPay, Bitso, and VANK for issue #7: reachable production TOML,
advertised quote server, exact issuer-bearing `/prices` pair, and a working
`/price` response. If a provider fails any step, document the failure and stop
short of registry inclusion.
