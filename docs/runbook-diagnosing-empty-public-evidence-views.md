# Runbook: diagnosing empty public evidence views

## Purpose and scope

An "empty public evidence view" means the public surface that shows persisted rate/evidence data appears empty (or returns no usable observations) while a responder expects to see evidence. This runbook is for operators/support responding to reports that the public dashboard/API is not showing rate observations for a corridor (e.g. /dashboard Rates panel or GET /api/rates?corridor=...).

This is a read-only troubleshooting runbook for the persisted-evidence model in this repo. It distinguishes:

- Genuinely absent observations (no persisted ate_snapshots for that corridor/anchors)
- Failed scheduled capture (scheduled refresh ran but produced failures/suppression)
- Database connectivity problems (transient DB errors causing stale fallback or failures)
- Rendering or API regression (API returns data but the UI does not display it)

## Safety rules (read-only by default)

- **Default to read-only.** Every step below uses read-only inspection (HTTP GETs, read-only DB inspection, log reads). 
- **Do not mutate by default.** Actions that could change state (re-triggering the scheduled capture job, restarting services, running migrations, writing to the DB, reactivating suppression) are **NOT** default steps. If such action becomes necessary, you must:
  - Clearly mark it with a visible **WARNING: MUTATING ACTION**
  - State exactly what it changes
  - Get explicit approval and confirm the target environment first
