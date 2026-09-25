# StellarCore threat model

STRIDE-organized threat model of the deployed system, per #61. Document only:
no finding is fixed here — each carries severity, likelihood and a concrete
mitigation recommendation for maintainer prioritization. Claims about current
behavior were verified against the code at the cited paths.

**Scope:** the Next.js app on Vercel (public read-only API, internal cron
route), the Postgres database behind Prisma, the outbound SEP-1/10/38 anchor
traffic, the repo-reviewed registry, and the GitHub Actions operational
workflows. Out of scope: Vercel/GitHub platform compromise, the Stellar
network itself.

## System sketch and trust boundaries

```
Internet ──> Vercel edge ──> Next.js routes
   │                           ├─ GET /api/{anchors,corridors,rates,reputation}  (unauthenticated, read-only)
   │                           └─ GET /api/internal/cron/refresh  (Bearer CRON_SECRET)
   │                                     │
   │                                     v  outbound (server-side)
   │                    anchor home_domain TOML ── SEP-38 quote servers ── Horizon
   │
GitHub repo ── PR review ── constants/ registry ── bootstrap workflow ──> Postgres
GitHub Actions (workflow_dispatch) ── migrate deploy ──────────────────> Postgres
```

Trust boundaries: (1) internet → public API; (2) internet → cron route;
(3) app → anchor-controlled URLs (the anchor is *observed*, never trusted);
(4) repo review → registry constants; (5) GitHub environment → production DB.

---

## 1. Registry poisoning

The anchor/corridor registry lives in code (`constants/anchors.ts`,
`constants/corridors.ts`), is shape-validated (`lib/stellar/anchorRegistry.ts`
rejects bad slugs/domains/duplicates) and reaches the database only through
PR review plus the manual `bootstrap-production-registry.yml` workflow.

**Threat (Tampering/Elevation):** the validation checks *shape*, not
*ownership or legitimacy*. A registry PR adding a plausible-looking anchor —
or editing an existing entry's `home_domain` to an attacker's domain — turns
the platform into a reputation launderer: StellarCore would probe, score and
publicly present the attacker's endpoint as a tracked anchor, and all
outbound SEP traffic for that anchor goes to attacker infrastructure (see §2).
The attack is social (getting the PR merged), not technical.

- **Severity: High** (the product's core promise — trustworthy anchor data —
  is the thing subverted). **Likelihood: Low–Medium** (requires review
  failure, but registry edits look routine and diff small).
- **Recommendations:**
  - `CODEOWNERS` entry putting `constants/anchors.ts`, `corridors.ts`,
    `liveRateSources.ts` and `prisma/` behind required maintainer review.
  - A documented admission checklist for new anchors: proof of domain
    control, live `stellar.toml` whose `SIGNING_KEY`/accounts are verified
    on-chain, and a second maintainer sign-off recorded in the PR.
  - The bootstrap workflow already being manual is the right control — add
    GitHub *required reviewers* on the `production` environment so a merged
    registry change still cannot reach the database without a human approval
    (today that protection is listed as optional in `DEPLOYMENT.md`).

## 2. SSRF via anchor-controlled URLs

Outbound requests derive from anchor data: `https://{home_domain}/.well-known/stellar.toml`
(`lib/stellar/sep1.ts`), then TOML-declared endpoints for SEP-10/38.

**Existing mitigations (verified, and good):** hostname must match a public
DNS-name pattern — no IP literals, no ports, no localhost
(`isValidHomeDomain`); SEP-38 quote-server URLs additionally reject
non-HTTPS, userinfo, query, fragment (`normalizeSep38QuoteServer`);
**redirects are refused** (`redirect: "error"` in sep1, `"manual"` + explicit
rejection in sep10/sep38); responses are size-capped (100 KB, enforced while
streaming, not just via Content-Length) and time-limited (10 s abort).

**Residual threat (Information disclosure):** the pattern validates the
*name*, not what it resolves to. A registry-admitted domain (or a compromised
legitimate anchor editing its TOML) can point a valid-looking hostname at an
internal address (private A record or DNS rebinding) and make the app request
it server-side. On Vercel functions the reachable internal surface is small
(no EC2-style metadata service), which caps impact today — but the code is
deployment-portable and a self-hosted deployment would expose its whole
internal network.

- **Severity: Medium** (low on Vercel, high if ever self-hosted).
  **Likelihood: Low** (requires registry admission first — §1 is the gate).
- **Recommendations:**
  - Resolve-then-verify: after DNS resolution, reject RFC 1918/4193,
    loopback, link-local (169.254.0.0/16) and metadata ranges before
    connecting (a `lookup` hook or undici connect interceptor), pinning the
    verified address to defeat rebinding.
  - State in `DEPLOYMENT.md` that self-hosting requires an egress policy for
    the app's outbound traffic.
  - Keep the redirect ban — it is the strongest single control here and
    §2 depends on it staying.

