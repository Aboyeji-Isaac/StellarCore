export type PublicReputationState =
  | "not_evaluated"
  | "insufficient_evidence"
  | "established";

export type PublicReputationScoreBand = "green" | "amber" | "red";

export type PublicReputationMetrics = Readonly<{
  fillRate7d: number | null;
  fillRate30d: number | null;
  fillRate90d: number | null;
  settleP50Ms: number | null;
  settleP95Ms: number | null;
  slippageP50: number | null;
  slippageP95: number | null;
}>;

export type PublicReputation = Readonly<{
  anchor: Readonly<{
    slug: string;
    name: string;
  }>;
  state: PublicReputationState;
  score: number | null;
  scoreBand: PublicReputationScoreBand | null;
  evidence: Readonly<{
    outcomeCount: number;
  }> | null;
  metrics: PublicReputationMetrics | null;
  computedAt: string | null;
}>;

export type PublicReputationListResponse = Readonly<{
  reputation: readonly PublicReputation[];
  count: number;
  limit: number;
  next?: string;
}>;

export type PublicReputationDetailResponse = Readonly<{
  reputation: PublicReputation;
}>;

export type ReputationApiErrorResponse = Readonly<{
  error: Readonly<{
    code: "invalid_anchor_slug" | "invalid_pagination_cursor" | "anchor_not_found" | "response_too_large" | "internal_error";
    message: string;
  }>;
}>;

export type ReputationApiListResult =
  | Readonly<{ status: 200; body: PublicReputationListResponse }>
  | Readonly<{ status: 400 | 413; body: ReputationApiErrorResponse }>
  | Readonly<{ status: 500; body: ReputationApiErrorResponse }>;

export type ReputationApiDetailResult =
  | Readonly<{ status: 200; body: PublicReputationDetailResponse }>
  | Readonly<{ status: 400 | 404 | 413 | 500; body: ReputationApiErrorResponse }>;