- **Redact before sharing.** See [Safe log and diagnostic collection](#safe-log-and-diagnostic-collection) before pasting logs/configs.
- **No secrets in examples.** All examples use placeholders like <BASE_URL>, <CORRIDOR_SLUG>, <TOKEN> with no real hostnames/credentials.

## Diagnostic sequence

Follow in order. Each step gives purpose, exact read-only check, expected healthy result, how to interpret unhealthy, and next step.

### 1) Confirm the symptom (API first, separate from UI)
**Purpose:** Rule out UI rendering issues by inspecting the public API directly.

**Read-only check (HTTP):**
`ash
curl -sS -i "https://<BASE_URL>/api/rates?corridor=<CORRIDOR_SLUG>"
curl -sS -i "https://<BASE_URL>/api/rates/history?corridor=<CORRIDOR_SLUG>"
`
(If deployed elsewhere, substitute <BASE_URL>. These are GET-only, dynamic routes with Cache-Control: no-store.)

**Expected healthy:**
- HTTP 200
- JSON with corridor, evaluatedAt, state, and observations array
- If sufficient fresh sources: state indicates healthy aggregation and medianRate may be set
- If insufficient: HTTP 200 with state: "insufficient_fresh_sources" and medianRate: null (valid response with insufficient usable observations)

**Interpretation:**
- **Empty data (valid):** HTTP 200, valid JSON, observations: [] or insufficient fresh sources causing insufficient_fresh_sources with medianRate: null.
- **API failure:** Non-2xx (400/404/429/500), timeout, connection error, or malformed payload. Check stable error codes.
- **Stale data (degraded fallback):** HTTP 200 with degraded object and headers X-Evidence-State: stale / Warning: 110. Treat as stale cached evidence.

**Next:** If API returns data go to step 6. If API fails/stale go to step 2/4.

### 2) Check health/readiness signals and DB connectivity
**Purpose:** Determine if DB/connectivity issues are causing failures or stale fallback.

**Read-only checks:**
- Inspect app startup/runtime logs around last restart/deploy for DB/TLS/config errors (instrumentation startup validation).
- Note: This repo has no obvious standalone /health or /ready HTTP endpoints in pp/api/*. Treat absence as a gap (do not invent). Focus on API behavior, logs, and DB inspection.

**Expected healthy:** API calls succeed or return expected business errors; no repeated DB connection errors.
**Unhealthy:** Repeated internal_error, timeouts, or stale fallback headers indicate transient DB failures.
**Next:** If DB/connectivity suspected, proceed to step 5 and step 4.

### 3) Check the scheduled capture job's last run, status, and errors
**Purpose:** The scheduled refresh (GET /api/internal/cron/refresh) snapshots reviewed live rates and evaluates reputation.

**Read-only checks (what exists):**
- **Route/handler:** pp/api/internal/cron/refresh/route.ts calls getScheduledRefreshResponse (authorized via hasValidCronAuthorization).
- **Orchestration:** lib/scheduled/refresh.ts runs snapshotRates() then evaluateReputation(). Deterministic failures recorded via suppression repository.
- **Suppression:** lib/scheduled/suppression.ts (PERMANENT_FAILURE_SUPPRESSION_THRESHOLD=3) moves to SUPPRESSED; reactivation via scripts/reactivate-scheduled-source.ts / 
pm run suppression:reactivate.

**Read-only inspection:**
`ash
cat scripts/reactivate-scheduled-source.ts | head -80
`

**Expected healthy:** ates.failed == 0 and eputation.failed == 0 in recent runs; sources not unexpectedly suppressed.
**Unhealthy:** ates.failed > 0, LIVE_RATE_PREPARATION_FAILURE, or suppressed sources affecting expected corridors.
**Next:** Correlate failures to affected corridors/anchors (step 5), check logs (step 4).

> **WARNING: MUTATING ACTION (if considering re-trigger/override):** Calling GET /api/internal/cron/refresh with valid CRON_SECRET executes unScheduledRefresh() (may write observations/evaluations). 
pm run suppression:reactivate mutates suppression state. Neither is a default diagnostic step - require approval and environment confirmation.

### 4) Check logs for errors in the relevant window
**Purpose:** Find DB errors, preparation failures, serialization errors, or rate limiter blocks.

**Where to look:**
- **API errors:** lib/api/errors.ts logs [stellarcore:public-api] <operation> failed (<code>)
- **Instrumentation:** instrumentation.ts logs untime_config_fingerprint JSON and TLS bypass warnings

**Read-only examples:**
`ash
# Container/platform log search (placeholder)
docker logs <container> --since 30m 2>&1 | grep -E '\[stellarcore:public-api\]|internal_error|LIVE_RATE_PREPARATION_FAILURE|DATABASE_UNAVAILABLE|X-Evidence-State|stale'
`

**Expected healthy:** No repeated errors for affected corridor/operation.
**Unhealthy:** Errors correlate with symptoms (DB unavailable, preparation failures, serialization failures).
**Next:** Cross-reference with DB state (step 5).

### 5) Inspect persisted data (read-only DB inspection)
**Purpose:** Confirm whether observations exist for the corridor/anchors.

**Relevant:** Corridor, Anchor, AnchorCorridor, RateSnapshot, ReputationScore. Freshness evaluated at read time (default RATE_FRESHNESS_THRESHOLD_MS 120000ms).

**Read-only SQL examples:**
`sql
-- Corridor
SELECT * FROM "Corridor" WHERE slug = '<CORRIDOR_SLUG>';

-- Associations
SELECT ac.*, a.slug as anchor_slug FROM "AnchorCorridor" ac
JOIN "Anchor" a ON a.id = ac."anchorId"
WHERE ac."corridorId" = (SELECT id FROM "Corridor" WHERE slug = '<CORRIDOR_SLUG>');

-- Snapshots counts/latest
SELECT COUNT(*), MAX("capturedAt") as latest_captured
FROM "RateSnapshot"
WHERE "corridorId" = (SELECT id FROM "Corridor" WHERE slug = '<CORRIDOR_SLUG>');
`

**Expected healthy:** Corridor exists, associations exist, recent RateSnapshot rows within freshness window.
**Unhealthy:** No corridor/associations, zero snapshots, only stale snapshots, or snapshots present but all excluded (insufficient fresh).
**Next:** Go to step 6 or step 4.

### 6) Distinguish backend vs rendering/frontend regression
**Purpose:** If API returns data but view is empty, likely UI/rendering issue.

**Read-only checks:**
- Compare API response for the corridor with UI (network tab or direct curl from step 1)
- Check other corridors
- Review pp/dashboard/page.tsx and dashboard components (components/dashboard/*) for filtering logic
- Verify response shape matches UI expectations

**Expected healthy:** API data matches UI display.
**Unhealthy:** API returns valid non-empty observations but UI empty -> likely rendering/filtering regression.
**Next:** Check recent deploys/changes (step 7).

### 7) Check for recent deploys/changes
**Purpose:** Rule out recent regressions.

**Read-only checks:**
- Review recent git commits/PRs around incident time
- Check deployment history if available
- Look for changes to API routes, rate aggregation, stale evidence, or dashboard components

**Expected healthy:** No correlated recent changes.
**Unhealthy:** Recent change correlates with symptom.
**Next:** Proceed to decision table/escalation.

## Decision table / flow summary

| Symptom | Likely cause | Next action |
|---|---|---|
| HTTP 200, observations: [] or state: "insufficient_fresh_sources", medianRate: null | Genuinely absent/insufficient persisted observations | Steps 3,5. Check scheduled job and DB snapshots/freshness. |
| HTTP 200 with degraded and X-Evidence-State: stale / Warning: 110 | Stale fallback from transient DB failure | Steps 2,4,5. Investigate DB connectivity/logs. |
| Non-2xx, timeout, malformed JSON | API failure / DB unavailable | Steps 2,4. Check logs and connectivity. |
| API returns data but UI empty | Rendering/frontend regression | Steps 6,7. Compare API vs UI, check recent changes. |
| Scheduled job shows failures/suppression | Failed capture/suppressed sources | Steps 3,5,4. Inspect failures/suppression; mutating actions require approval. |

## Safe log and diagnostic collection

**Redact before sharing:**
- **Secrets/tokens:** Remove Authorization headers, CRON_SECRET, bearer/JWT tokens, API keys
- **Connection strings:** Redact DATABASE_URL values
- **Cookies/session:** Remove cookie headers/values
- **PII/config:** Avoid full env dumps or entire config files; share only relevant items
- **URLs:** Replace internal hostnames with placeholders if sensitive

**Concrete redaction examples (adapt to actual log format):**
`ash
grep -v -i 'authorization:' logs.txt
sed -E 's/postgres(ql)?:\/\/[^@]+@[^ ]+/[REDACTED_DB_URL]/g' logs.txt
sed -E 's/CRON_SECRET=[^ ]+/CRON_SECRET=[REDACTED]/g' logs.txt
sed -E 's/Bearer [A-Za-z0-9\.\-_]+/Bearer [REDACTED]/g' logs.txt
`
**Warning:** Only use filters that fit the log format; never paste raw env dumps.

## Escalation

**Include in report:**
- Corridor slug and <BASE_URL> (placeholders)
- API responses from step 1 (redacted, headers if relevant)
- Scheduled refresh status summary (if known)
- Redacted log excerpts for the relevant window
- DB inspection summary (counts/latest timestamps), no connection strings
- Screenshots if rendering issue
- Recent deploy/commit SHA if known

**When to escalate:**
- Persistent DB connectivity failures after checks
- Repeated preparation failures across multiple sources/corridors
- Suspected data corruption/integrity issues
- Security concerns (leaked secrets) - rotate/redact immediately
- Unclear if mutating action needed (refresh/suppression/reactivation) - get maintainer approval first

**Notes/gaps (from repo inspection):**
- No obvious standalone /health or /ready HTTP endpoints found in pp/api/* - rely on API behavior and logs.
- "Public evidence view" maps to public rate/evidence surfaces (dashboard Rates panel, GET /api/rates*, related read APIs).
- Scheduled job is GET /api/internal/cron/refresh (authorized). Last-run history may be in DB/suppression state or logs depending on deployment.
