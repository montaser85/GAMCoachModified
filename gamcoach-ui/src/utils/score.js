/**
 * Shared approval-score display helpers.
 *
 * The approval decision keys off the TRUE probability (≥ 0.5). The displayed
 * "points" (probability × 100) must never CONTRADICT that decision: a plain
 * Math.round shows "50 points" for a probability in [0.495, 0.50) while the plan is
 * actually NOT approved. These helpers clamp the displayed number so it always
 * agrees with the status — a not-approved score never renders ≥ 50, and an approved
 * score never renders < 50.
 */

/** Approval threshold as a probability. */
export const APPROVAL_PROB = 0.5;
/** Approval threshold in displayed points. */
export const APPROVAL_POINTS = 50;

/** True when a probability meets the approval threshold. */
export function isApproved(prob) {
  return prob !== null && prob !== undefined && !Number.isNaN(prob) && prob >= APPROVAL_PROB;
}

/**
 * Convert an approval PROBABILITY (0–1) to the displayed points (0–100) that can
 * never contradict {@link isApproved}: not-approved (< 0.5) is capped at 49,
 * approved (≥ 0.5) is lifted to at least 50.
 * @param {number|null|undefined} prob
 * @returns {number|null} null when prob is null/undefined/NaN.
 */
export function approvalPoints(prob) {
  if (prob === null || prob === undefined || Number.isNaN(prob)) return null;
  const pts = Math.round(prob * 100);
  return prob >= APPROVAL_PROB ? Math.max(APPROVAL_POINTS, pts) : Math.min(APPROVAL_POINTS - 1, pts);
}
