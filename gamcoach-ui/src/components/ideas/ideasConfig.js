// ─────────────────────────────────────────────────────────────────────────────
// "Ideas to try" — configuration (Task 5).
//
// Actionability (Gate 1) is decided from feature properties, expressed here as
// TWO SEPARATELY LABELED exclusion lists so behavior is auditable and safe to
// re-derive per dataset. A feature is in the baseline actionable set iff it is
// (a) directly user-editable, (b) not flagged immutable / very-hard, and (c) not
// derived (not exclusively a propagation target). The lists below encode that
// for LendingClub; recompute them for another dataset from its feature graph.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural exclusions — DERIVED FROM FEATURE PROPERTIES (recompute per dataset).
 * Derived features + propagation-target-only features + property-flagged
 * immutable / very-hard features. For LendingClub:
 *   - dti                  → derived (actionable parents: loan_amnt, annual_inc)
 *   - mort_acc             → propagation-target only (Number of Mortgages)
 *   - open_acc             → propagation-target only (Number of Open Accounts)
 *   - total_acc            → propagation-target only (Number of Accounts)
 *   - pub_rec              → immutable / very-hard (Number of Derogatory Records)
 *   - delinq_2yrs          → immutable / very-hard (Number of Past Due)
 *   - pub_rec_bankruptcies → immutable / very-hard (Number of Bankruptcies)
 *   - earliest_cr_line     → immutable / very-hard (Credit History Length)
 */
export const STRUCTURAL_EXCLUSIONS = new Set([
  'dti',
  'mort_acc',
  'open_acc',
  'total_acc',
  'pub_rec',
  'delinq_2yrs',
  'pub_rec_bankruptcies',
  'earliest_cr_line'
]);

/**
 * Policy overrides — LENDINGCLUB-SPECIFIC (do NOT carry to other datasets).
 * Technically editable, but intentionally not suggested.
 */
export const POLICY_OVERRIDES = new Set([
  'home_ownership',
  'inq_last_6mths',
  'emp_length',
  'verification_status'
]);

/**
 * Runtime exclusion (Gate 1, checked first): a feature whose difficulty the user
 * has set to "Impossible to Change" is excluded regardless of baseline
 * actionability. In this app that difficulty level is the 'lock' key
 * ("New plans won't change it").
 */
export const IMPOSSIBLE_TO_CHANGE = 'lock';

// ─────────────────────────────────────────────────────────────────────────────
// Speculative test-step sizes (Part 1). NAMED, TUNABLE parameters — expressed as
// a fraction of the feature's CURRENT value (scale-invariant, so one value works
// across features of very different magnitude: dollars, FICO points, percent).
// A feature sitting at ~0 falls back to a fraction of its display range. Defaults:
//   SMALL_STEP_FRACTION = 0.05  (a "small step" — 5% of the current value)
//   LARGE_STEP_FRACTION = 0.20  (a "larger step" — 20% of the current value)
// ─────────────────────────────────────────────────────────────────────────────
export const SMALL_STEP_FRACTION = 0.05;
export const LARGE_STEP_FRACTION = 0.2;

// Minimum propagated approval gain (probability) for a suggestion to be worth
// showing — filters negligible / no-effect features.
export const MIN_GAIN = 1e-4;

/**
 * Verb + direction wording. Numeric features say Lower / Raise per the required
 * direction; categorical features say Change (no target value, no magnitude).
 * @param {boolean} isCont
 * @param {'raise'|'lower'|'change'} direction
 */
export const ideaVerb = (isCont, direction) => {
  if (!isCont) return 'Change';
  return direction === 'raise' ? 'Raise' : 'Lower';
};

/**
 * Whether a feature is eligible for the baseline actionable set (before the
 * runtime "Impossible to Change" check, which is applied separately with live
 * difficulty state).
 * @param {string} name
 */
export const isBaselineActionable = (name) =>
  !STRUCTURAL_EXCLUSIONS.has(name) && !POLICY_OVERRIDES.has(name);
