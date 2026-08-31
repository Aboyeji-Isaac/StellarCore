export const REPUTATION_OUTCOME_WINDOW_DAYS = 90;
export const REPUTATION_METRICS_WINDOW_DAYS = 30;
export const MIN_REPUTATION_OUTCOMES = 30;

export const REPUTATION_WEIGHTS = Object.freeze({
  availability: 20,
  rateFreshness: 15,
  coverage: 15,
  transferReliability: 50,
} as const);

export const REPUTATION_BANDS = Object.freeze({
  greenMinimum: 95,
  amberMinimum: 80,
} as const);
