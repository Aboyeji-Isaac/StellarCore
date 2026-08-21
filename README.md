# StellarCore

**The intelligence layer for Stellar anchors.**

Real-time rate aggregation, reputation scoring, and corridor discovery — all in one open-source dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built on Stellar](https://img.shields.io/badge/Built%20on-Stellar-7C3AED)](https://stellar.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://typescriptlang.org)
[![Drips Wave](https://img.shields.io/badge/Drips%20Wave-7-00d4b4)](https://drips.network/wave)

---

## The Problem

The Stellar network has dozens of anchors — companies like MoneyGram, Cowrie, and others that handle USDC off-ramps to local currencies across Nigeria, Kenya, Ghana, Mexico, and more. But there is no single source of truth for:

- Which anchors support a given corridor
- What rate each anchor is offering right now
- Which anchors have strong historical performance
- Which anchors are live, degraded, or down

Developers and users are left checking anchor websites one at a time. StellarCore solves this.

---

## What StellarCore Does

StellarCore continuously reads the Stellar network, aggregates anchor data from SEP-1 TOML files, fetches live SEP-38 quotes, tracks historical transfer outcomes, computes reputation scores, and serves everything through a public API and a real-time dashboard.

> Think of it as **Google Flights for Stellar anchors** — pick a corridor, see every option, trust the data.

---

## Architecture

```mermaid
graph TB
    subgraph FE["StellarCore Frontend (Next.js)"]
        UI["Dashboard / Anchor Directory\nCorridor Explorer · Rate Comparison"]
        SWR["SWR Client\n60s polling"]
        REPVIEW["Reputation Leaderboard"]
    end

    subgraph BROWSER["Browser / API Consumer"]
        USER["User / Developer"]
        CLIENT["REST API Client\nfetch · axios · SDK"]
    end

    subgraph BACKEND["Backend Services"]
        SYNC["Sync Engine\ndaily · TOML fetch · anchor upsert"]
        RATESNAP["Rate Snapshot\n60s · SEP-38 poll per anchor"]
        REPENG["Reputation Engine\nhourly · fill rate · speed · slippage"]
        MEDIAN["Median Pricing\nstaleness-aware · fallback chain"]
        ROUTES["Next.js Route Handlers\n/api/anchors · /api/rates · /api/reputation"]
    end

    subgraph DB["PostgreSQL · Supabase"]
        ANCHORS[("anchors")]
        CORRIDORS[("corridors")]
        RATES[("rate_snapshots")]
        OUTCOMES[("transfer_outcomes")]
        SCORES[("reputation_scores")]
        JUNCTION[("anchor_corridors")]
    end

    subgraph PUBAPI["Public REST API"]
        PA1["GET /api/anchors"]
        PA2["GET /api/rates"]
        PA3["GET /api/corridors"]
        PA4["GET /api/reputation/:id"]
        PA5["POST /api/outcomes"]
    end

    subgraph STELLAR["Stellar Network"]
        TOML["SEP-1 TOML Files\nanchor.homeDomain/.well-known"]
        SEP38["SEP-38 Quote Endpoints\nPOST /sep38/quote"]
        HORIZON["Horizon API\nledger · accounts · tx history"]
    end

    USER -->|renders| UI
    UI --> SWR
    SWR -->|60s poll| ROUTES
    CLIENT -->|REST calls| PUBAPI
    ROUTES -->|Prisma queries| DB
    PUBAPI -->|query results| DB
    SYNC -->|fetch TOML| TOML
    RATESNAP -->|POST /quote| SEP38
    REPENG -->|read outcomes| OUTCOMES
    REPENG -->|write scores| SCORES
    MEDIAN -->|read snapshots| RATES
    SYNC -->|upsert| ANCHORS
    HORIZON -->|tx history| REPENG
    BACKEND --> DB
```

---

## System Overview

```
                         ┌───────────────────────────────────────┐
                         │         STELLAR NETWORK               │
                         │  SEP-1 TOML   SEP-38 API   Horizon   │
                         └──────────────┬────────────────────────┘
                                        │
                               ┌────────▼────────┐
                               │   SYNC ENGINE    │
                               │  TOML parser     │
                               │  SEP-38 poller   │
                               │  Uptime monitor  │
                               └────────┬────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │         POSTGRESQL            │
                         │  anchors  corridors  rates   │
                         │  outcomes  reputation_scores  │
                         └──────────────┬──────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────┐
              │                         │                     │
    ┌─────────▼────────┐    ┌──────────▼──────┐    ┌────────▼──────┐
    │  REPUTATION       │    │  RATE ENGINE    │    │  PUBLIC API   │
    │  ENGINE           │    │                 │    │               │
    │  fill rate        │    │  staleness      │    │  /anchors     │
    │  settlement speed │    │  detection      │    │  /rates       │
    │  slippage         │    │  median pricing │    │  /corridors   │
    │  score bands      │    │  fallback chain │    │  /reputation  │
    └──────────────────┘    └────────────────┘    └──────────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │      NEXT.JS FRONTEND        │
                         │  Anchors · Corridors · Rates │
                         │  Reputation · Live Dashboard  │
                         └─────────────────────────────┘
```

---

## How It Works

### 1. Anchor Discovery

StellarCore reads the Stellar network's TOML files. Every Stellar anchor publishes a `stellar.toml` file at their home domain that declares what SEPs they support, what assets they handle, and what endpoints they expose.

```
GET https://anchor.example.com/.well-known/stellar.toml
```

The sync engine parses every TOML file and extracts:

- Supported SEPs (`SEP_6`, `SEP_24`, `SEP_31`, `SEP_38`)
- Supported currencies and asset codes
- API endpoints for rate quotes
- Transfer instruction URLs

Anchors that declare only `SEP_1` without any transfer SEPs are classified as **issuer-only** and excluded from corridor results. Only anchors with at least one of `SEP_6`, `SEP_24`, or `SEP_31` appear in the dashboard.

```typescript
// lib/stellar/anchors.ts

const TRANSFER_SEPS = [6, 24, 31]

export function transferCapable(anchor: Anchor): boolean {
  return anchor.seps?.some((sep) => TRANSFER_SEPS.includes(sep)) ?? false
}
```

### 2. Live Rate Aggregation (SEP-38)

Every 60 seconds, the rate engine polls every active anchor's SEP-38 endpoint for live quotes across all corridors they support.

```
POST https://anchor.example.com/sep38/quote
{
  "sell_asset":   "stellar:USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  "buy_asset":    "iso4217:NGN",
  "sell_amount":  "100"
}
```

Rates are stored as timestamped snapshots. A rate is considered **stale** when it is older than `RATE_FRESHNESS_THRESHOLD_MS` (default: 120 seconds).

#### Staleness-Aware Median

The rate engine computes a median across fresh sources to produce a robust, outlier-resistant price for each corridor:

```
All sources for USDC → NGN:

  Anchor A:  ₦1,612  (fresh · 18s old)
  Anchor B:  ₦1,608  (fresh · 41s old)
  Anchor C:  ₦1,590  (stale · 140s old)  ← excluded
  Anchor D:  ₦1,615  (fresh · 12s old)

Fresh sources:  [1608, 1612, 1615]
Sorted median:   1612
```

If fewer than `MIN_FRESH_SOURCES` (default: 2) are available, the fallback chain walks through priority groups, marks `fallbackEngaged: true` in the response, and annotates which sources were excluded and why.

### 3. Reputation Scoring

StellarCore tracks the outcome of every transfer processed by each anchor. Each completed transfer contributes three signals to the anchor's reputation:

| Signal | Description | Weight |
|---|---|---|
| Fill Rate | Did the transfer complete at the quoted amount? | 33% |
| Settlement Speed | How fast did funds arrive (p50 and p95)? | 33% |
| Slippage | How far was the final rate from the quoted rate? | 33% |

Scores are computed on rolling 7-day, 30-day, and 90-day windows. An anchor needs at least `MIN_OUTCOMES_THRESHOLD` (default: 30) recorded outcomes before leaving the **bootstrap phase**.

```
Bootstrap phase (< 30 outcomes):
  compositeScore:  null
  state:           "insufficient_data"
  scoreBand:       null

Live phase (≥ 30 outcomes):
  compositeScore:  94.2
  state:           "ok"
  scoreBand:       "amber"   ← ≥95 green · 80-94 amber · <80 red
```

### 4. The Public API

Every piece of data StellarCore collects is available through a public REST API. Third-party dApps can query anchor data and reputation scores without building their own aggregation layer.

All endpoints return a standard envelope:

```json
{
  "data": { },
  "meta": {
    "computedAt": "2026-08-12T10:30:00Z",
    "freshSources": 3,
    "staleSources": 1,
    "fallbackEngaged": false
  }
}
```

### 5. The Dashboard

The Next.js frontend consumes the API and presents data in real time. SWR polls rate endpoints every 60 seconds. The interface handles the bootstrap state gracefully — anchors without enough data show a progress indicator instead of a misleading score.

---

## Data Flow

### Anchor Sync Flow

```
Every 24 hours via GitHub Actions cron:

  1. Read anchor registry (constants/anchors.ts)
  2. For each anchor:
       → Fetch stellar.toml from homeDomain
       → Parse SEPs, assets, endpoints
       → Run transferCapable() → true / false
       → Upsert into anchors table
  3. For each anchor + corridor pair:
       → Upsert into anchor_corridors table
  4. Log sync result to console
```

### Rate Snapshot Flow

```
Every 60 seconds via Vercel cron:

  1. Load all active anchors with SEP-38 support
  2. For each anchor:
       → POST /sep38/quote for each supported corridor
       → Record { anchorId, corridorId, rate, capturedAt }
       → Mark isStale = true if age > FRESHNESS_THRESHOLD
  3. For each corridor:
       → Filter to fresh rates only
       → Compute median across fresh sources
       → Engage fallback if < MIN_FRESH_SOURCES fresh
       → Store MedianRateSnapshot in rate_snapshots
  4. API responses now reflect updated rates
```

### Reputation Computation Flow

```
Every hour via Vercel cron:

  1. Load all anchors with at least 1 outcome
  2. For each anchor:
       a. Count outcomes in last 90 days
       b. If count < MIN_OUTCOMES_THRESHOLD:
            → state = "insufficient_data"
            → compositeScore = null
            → skip
       c. Compute rolling window metrics:
            fillRate7d   = completed[7d] / total[7d]
            fillRate30d  = completed[30d] / total[30d]
            settleP50Ms  = percentile(50, settlementMs[30d])
            settleP95Ms  = percentile(95, settlementMs[30d])
            slippageP50  = percentile(50, slippage[30d])
       d. compositeScore = (fillRate30d × 0.33)
                         + (speedScore  × 0.33)
                         + (slippageScore × 0.33)
       e. scoreBand:
            ≥ 95 → "green"
            80–94 → "amber"
            < 80  → "red"
       f. Upsert into reputation_scores
```

---

## Database Schema

```sql
-- Anchors: the core entity
CREATE TABLE anchors (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                TEXT UNIQUE NOT NULL,
  name                TEXT NOT NULL,
  home_domain         TEXT NOT NULL,
  toml_url            TEXT NOT NULL,
  seps                INTEGER[] NOT NULL DEFAULT '{}',
  is_transfer_capable BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL DEFAULT 'UNKNOWN',
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

-- Corridors: asset pair + country pair
CREATE TABLE corridors (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_code_from TEXT NOT NULL,   -- e.g. 'USDC'
  country_from    TEXT NOT NULL,   -- e.g. 'US'
  asset_code_to   TEXT NOT NULL,   -- e.g. 'NGN'
  country_to      TEXT NOT NULL,   -- e.g. 'NG'
  slug            TEXT UNIQUE NOT NULL  -- e.g. 'usdc-ng'
);

-- Junction: which anchors serve which corridors
CREATE TABLE anchor_corridors (
  anchor_id   TEXT REFERENCES anchors(id),
  corridor_id TEXT REFERENCES corridors(id),
  PRIMARY KEY (anchor_id, corridor_id)
);

-- Rate snapshots: one row per anchor per corridor per poll
CREATE TABLE rate_snapshots (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id           TEXT REFERENCES anchors(id),
  corridor_id         TEXT REFERENCES corridors(id),
  rate                FLOAT NOT NULL,
  source_amount       FLOAT NOT NULL,
  destination_amount  FLOAT NOT NULL,
  fee                 FLOAT NOT NULL DEFAULT 0,
  is_stale            BOOLEAN NOT NULL DEFAULT false,
  captured_at         TIMESTAMPTZ DEFAULT now()
);

-- Transfer outcomes: the reputation signal source
CREATE TABLE transfer_outcomes (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id     TEXT REFERENCES anchors(id),
  corridor_id   TEXT REFERENCES corridors(id),
  status        TEXT NOT NULL,  -- COMPLETED|PARTIAL|REFUNDED|EXPIRED|ERROR
  fill_rate     FLOAT NOT NULL,
  settlement_ms INTEGER NOT NULL,
  slippage      FLOAT NOT NULL,
  recorded_at   TIMESTAMPTZ DEFAULT now()
);

-- Reputation scores: precomputed per anchor, updated hourly
CREATE TABLE reputation_scores (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id       TEXT UNIQUE REFERENCES anchors(id),
  composite_score FLOAT,
  score_band      TEXT,          -- 'green' | 'amber' | 'red' | null
  fill_rate_7d    FLOAT,
  fill_rate_30d   FLOAT,
  fill_rate_90d   FLOAT,
  settle_p50_ms   INTEGER,
  settle_p95_ms   INTEGER,
  slippage_p50    FLOAT,
  slippage_p95    FLOAT,
  sample_size     INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'insufficient_data',
  computed_at     TIMESTAMPTZ DEFAULT now()
);
```

---

## Project Structure

```
stellarcore/
│
├── app/                                   # Next.js App Router
│   ├── layout.tsx                         # Root layout
│   ├── page.tsx                           # Landing page
│   ├── anchors/
│   │   ├── page.tsx                       # Anchor directory
│   │   └── [id]/page.tsx                  # Anchor profile
│   ├── corridors/
│   │   ├── page.tsx                       # Corridor explorer + world map
│   │   └── [corridorId]/page.tsx          # Corridor detail + rate table
│   ├── rates/
│   │   └── page.tsx                       # Live rate dashboard
│   ├── reputation/
│   │   └── page.tsx                       # Reputation leaderboard
│   └── api/
│       ├── anchors/
│       │   ├── route.ts                   # GET /api/anchors
│       │   └── [id]/route.ts              # GET /api/anchors/:id
│       ├── corridors/
│       │   ├── route.ts                   # GET /api/corridors
│       │   └── [id]/rates/route.ts        # GET /api/corridors/:id/rates
│       ├── rates/
│       │   └── route.ts                   # GET /api/rates?from=&to=
│       ├── reputation/
│       │   └── [anchorId]/route.ts        # GET /api/reputation/:anchorId
│       └── outcomes/
│           └── route.ts                   # POST /api/outcomes
│
├── components/
│   ├── landing/
│   │   ├── Hero.tsx                       # Hero section
│   │   ├── LiveRatesTicker.tsx            # Scrolling rate marquee
│   │   ├── HowItWorks.tsx                 # 3-step explainer
│   │   └── StatsCounter.tsx               # Animated stat counters
│   ├── anchors/
│   │   ├── AnchorGrid.tsx                 # Filterable anchor card grid
│   │   ├── AnchorCard.tsx                 # Single anchor card
│   │   └── AnchorProfile.tsx              # Full anchor detail view
│   ├── corridors/
│   │   ├── CorridorSelector.tsx           # Source + destination picker
│   │   ├── WorldMapSVG.tsx                # Interactive SVG world map
│   │   └── RateComparisonTable.tsx        # Side-by-side rate table
│   ├── reputation/
│   │   ├── ReputationGauge.tsx            # Circular score gauge
│   │   ├── ReputationLeaderboard.tsx      # Ranked anchor list
│   │   └── HistorySparkline.tsx           # 30-day score chart
│   └── ui/
│       ├── Navbar.tsx
│       ├── StatusBadge.tsx                # Live / Stale / Down
│       ├── ScoreBandBadge.tsx             # Green / Amber / Red
│       ├── CountUp.tsx                    # Animated number
│       └── MedianPriceDisplay.tsx         # Median + source breakdown
│
├── lib/
│   ├── stellar/
│   │   ├── client.ts                      # Stellar SDK setup
│   │   ├── anchors.ts                     # TOML parsing + classification
│   │   ├── sep38.ts                       # Live SEP-38 quote fetching
│   │   └── sep1.ts                        # TOML resolution
│   ├── reputation/
│   │   ├── score.ts                       # Composite score formula
│   │   ├── bands.ts                       # Score band classification
│   │   ├── aggregate.ts                   # Rolling window aggregation
│   │   └── thresholds.ts                  # MIN_OUTCOMES and config
│   ├── rates/
│   │   ├── median.ts                      # Staleness-aware median
│   │   ├── freshness.ts                   # Stale detection
│   │   └── normalize.ts                   # Cross-anchor normalization
│   └── db/
│       ├── client.ts                      # Prisma singleton
│       └── queries/
│           ├── anchors.ts
│           ├── rates.ts
│           └── reputation.ts
│
├── hooks/
│   ├── useLiveRates.ts                    # SWR polling hook
│   ├── useAnchorFilter.ts                 # Filter + sort state
│   └── useCountUp.ts                      # Animated number hook
│
├── types/
│   ├── anchor.ts                          # Anchor + SEP types
│   ├── corridor.ts                        # Corridor types
│   ├── rate.ts                            # Rate + freshness types
│   └── reputation.ts                      # Score + band types
│
├── constants/
│   ├── anchors.ts                         # Anchor registry with seps data
│   ├── corridors.ts                       # Supported corridor definitions
│   └── seps.ts                            # SEP number constants
│
├── prisma/
│   ├── schema.prisma                      # Full database schema
│   └── migrations/                        # Migration history
│
├── scripts/
│   ├── sync-anchors.ts                    # Daily: sync anchor TOMLs
│   ├── snapshot-rates.ts                  # 60s: snapshot live rates
│   └── compute-reputation.ts              # Hourly: recompute scores
│
├── tests/
│   ├── unit/
│   │   ├── reputation/                    # Score computation tests
│   │   └── rates/                         # Median + staleness tests
│   ├── integration/
│   │   └── api/                           # Route handler tests
│   └── e2e/
│       └── corridor-flow.spec.ts          # End-to-end corridor test
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                         # Test on every PR
│   │   ├── deploy.yml                     # Deploy on main merge
│   │   └── sync-anchors.yml               # Daily anchor sync cron
│   └── ISSUE_TEMPLATE/
│       ├── add-anchor.md
│       ├── add-corridor.md
│       └── bug-report.md
│
├── docs/
│   ├── architecture.md                    # Full architecture detail
│   ├── api-reference.md                   # API endpoint reference
│   ├── adding-anchors.md                  # Contributor guide
│   └── reputation-methodology.md          # Score formula in depth
│
├── .env.example
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── vitest.config.ts
├── playwright.config.ts
└── README.md
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Framework | Next.js 15 (App Router) | Full-stack React with API routes and SSR |
| Language | TypeScript (strict) | Type safety across the full stack |
| Styling | Tailwind CSS v4 | Utility-first, consistent design tokens |
| Database | PostgreSQL (Supabase) | Relational structure for rates and reputation |
| ORM | Prisma | Type-safe database queries |
| Data Fetching | SWR | Client-side polling with stale-while-revalidate |
| Blockchain | @stellar/stellar-sdk | SEP-1 TOML parsing, SEP-38 quotes |
| Testing | Vitest + Playwright | Unit, integration, and E2E coverage |
| Deployment | Vercel | Zero-config Next.js hosting with cron support |
| CI/CD | GitHub Actions | Test, build, deploy, and anchor sync |

---

## Environment Variables

```bash
# .env.example

# Stellar Network
NEXT_PUBLIC_STELLAR_NETWORK=mainnet
NEXT_PUBLIC_HORIZON_URL=https://horizon.stellar.org

# Database (Supabase or local Postgres)
DATABASE_URL=postgresql://user:password@localhost:5432/stellarcore

# Rate Engine
RATE_FRESHNESS_THRESHOLD_MS=120000
MIN_FRESH_SOURCES=2
RATE_SYNC_INTERVAL_MS=60000

# Reputation Engine
MIN_OUTCOMES_THRESHOLD=30
REPUTATION_WINDOW_DAYS=30

# Optional: Alerts
RESEND_API_KEY=
WEBHOOK_SECRET=

# Optional: Cron auth
CRON_SECRET=
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL 15+ (or a Supabase project)
- A Stellar account on testnet for development

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/stellarcore.git
cd stellarcore

# 2. Install dependencies
npm install

# 3. Set up environment variables
cp .env.example .env.local
# Fill in DATABASE_URL and Stellar config

# 4. Run database migrations
npx prisma migrate dev

# 5. Seed initial anchor data
npm run db:seed

# 6. Run the first anchor sync
npm run sync:anchors

# 7. Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Running Sync Jobs Locally

```bash
# Sync anchors from the Stellar network
npm run sync:anchors

# Snapshot live rates (normally runs on 60s cron)
npm run snapshot:rates

# Recompute all reputation scores
npm run compute:reputation
```

### Running Tests

```bash
# Unit and integration tests
npm test

# Type check only
npx tsc --noEmit

# Opt-in live SEP-10 verification against the official Stellar test anchor
npm run verify:sep10

# E2E tests
npm run test:e2e
```

`verify:sep10` generates an unfunded ephemeral authentication key in memory,
prints safe verification metadata only, and never prints or persists the secret
seed, challenge XDR, JWT, or Authorization header. It is not run by `npm test`,
the production build, or `postinstall`.

---

## API Reference

All endpoints return JSON. Rate-limited to 100 requests per minute per IP.

### `GET /api/anchors`

Returns all transfer-capable anchors with their current reputation.

```json
{
  "data": [
    {
      "id": "clx...",
      "slug": "moneygram",
      "name": "MoneyGram",
      "homeDomain": "moneygram.com",
      "seps": [1, 10, 6, 24],
      "isTransferCapable": true,
      "status": "LIVE",
      "reputation": {
        "compositeScore": 94.2,
        "scoreBand": "amber",
        "state": "ok",
        "sampleSize": 847
      }
    }
  ],
  "meta": {
    "total": 12,
    "computedAt": "2026-08-12T10:30:00Z"
  }
}
```

### `GET /api/rates?from=USDC&to=NGN`

Returns live rates for a corridor from all active anchors, with median.

```json
{
  "data": {
    "corridor": "usdc-ng",
    "median": 1612.50,
    "fallbackEngaged": false,
    "sources": [
      {
        "anchorId": "...",
        "anchorName": "MoneyGram",
        "rate": 1615.00,
        "isStale": false,
        "capturedAt": "2026-08-12T10:29:42Z"
      }
    ],
    "excludedSources": [
      {
        "anchorId": "...",
        "anchorName": "Cowrie",
        "reason": "stale",
        "capturedAt": "2026-08-12T10:27:11Z"
      }
    ]
  },
  "meta": {
    "freshSources": 3,
    "staleSources": 1,
    "computedAt": "2026-08-12T10:30:00Z"
  }
}
```

### `GET /api/reputation/:anchorId`

Returns the full reputation breakdown for a single anchor.

```json
{
  "data": {
    "anchorId": "...",
    "compositeScore": 94.2,
    "scoreBand": "amber",
    "state": "ok",
    "fillRate7d": 0.97,
    "fillRate30d": 0.94,
    "fillRate90d": 0.91,
    "settleP50Ms": 4200,
    "settleP95Ms": 12000,
    "slippageP50": 0.003,
    "slippageP95": 0.012,
    "sampleSize": 847,
    "computedAt": "2026-08-12T10:00:00Z"
  }
}
```

### `GET /api/corridors`

Returns all supported corridors with active anchor count.

### `POST /api/outcomes`

Records a transfer outcome to contribute to an anchor's reputation. Requires `WEBHOOK_SECRET` header authentication.

---

## Contributing

StellarCore is community-maintained. Every anchor, corridor, and feature addition is a welcome contribution.

### Adding an Anchor

1. Open an issue using the `add-anchor` template
2. Fork the repo and create a branch: `feat/add-anchor-[slug]`
3. Add the anchor to `constants/anchors.ts` with its `seps` array
4. Open a PR — CI will verify the TOML is reachable and the anchor classifies correctly

See [docs/adding-anchors.md](docs/adding-anchors.md) for the full guide.

### Adding a Corridor

1. Open an issue using the `add-corridor` template
2. Add the corridor definition to `constants/corridors.ts`
3. Confirm at least one active anchor supports the asset pair
4. Open a PR

### Code Contributions

- Fork the repo
- Create a branch off `main`
- Write tests for all new logic
- Ensure `npx tsc --noEmit` and `npm test` pass
- Open a PR with a clear description of the change

---

## Drips Wave

StellarCore participates in the Stellar Development Foundation's [Drips Wave](https://drips.network/wave) program. Community contributors can pick up open issues and earn points that convert to USDC rewards.

Browse open issues at [github.com/YOUR_USERNAME/stellarcore/issues](https://github.com/YOUR_USERNAME/stellarcore/issues) and filter by the `drips-wave` label.

### Issue Complexity Levels

| Label | Points | Example Issues |
|---|---|---|
| `complexity: trivial` | 100 | Add anchor, add corridor, fix typo, update anchor logo |
| `complexity: medium` | 150 | Add SEP-38 polling for anchor, write unit tests, add responsive layout |
| `complexity: high` | 200 | Reputation engine, rate aggregation, API rate limiting, corridor world map |

---

## Roadmap

- [x] Project architecture and database schema
- [x] README and documentation
- [ ] Prisma schema and initial migrations
- [ ] Anchor registry (`constants/anchors.ts`) with SEP data
- [ ] Anchor sync engine (SEP-1 TOML parser)
- [ ] SEP-38 rate polling and snapshot storage
- [ ] Staleness-aware median pricing (`lib/rates/median.ts`)
- [ ] `transferCapable()` classifier (`lib/stellar/anchors.ts`)
- [ ] Public REST API — `/api/anchors`, `/api/rates`, `/api/corridors`
- [ ] Reputation scoring engine (`lib/reputation/score.ts`)
- [ ] Reputation API — `/api/reputation/:anchorId`
- [ ] Next.js frontend — anchor directory
- [ ] Next.js frontend — corridor explorer
- [ ] Next.js frontend — live rate dashboard
- [ ] Next.js frontend — reputation leaderboard
- [ ] GitHub Actions cron for anchor sync
- [ ] GitHub Actions cron for rate snapshots
- [ ] Unit and E2E test suite
- [ ] Email and webhook alerts
- [ ] SCF application

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Acknowledgements

Built on knowledge earned contributing to [stellar-intel](https://github.com/ezedike-evan/stellar-intel), [Miracle656/Lens](https://github.com/Miracle656/Lens), and [stellar-hooks](https://github.com/dark-princezz/stellar-hooks).

Anchor data sourced from the Stellar network and the [lumenloop/stellar-ecosystem-db](https://github.com/lumenloop/stellar-ecosystem-db) registry.
