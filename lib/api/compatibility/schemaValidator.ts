import type { ApiDomain } from "@/lib/api/compatibility/types";

export type SchemaValidationResult = Readonly<{
  ok: boolean;
  issues: readonly string[];
}>;

const BANNED_INTERNAL_FIELDS = new Set([
  "id",
  "_count",
  "tomlUrl",
  "lastSyncOrder",
  "createdAt",
  "updatedAt",
  "anchorId",
  "corridorId",
  "assetCodeFrom",
  "countryFrom",
  "assetCodeTo",
  "countryTo",
  "compositeScore",
  "sampleSize",
  "rawRate",
  "rawTimestamp",
  "formulaVersion",
  "privateKey",
  "secret",
  "cronSecret",
]);

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function isValidIsoDate(val: unknown): boolean {
  if (typeof val !== "string") return false;
  const parsed = Date.parse(val);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === val;
}

function checkDisallowedFields(
  record: Record<string, unknown>,
  allowedFields: Set<string>,
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    const fieldPath = path ? `${path}.${key}` : key;
    if (BANNED_INTERNAL_FIELDS.has(key)) {
      issues.push(`Internal-only field '${key}' leaked at '${fieldPath}'`);
    } else if (!allowedFields.has(key)) {
      issues.push(`Unrecognized or undocumented field '${key}' at '${fieldPath}'`);
    }
  }
}

// --- Anchors Domain ---

const ANCHOR_SUMMARY_ALLOWED = new Set([
  "slug",
  "name",
  "homeDomain",
  "status",
  "seps",
  "isTransferCapable",
  "corridorCount",
]);

const ANCHOR_CORRIDOR_ALLOWED = new Set([
  "slug",
  "sourceAsset",
  "sourceCountry",
  "destinationAsset",
  "destinationCountry",
]);

const ANCHOR_DETAIL_ALLOWED = new Set([
  "slug",
  "name",
  "homeDomain",
  "status",
  "seps",
  "isTransferCapable",
  "corridors",
]);

const VALID_ANCHOR_STATUSES = new Set(["LIVE", "DEGRADED", "DOWN", "UNKNOWN"]);

function validateAnchorSummary(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, ANCHOR_SUMMARY_ALLOWED, path, issues);

  if (typeof val.slug !== "string" || val.slug.length === 0) {
    issues.push(`Required field '${path}.slug' must be a non-empty string`);
  }
  if (typeof val.name !== "string" || val.name.length === 0) {
    issues.push(`Required field '${path}.name' must be a non-empty string`);
  }
  if (typeof val.homeDomain !== "string" || val.homeDomain.length === 0) {
    issues.push(`Required field '${path}.homeDomain' must be a non-empty string`);
  }
  if (typeof val.status !== "string" || !VALID_ANCHOR_STATUSES.has(val.status)) {
    issues.push(`Required field '${path}.status' must be one of: LIVE, DEGRADED, DOWN, UNKNOWN`);
  }
  if (!Array.isArray(val.seps) || !val.seps.every((s) => typeof s === "number" && Number.isInteger(s))) {
    issues.push(`Required field '${path}.seps' must be an array of integers`);
  }
  if (typeof val.isTransferCapable !== "boolean") {
    issues.push(`Required field '${path}.isTransferCapable' must be a boolean`);
  }
  if (typeof val.corridorCount !== "number" || !Number.isInteger(val.corridorCount) || val.corridorCount < 0) {
    issues.push(`Required field '${path}.corridorCount' must be a non-negative integer`);
  }
}

function validateAnchorCorridor(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, ANCHOR_CORRIDOR_ALLOWED, path, issues);

  for (const field of ["slug", "sourceAsset", "sourceCountry", "destinationAsset", "destinationCountry"]) {
    if (typeof val[field] !== "string" || (val[field] as string).length === 0) {
      issues.push(`Required field '${path}.${field}' must be a non-empty string`);
    }
  }
}

