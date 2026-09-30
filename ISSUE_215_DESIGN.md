# Issue #215: Bounded Response-Cardinality and Memory Limits

## Executive Summary

Add cardinality and byte-size budgets to all public collection endpoints. Implement cursor-based pagination for list endpoints and response-size enforcement for detail endpoints. Ensure limits compose cleanly with existing rate limiting and request deadline handling.

## Public Collection Endpoints Requiring Bounds

### Unbounded List Endpoints (Require Pagination)
1. **GET /api/anchors** - Returns all anchors
2. **GET /api/corridors** - Returns all corridors
3. **GET /api/reputation** - Returns all anchors with reputation scores
4. **GET /api/rates?corridor=slug** - Returns all observations for one corridor

### Bounded Detail Endpoints (Require Response-Size Monitoring)
1. **GET /api/anchors/[slug]** - One anchor + all its corridors
2. **GET /api/corridors/[slug]** - One corridor + all its anchors
3. **GET /api/reputation/[slug]** - One anchor + reputation data

## Cardinality and Memory Budgets

### Per-Endpoint Limits

| Endpoint | Max Items | Max Serialized Bytes | Rationale |
|---|---:|---:|---|
| /api/anchors | 500 | 1 MB | Directory; expect 3-50 anchors in practice |
| /api/anchors/[slug] | N/A (1 anchor) | 100 KB | One anchor + related corridors (10-50 per anchor typical) |
| /api/corridors | 10,000 | 500 KB | Directory; expect 5-100 corridors in practice |
| /api/corridors/[slug] | N/A (1 corridor) | 100 KB | One corridor + all associated anchors |
| /api/rates?corridor=slug | 500 | 200 KB | One corridor observations; typically 1-10 anchors |
| /api/reputation | 500 | 500 KB | All anchors + optional scores |
| /api/reputation/[slug] | N/A (1 anchor) | 10 KB | Single anchor reputation |

**Assumptions:**
- Anchor name: ~20 bytes
- SEPs array: ~50 bytes (avg 5 SEPs × 2 bytes + formatting)
- Corridor slug: ~25 bytes
- Rate observation: ~400 bytes (fields + metadata)
- Reputation score: ~200 bytes (all metrics + state)

### Response-Size Enforcement Strategy

1. **Estimation-based rejection:** Before serialization, estimate byte size based on item count and average item size. Reject if over budget.
2. **Streaming with byte-counting:** For larger collections, count actual bytes during JSON serialization and truncate if necessary (optional future optimization).
3. **Pagination:** For list endpoints, expose `next` cursor and stop returning items when byte budget is exhausted.

## Pagination Design

### Cursor-Based Pagination

