import type {
  RateAlertEvaluationInput,
  RateAlertEvaluationResult,
} from "@/types/alerts";

export function evaluateRateChangeForAlert(
  input: RateAlertEvaluationInput,
  thresholdPercent = 1.0,
): RateAlertEvaluationResult {
  const { previousEvaluation, currentEvaluation } = input;

  if (!previousEvaluation) {
    return Object.freeze({
      shouldAlert: false,
      reason: "NO_PREVIOUS_EVALUATION",
    });
  }

  const evaluatedAt =
    currentEvaluation.evaluatedAt instanceof Date
      ? currentEvaluation.evaluatedAt.toISOString()
      : new Date(currentEvaluation.evaluatedAt).toISOString();

  const prevIsHealthy =
    previousEvaluation.state === "healthy" &&
    previousEvaluation.medianRate !== null;
  const currIsHealthy =
    currentEvaluation.state === "healthy" &&
    currentEvaluation.medianRate !== null;

  // Case 1: Both insufficient / no valid medians
  if (!prevIsHealthy && !currIsHealthy) {
    return Object.freeze({
      shouldAlert: false,
      reason: "BOTH_INSUFFICIENT_SOURCES",
    });
  }

  // Case 2: Transition from insufficient to healthy (Rate became available)
  if (!prevIsHealthy && currIsHealthy) {
    return Object.freeze({
      shouldAlert: true,
      changeType: "RATE_AVAILABLE",
      percentageChange: null,
      previousRate: previousEvaluation.medianRate,
      currentRate: currentEvaluation.medianRate,
      previousState: previousEvaluation.state,
      currentState: currentEvaluation.state,
      evaluatedAt,
    });
  }

  // Case 3: Transition from healthy to insufficient (Rate became unavailable)
  if (prevIsHealthy && !currIsHealthy) {
    return Object.freeze({
      shouldAlert: true,
      changeType: "RATE_UNAVAILABLE",
      percentageChange: null,
      previousRate: previousEvaluation.medianRate,
      currentRate: currentEvaluation.medianRate,
      previousState: previousEvaluation.state,
      currentState: currentEvaluation.state,
      evaluatedAt,
    });
  }

  // Case 4: Both healthy with published medians — evaluate rate movement
  const prevNum = Number.parseFloat(previousEvaluation.medianRate!);
  const currNum = Number.parseFloat(currentEvaluation.medianRate!);

  if (!Number.isFinite(prevNum) || !Number.isFinite(currNum) || prevNum <= 0) {
    return Object.freeze({
      shouldAlert: false,
      reason: "NO_RATE_CHANGE",
    });
  }

  const percentageChange = Math.abs((currNum - prevNum) / prevNum) * 100;

  if (percentageChange >= thresholdPercent) {
    return Object.freeze({
      shouldAlert: true,
      changeType: "RATE_MOVEMENT",
      percentageChange: Number.parseFloat(percentageChange.toFixed(4)),
      previousRate: previousEvaluation.medianRate,
      currentRate: currentEvaluation.medianRate,
      previousState: previousEvaluation.state,
      currentState: currentEvaluation.state,
      evaluatedAt,
    });
  }

  return Object.freeze({
    shouldAlert: false,
    reason: "BELOW_THRESHOLD",
  });
}