export function validateAnchorsPayload(payload: unknown, isDetail: boolean): SchemaValidationResult {
  const issues: string[] = [];
  if (!isObject(payload)) {
    return { ok: false, issues: ["Response body must be an object"] };
  }

  if (isDetail) {
    checkDisallowedFields(payload, new Set(["anchor"]), "$", issues);
    if (!isObject(payload.anchor)) {
      issues.push("Required top-level field 'anchor' must be an object");
      return { ok: false, issues };
    }
    const anchor = payload.anchor;
    checkDisallowedFields(anchor, ANCHOR_DETAIL_ALLOWED, "anchor", issues);
    if (typeof anchor.slug !== "string") issues.push("Required field 'anchor.slug' must be a string");
    if (typeof anchor.name !== "string") issues.push("Required field 'anchor.name' must be a string");
    if (typeof anchor.homeDomain !== "string") issues.push("Required field 'anchor.homeDomain' must be a string");
    if (typeof anchor.status !== "string" || !VALID_ANCHOR_STATUSES.has(anchor.status)) {
      issues.push("Required field 'anchor.status' must be a valid status");
    }
    if (!Array.isArray(anchor.seps)) issues.push("Required field 'anchor.seps' must be an array");
    if (typeof anchor.isTransferCapable !== "boolean") {
      issues.push("Required field 'anchor.isTransferCapable' must be a boolean");
    }
    if (!Array.isArray(anchor.corridors)) {
      issues.push("Required field 'anchor.corridors' must be an array");
    } else {
      anchor.corridors.forEach((c, idx) => validateAnchorCorridor(c, `anchor.corridors[${idx}]`, issues));
    }
  } else {
    checkDisallowedFields(payload, new Set(["anchors", "count"]), "$", issues);
    if (!Array.isArray(payload.anchors)) {
      issues.push("Required top-level field 'anchors' must be an array");
    } else {
      payload.anchors.forEach((a, idx) => validateAnchorSummary(a, `anchors[${idx}]`, issues));
    }
    if (typeof payload.count !== "number" || !Number.isInteger(payload.count) || payload.count < 0) {
      issues.push("Required top-level field 'count' must be a non-negative integer");
    } else if (Array.isArray(payload.anchors) && payload.count !== payload.anchors.length) {
      issues.push(`Field 'count' (${payload.count}) does not match anchors array length (${payload.anchors.length})`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// --- Corridors Domain ---

const CORRIDOR_SUMMARY_ALLOWED = new Set([
  "slug",
  "sourceAsset",
  "sourceCountry",
  "destinationAsset",
  "destinationCountry",
  "anchorCount",
]);

const CORRIDOR_DETAIL_ALLOWED = new Set([
  "slug",
  "sourceAsset",
  "sourceCountry",
  "destinationAsset",
  "destinationCountry",
  "anchorCount",
  "anchors",
]);

const CORRIDOR_ANCHOR_ALLOWED = new Set([
  "slug",
  "name",
  "homeDomain",
  "status",
  "seps",
  "isTransferCapable",
]);

function validateCorridorFields(val: Record<string, unknown>, path: string, issues: string[]): void {
  for (const field of ["slug", "sourceAsset", "sourceCountry", "destinationAsset", "destinationCountry"]) {
    if (typeof val[field] !== "string" || (val[field] as string).length === 0) {
      issues.push(`Required field '${path}.${field}' must be a non-empty string`);
    }
  }
  if (typeof val.anchorCount !== "number" || !Number.isInteger(val.anchorCount) || val.anchorCount < 0) {
    issues.push(`Required field '${path}.anchorCount' must be a non-negative integer`);
  }
}

function validateCorridorSummary(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, CORRIDOR_SUMMARY_ALLOWED, path, issues);
  validateCorridorFields(val, path, issues);
}

function validateCorridorAnchor(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, CORRIDOR_ANCHOR_ALLOWED, path, issues);

  if (typeof val.slug !== "string") issues.push(`Required field '${path}.slug' must be a string`);
  if (typeof val.name !== "string") issues.push(`Required field '${path}.name' must be a string`);
  if (typeof val.homeDomain !== "string") issues.push(`Required field '${path}.homeDomain' must be a string`);
  if (typeof val.status !== "string" || !VALID_ANCHOR_STATUSES.has(val.status)) {
    issues.push(`Required field '${path}.status' must be a valid status`);
  }
  if (!Array.isArray(val.seps)) issues.push(`Required field '${path}.seps' must be an array`);
  if (typeof val.isTransferCapable !== "boolean") {
    issues.push(`Required field '${path}.isTransferCapable' must be a boolean`);
  }
}

export function validateCorridorsPayload(payload: unknown, isDetail: boolean): SchemaValidationResult {
  const issues: string[] = [];
  if (!isObject(payload)) {
    return { ok: false, issues: ["Response body must be an object"] };
  }

  if (isDetail) {
    checkDisallowedFields(payload, new Set(["corridor"]), "$", issues);
    if (!isObject(payload.corridor)) {
      issues.push("Required top-level field 'corridor' must be an object");
      return { ok: false, issues };
    }
    const corridor = payload.corridor;
    checkDisallowedFields(corridor, CORRIDOR_DETAIL_ALLOWED, "corridor", issues);
    validateCorridorFields(corridor, "corridor", issues);
    if (!Array.isArray(corridor.anchors)) {
      issues.push("Required field 'corridor.anchors' must be an array");
    } else {
      corridor.anchors.forEach((a, idx) => validateCorridorAnchor(a, `corridor.anchors[${idx}]`, issues));
    }
  } else {
    checkDisallowedFields(payload, new Set(["corridors", "count"]), "$", issues);
    if (!Array.isArray(payload.corridors)) {
      issues.push("Required top-level field 'corridors' must be an array");
    } else {
      payload.corridors.forEach((c, idx) => validateCorridorSummary(c, `corridors[${idx}]`, issues));
    }
    if (typeof payload.count !== "number" || !Number.isInteger(payload.count) || payload.count < 0) {
      issues.push("Required top-level field 'count' must be a non-negative integer");
    } else if (Array.isArray(payload.corridors) && payload.count !== payload.corridors.length) {
      issues.push(`Field 'count' (${payload.count}) does not match corridors array length (${payload.corridors.length})`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// --- Rates Domain ---

const RATES_ALLOWED = new Set([
  "corridor",
  "evaluatedAt",
  "state",
  "medianRate",
  "sourceCount",
  "freshSourceCount",
  "reviewedCandidateConfiguration",
  "medianRequirement",
  "observations",
  "degraded",
]);

const RATES_OBSERVATION_ALLOWED = new Set([
  "anchor",
  "rate",
  "sourceAmount",
  "destinationAmount",
  "fee",
  "capturedAt",
  "freshness",
  "eligibleForMedian",
  "exclusionReason",
]);

const DEGRADED_ALLOWED = new Set(["state", "generatedAt", "expiresAt", "sourceTimes"]);

function validateDegradedMetadata(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, DEGRADED_ALLOWED, path, issues);
  if (val.state !== "stale") issues.push(`Field '${path}.state' must be 'stale'`);
  if (!isValidIsoDate(val.generatedAt)) issues.push(`Field '${path}.generatedAt' must be valid ISO timestamp`);
  if (!isValidIsoDate(val.expiresAt)) issues.push(`Field '${path}.expiresAt' must be valid ISO timestamp`);
  if (!Array.isArray(val.sourceTimes) || !val.sourceTimes.every(isValidIsoDate)) {
    issues.push(`Field '${path}.sourceTimes' must be an array of ISO timestamps`);
  }
}

function validateRateObservation(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, RATES_OBSERVATION_ALLOWED, path, issues);

  if (!isObject(val.anchor) || typeof val.anchor.slug !== "string" || typeof val.anchor.name !== "string") {
    issues.push(`Required field '${path}.anchor' must be an object with slug and name`);
  }
  for (const field of ["rate", "sourceAmount", "destinationAmount", "fee"]) {
    if (typeof val[field] !== "string") {
      issues.push(`Required field '${path}.${field}' must be a decimal string`);
    }
  }
  if (!isValidIsoDate(val.capturedAt)) {
    issues.push(`Required field '${path}.capturedAt' must be a valid ISO timestamp`);
  }
  if (!isObject(val.freshness) || typeof val.freshness.state !== "string") {
    issues.push(`Required field '${path}.freshness' must be an object with state`);
  }
  if (typeof val.eligibleForMedian !== "boolean") {
    issues.push(`Required field '${path}.eligibleForMedian' must be a boolean`);
  }

  // Documented semantics for exclusionReason:
  // Must NOT be present when eligibleForMedian is true.
  if (val.eligibleForMedian === true && "exclusionReason" in val && val.exclusionReason !== undefined) {
    issues.push(`Optional field '${path}.exclusionReason' must not be present when eligibleForMedian is true`);
  }
  if (val.eligibleForMedian === false && "exclusionReason" in val && val.exclusionReason !== undefined) {
    if (typeof val.exclusionReason !== "string") {
      issues.push(`Optional field '${path}.exclusionReason' must be a string when present`);
    }
  }
}

export function validateRatesPayload(payload: unknown): SchemaValidationResult {
  const issues: string[] = [];
  if (!isObject(payload)) {
    return { ok: false, issues: ["Response body must be an object"] };
  }

  checkDisallowedFields(payload, RATES_ALLOWED, "$", issues);

  if (!isObject(payload.corridor)) {
    issues.push("Required top-level field 'corridor' must be an object");
  } else {
    for (const field of ["slug", "sourceAsset", "sourceCountry", "destinationAsset", "destinationCountry"]) {
      if (typeof payload.corridor[field] !== "string") {
        issues.push(`Required field 'corridor.${field}' must be a string`);
      }
    }
  }

  if (!isValidIsoDate(payload.evaluatedAt)) {
    issues.push("Required top-level field 'evaluatedAt' must be a valid ISO timestamp");
  }

  if (payload.state !== "healthy" && payload.state !== "insufficient_fresh_sources") {
    issues.push("Required field 'state' must be 'healthy' or 'insufficient_fresh_sources'");
  }

  // Documented semantics for medianRate:
  if (payload.state === "healthy") {
    if (typeof payload.medianRate !== "string" || payload.medianRate.length === 0) {
      issues.push("When state is 'healthy', 'medianRate' must be a non-empty decimal string");
    }
  } else if (payload.state === "insufficient_fresh_sources") {
    if (payload.medianRate !== null) {
      issues.push("When state is 'insufficient_fresh_sources', 'medianRate' must be null");
    }
  }

  if (typeof payload.sourceCount !== "number" || payload.sourceCount < 0) {
    issues.push("Required field 'sourceCount' must be a non-negative integer");
  }
  if (typeof payload.freshSourceCount !== "number" || payload.freshSourceCount < 0) {
    issues.push("Required field 'freshSourceCount' must be a non-negative integer");
  }

  if (!isObject(payload.reviewedCandidateConfiguration)) {
    issues.push("Required field 'reviewedCandidateConfiguration' must be an object");
  } else {
    if (typeof payload.reviewedCandidateConfiguration.candidateCount !== "number") {
      issues.push("Required field 'reviewedCandidateConfiguration.candidateCount' must be a number");
    }
    if (typeof payload.reviewedCandidateConfiguration.uniqueAnchorCount !== "number") {
      issues.push("Required field 'reviewedCandidateConfiguration.uniqueAnchorCount' must be a number");
    }
  }

  if (!isObject(payload.medianRequirement) || typeof payload.medianRequirement.minimumFreshIndependentSources !== "number") {
    issues.push("Required field 'medianRequirement.minimumFreshIndependentSources' must be a number");
  }

  if (!Array.isArray(payload.observations)) {
    issues.push("Required field 'observations' must be an array");
  } else {
    payload.observations.forEach((o, idx) => validateRateObservation(o, `observations[${idx}]`, issues));
  }

  if ("degraded" in payload && payload.degraded !== undefined) {
    validateDegradedMetadata(payload.degraded, "degraded", issues);
  }

  return { ok: issues.length === 0, issues };
}

// --- Reputation Domain ---

const REPUTATION_LIST_ALLOWED = new Set(["reputation", "count", "degraded"]);
const REPUTATION_DETAIL_ALLOWED = new Set(["reputation", "degraded"]);

const REPUTATION_OBJECT_ALLOWED = new Set([
  "anchor",
  "state",
  "score",
  "scoreBand",
  "evidence",
  "metrics",
  "computedAt",
]);

const REPUTATION_METRICS_ALLOWED = new Set([
  "fillRate7d",
  "fillRate30d",
  "fillRate90d",
  "settleP50Ms",
  "settleP95Ms",
  "slippageP50",
  "slippageP95",
]);

const VALID_REPUTATION_STATES = new Set(["established", "insufficient_evidence", "not_evaluated"]);
const VALID_SCORE_BANDS = new Set(["green", "amber", "red"]);

function validateReputationObject(val: unknown, path: string, issues: string[]): void {
  if (!isObject(val)) {
    issues.push(`Expected object at '${path}', got ${typeof val}`);
    return;
  }
  checkDisallowedFields(val, REPUTATION_OBJECT_ALLOWED, path, issues);

  if (!isObject(val.anchor) || typeof val.anchor.slug !== "string" || typeof val.anchor.name !== "string") {
    issues.push(`Required field '${path}.anchor' must be an object with slug and name`);
  }

  if (typeof val.state !== "string" || !VALID_REPUTATION_STATES.has(val.state)) {
    issues.push(`Required field '${path}.state' must be established, insufficient_evidence, or not_evaluated`);
    return;
  }

  // Documented semantics based on reputation state:
  if (val.state === "not_evaluated") {
    if (val.score !== null) issues.push(`When state is 'not_evaluated', '${path}.score' must be null`);
    if (val.scoreBand !== null) issues.push(`When state is 'not_evaluated', '${path}.scoreBand' must be null`);
    if (val.evidence !== null) issues.push(`When state is 'not_evaluated', '${path}.evidence' must be null`);
    if (val.metrics !== null) issues.push(`When state is 'not_evaluated', '${path}.metrics' must be null`);
    if (val.computedAt !== null) issues.push(`When state is 'not_evaluated', '${path}.computedAt' must be null`);
  } else if (val.state === "insufficient_evidence") {
    if (val.score !== null) issues.push(`When state is 'insufficient_evidence', '${path}.score' must be null`);
    if (val.scoreBand !== null) issues.push(`When state is 'insufficient_evidence', '${path}.scoreBand' must be null`);
    if (val.evidence !== null) {
      if (!isObject(val.evidence) || typeof val.evidence.outcomeCount !== "number") {
        issues.push(`When present, '${path}.evidence' must be an object with outcomeCount`);
      }
    }
    if (val.metrics !== null) {
      if (!isObject(val.metrics)) {
        issues.push(`When present, '${path}.metrics' must be an object`);
      } else {
        checkDisallowedFields(val.metrics, REPUTATION_METRICS_ALLOWED, `${path}.metrics`, issues);
      }
    }
  } else if (val.state === "established") {
    if (typeof val.score !== "number" || val.score < 0 || val.score > 100) {
      issues.push(`When state is 'established', '${path}.score' must be a number between 0 and 100`);
    }
    if (typeof val.scoreBand !== "string" || !VALID_SCORE_BANDS.has(val.scoreBand)) {
      issues.push(`When state is 'established', '${path}.scoreBand' must be 'green', 'amber', or 'red'`);
    }
    if (!isObject(val.evidence) || typeof val.evidence.outcomeCount !== "number") {
      issues.push(`When state is 'established', '${path}.evidence' must be an object with outcomeCount`);
    }
    if (!isObject(val.metrics)) {
      issues.push(`When state is 'established', '${path}.metrics' must be an object`);
    } else {
      checkDisallowedFields(val.metrics, REPUTATION_METRICS_ALLOWED, `${path}.metrics`, issues);
    }
    if (!isValidIsoDate(val.computedAt)) {
      issues.push(`When state is 'established', '${path}.computedAt' must be a valid ISO timestamp`);
    }
  }
}

export function validateReputationPayload(payload: unknown, isDetail: boolean): SchemaValidationResult {
  const issues: string[] = [];
  if (!isObject(payload)) {
    return { ok: false, issues: ["Response body must be an object"] };
  }

  if (isDetail) {
    checkDisallowedFields(payload, REPUTATION_DETAIL_ALLOWED, "$", issues);
    validateReputationObject(payload.reputation, "reputation", issues);
  } else {
    checkDisallowedFields(payload, REPUTATION_LIST_ALLOWED, "$", issues);
    if (!Array.isArray(payload.reputation)) {
      issues.push("Required top-level field 'reputation' must be an array");
    } else {
      payload.reputation.forEach((r, idx) => validateReputationObject(r, `reputation[${idx}]`, issues));
    }
    if (typeof payload.count !== "number" || payload.count < 0) {
      issues.push("Required top-level field 'count' must be a non-negative integer");
    } else if (Array.isArray(payload.reputation) && payload.count !== payload.reputation.length) {
      issues.push(`Field 'count' (${payload.count}) does not match reputation array length (${payload.reputation.length})`);
    }
  }

  if ("degraded" in payload && payload.degraded !== undefined) {
    validateDegradedMetadata(payload.degraded, "degraded", issues);
  }

  return { ok: issues.length === 0, issues };
}

// --- Error Response Validation ---

const ERROR_ALLOWED = new Set(["error"]);
const ERROR_BODY_ALLOWED = new Set(["code", "message"]);

export function validateErrorPayload(payload: unknown): SchemaValidationResult {
  const issues: string[] = [];
  if (!isObject(payload)) {
    return { ok: false, issues: ["Error response must be an object"] };
  }
  checkDisallowedFields(payload, ERROR_ALLOWED, "$", issues);
  if (!isObject(payload.error)) {
    issues.push("Error response must contain an 'error' object");
    return { ok: false, issues };
  }
  checkDisallowedFields(payload.error, ERROR_BODY_ALLOWED, "error", issues);
  if (typeof payload.error.code !== "string" || payload.error.code.length === 0) {
    issues.push("Required field 'error.code' must be a non-empty string");
  }
  if (typeof payload.error.message !== "string" || payload.error.message.length === 0) {
    issues.push("Required field 'error.message' must be a non-empty string");
  }
  return { ok: issues.length === 0, issues };
}

// --- General Dispatcher ---

export function validateEvidenceSchema(
  domain: ApiDomain,
  status: number,
  body: unknown,
  isDetail = false,
): SchemaValidationResult {
  if (status !== 200) {
    return validateErrorPayload(body);
  }

  switch (domain) {
    case "anchors":
      return validateAnchorsPayload(body, isDetail);
    case "corridors":
      return validateCorridorsPayload(body, isDetail);
    case "rates":
      return validateRatesPayload(body);
    case "reputation":
      return validateReputationPayload(body, isDetail);
  }
}