## 3. Rate-limit bypass — today, rate-limit absence

**Threat (Denial of service):** there is **no application-layer rate
limiting anywhere** — no limiter module exists in `app/` or `lib/`, and no
route returns 429. Every public GET is unauthenticated, `Cache-Control:
no-store` (`app/api/rates/route.ts`), and hits Postgres directly; the
`/api/rates` latest-per-anchor query scans and sorts the corridor's whole
snapshot history per request (see PR #70's measurements — hundreds of ms of
database work per call at realistic volume). One inexpensive client loop can
saturate the database connection pool, starve the cron refresh, and inflate
serverless costs. There is nothing to "bypass" yet; the finding is that the
control is missing while the API is publicly advertised.

- **Severity: High** for availability/cost. **Likelihood: Medium–High**
  (no skill required; public endpoint).
- **Recommendations:**
  - Per-IP fixed-window limits enforced in a shared store (the in-progress
    rate-limiting work should *not* use per-instance memory: on serverless,
    per-instance counters reset per invocation and limit nothing — each
    limiter check must read shared state, e.g. Postgres or a KV).
  - When it lands, pair limits with `X-RateLimit-*` + `Retry-After` headers
    and document them; derive client identity from the first
    `x-forwarded-for` hop as set by Vercel, not from client-suppliable
    headers alone — that *is* the future bypass vector to design against.
  - Independent of limiting: these read-only responses are cacheable —
    even a short shared `s-maxage` would collapse repeated load, and is the
    cheaper first defense.

## 4. The internal cron refresh auth boundary

`GET /api/internal/cron/refresh` requires `Authorization: Bearer` matched
against `CRON_SECRET` by SHA-256 + `timingSafeEqual`
(`lib/scheduled/cronAuth.ts`).

**Existing mitigations (verified):** constant-time compare (no
timing oracle); missing `CRON_SECRET` fails closed (`!secret → false`, so an
unconfigured deployment rejects everything rather than allowing everything);
Bearer-header only — no query-string credential that would leak into logs;
GET-only with bounded, `no-store` JSON.

**Residual threats (Spoofing/Repudiation):** a single static long-lived
secret with no rotation procedure and no failure visibility. Whoever holds it
(Vercel env, GitHub secret, anyone who ever saw either) can trigger refreshes
forever; a brute-force or leaked-secret attempt produces indistinguishable,
unalerted 401s. Repeated triggering is also a targeted-DoS lever: each
accepted call does outbound anchor probing and database writes, and the route
itself has no rate limit (§3).

- **Severity: Medium** (the route only refreshes — it cannot read or corrupt
  arbitrary data — but forced refresh loops burn quota and hammer anchors).
  **Likelihood: Low.**
- **Recommendations:**
  - A rotation runbook (generate → set in Vercel → verify → revoke old), and
    rotate on any suspicion of exposure.
  - Log and alert on authorization failures for the route (count of 401s),
    so probing is visible.
  - Apply the same shared-store rate limit to this route when §3 lands, and
    consider requiring the secret to be ≥ 32 random bytes in a startup check.

## 5. Adjacent findings (completeness)

- **SQL injection: no finding.** All queries go through Prisma or
  `$queryRaw` with `Prisma.sql` tagged templates (parameterized); no string
  concatenation into SQL was found.
- **Production migration workflow:** `deploy-production-migrations.yml` and
  the bootstrap workflow are `workflow_dispatch`-only with least-privilege
  permissions — good — but GitHub *environment protection (required
  reviewers) is documented as optional*. Anyone with write access can
  currently run a production migration. Make the reviewer requirement
  non-optional. **Severity: Medium, Likelihood: Low.**
- **Dependency and secrets exposure:** tracked separately in the 2026-09-25
  audit (`docs/security-audit-2026-09-25.md`): 1 critical / 8 high advisory
  findings (the `next`/`sharp` image-optimizer surface is the real one) and
  a clean full-history secrets scan.
- **Public data integrity (Repudiation/Tampering):** rates and reputation
  presented to users are only as good as the anchors probed; a malicious
  anchor can shade its *own* quotes. The median/staleness design limits
  cross-anchor damage, and §1's admission controls are the systemic answer.

## Summary table

| # | Threat | STRIDE | Severity | Likelihood | Headline mitigation |
| - | ------ | ------ | -------- | ---------- | ------------------- |
| 1 | Registry poisoning via reviewed PR | T/E | High | Low–Med | CODEOWNERS + anchor admission checklist + required env reviewers |
| 2 | SSRF residual: hostname resolves private | I | Medium | Low | Resolve-then-verify IP filtering; keep the redirect ban |
| 3 | No rate limiting on public API | D | High | Med–High | Shared-store per-IP limits + shared caching |
| 4 | Static cron secret, silent 401s | S/R | Medium | Low | Rotation runbook + auth-failure alerting |
| 5 | Unprotected production migration dispatch | E | Medium | Low | Make environment reviewers required |