**Why cursors over offsets:**
- Stable across concurrent modifications (insert/delete don't affect cursor position)
- O(1) lookup by slug rather than O(N) offset traversal
- Lexicographic ordering ensures deterministic resumption

**Cursor Format:**
- Opaque, URL-safe string: `base64url(anchor_slug)` for simplicity
- Validates that slug exists in the result set before using as starting point
- Cursor points to *after* the named item (exclusive)

**Request Parameters:**
- `limit`: Number of items to return (default 100, max 500)
- `after`: Cursor to start from (optional; if absent, start at first item)

**Response Format:**
```json
{
  "anchors": [...],
  "count": 42,
  "limit": 100,
  "next": "..." // cursor or null if last page
}
```

### No-Pagination Detail Endpoints

Detail endpoints return at most one resource + bounded related data. Response-size limits are enforced at serialization time without pagination because:
- One anchor can have at most a few hundred corridors (bounded by data model)
- One corridor can have at most a few hundred anchors
- Rejection is safe for actual data; pagination would complicate API unnecessarily

If a single resource exceeds its byte budget (pathological case), return HTTP 413 with a safe error.

## Implementation Phases

### Phase 1: Pagination Foundation
1. Create `types/pagination.ts` with cursor validation and encoding utilities
2. Extend repository types to support `limit` and `after` parameters
3. Add pagination helpers (cursor encode/decode, limit validation)
4. Update /api/anchors to accept `limit` and `after` query params
5. Update /api/corridors to accept `limit` and `after` query params
6. Update /api/reputation to accept `limit` and `after` query params
7. Write cursor validation tests

### Phase 2: Response-Size Enforcement
1. Create `lib/api/responseSizeEnforcer.ts` with byte-budget utilities
2. Add response-size tests with large fixture data
3. Integrate size checking into list endpoints (preflight + actual)
4. Integrate size checking into detail endpoints
5. Add safe 413 responses for oversized results

### Phase 3: Rates Endpoint Pagination
1. Update /api/rates to accept `limit` and `after` for observations
2. Ensure rate freshness computation works with partial observation sets
3. Write tests for median stability with pagination

### Phase 4: Integration & Verification
1. Ensure pagination composes with rate limiting (#163)
2. Ensure pagination composes with request deadlines (#173)
3. Update README API reference documentation
4. Add integration tests with realistic fixture counts
5. Run full test suite; verify backward compatibility

## Design Decisions & Tradeoffs

### 1. Cursor Format: base64url-encoded slug vs. opaque token
**Decision:** Opaque base64url-encoded slug
- Pro: Deterministic, easily validated against actual data
- Pro: No server-side cursor storage required
- Pro: Slug ordering is globally consistent
- Con: Client can decode to see the slug (acceptable; slug is public)
- Alt: Opaque random token tied to database row ID (not adopted; requires server state)

### 2. Default Limit: 100 items
**Decision:** 100 items per page, max 500
- Pro: 100 is a widely recognized default (GitHub, AWS, etc.)
- Pro: Respects byte budgets for all endpoints
- Pro: Balances API chattiness and memory
- Con: Requires 5 requests to fetch 500 anchors (but production has ~3-10)

### 3. Response-Size Enforcement: Preflight vs. Streaming
**Decision:** Preflight estimation + optional streaming in future
- Phase 1: Estimate based on item count, reject before serialization
- Future: Stream JSON with byte counter; truncate mid-stream if needed
- Pro: Prevents memory overrun at serialization time
- Pro: Stable, testable error responses
- Con: Slight memory overhead for estimation logic (acceptable)

### 4. Detail Endpoints: No Pagination
**Decision:** Reject oversized detail responses with HTTP 413
- Pro: Simpler API surface; detail is expected to be bounded
- Pro: Matches common REST patterns (GET /resource returns complete resource)
- Con: Pathological case (one anchor with 1000 corridors) would fail
- Mitigation: Validate data model; architectural max should be ~500 corridors/anchor

### 5. Compatibility: Backward-Compatible Pagination
**Decision:** New `limit` and `after` params are optional
- Existing clients omitting them get all results (backward compatible) *up to byte budget*
- Once pagination is enforced, large result sets are truncated with `next` cursor
- Phase transition: Clients can adopt pagination at their own pace

## Testing Strategy

### Unit Tests
- Cursor encoding/decoding and validation
- Pagination parameter parsing and bounds checking
- Response-size estimation math
- Frozen object immutability

### Integration Tests
- Full repository + serialization with large fixtures (500 anchors, 100 corridors)
- Pagination traversal (first page, middle pages, last page)
- Cursor boundary cases (non-existent cursor, malformed cursor)
- Byte-size budgets verified against actual JSON length
- Rate freshness calculation with partial observation sets

### Load Tests
- Memory profiling with 1000-item fixtures
- Response time with large collections
- Parallelism under pagination load

## API Reference Updates

### GET /api/anchors
```
Query Parameters:
  limit: number (default 100, max 500)
  after: string (cursor, optional)

Response:
{
  anchors: [...],
  count: number,
  limit: number,
  next: string | null
}

Status Codes:
  200 OK
  400 Bad Request (invalid limit, invalid cursor)
  413 Payload Too Large (oversized response)
  500 Internal Server Error
```

### GET /api/corridors
(same structure as anchors)

### GET /api/reputation
(same structure as anchors)

### GET /api/rates?corridor=slug
```
Query Parameters:
  corridor: string (required)
  limit: number (default 100, max 500, optional)
  after: string (cursor for observations, optional)

Response includes:
  observations: [...]
  count: number
  limit: number
  next: string | null
```

### GET /api/anchors/[slug]
```
Response:
{
  anchor: {...}
}

Status Codes:
  200 OK
  400 Bad Request (invalid slug)
  413 Payload Too Large (oversized anchor + corridors)
  404 Not Found
  500 Internal Server Error
```

(Similar for /corridors/[slug] and /reputation/[slug])

## Dependencies & Ordering

- Does NOT depend on #57 (pagination design); parallel work is fine
- Extends rather than duplicates pagination patterns from #57
- Must not conflict with #163 (rate limiting) or #173 (request deadlines)
- Can be reviewed and merged independently

## Acceptance Criteria Verification

- [ ] All 7 public collection endpoints have documented cardinality budgets
- [ ] List endpoints return paginated responses with stable ordering
- [ ] Cursors are opaque, URL-safe, and validated
- [ ] Byte-size budgets are enforced via preflight checks
- [ ] Oversized responses fail safely with HTTP 413
- [ ] Detail endpoints reject pathological cases
- [ ] All existing small responses remain compatible
- [ ] Pagination composes with rate limiting and deadlines
- [ ] Unit and integration tests cover all edge cases
- [ ] README and inline code documentation updated
- [ ] Full test suite passes

## Timeline

- **Phase 1 (Pagination):** 2-3 hours
- **Phase 2 (Response-Size):** 1-2 hours
- **Phase 3 (Rates):** 1 hour
- **Phase 4 (Integration & Docs):** 1-2 hours

**Total:** 5-8 hours (High complexity issue, 200 points justified)

