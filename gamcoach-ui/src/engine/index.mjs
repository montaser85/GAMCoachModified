/**
 * Causal Propagation Engine — public surface.
 *
 * The engine operates purely in DISPLAY units over a plain state object keyed by
 * the model's internal feature names. Import `propagate` for the runtime and the
 * metadata exports (EDGES / LEAF_FEATURES / featureHasOutgoingEdges) for UI
 * concerns such as the linked-feature icon.
 */

// ── SINGLE CONDITION SWITCH ──────────────────────────────────────────────────
// The study runs ONE of two conditions. Two underlying behaviors must always move
// together, or a plan's displayed score and its guaranteed score diverge (a
// folded-guaranteed plan can display an un-folded score below 0.5, and vice-versa
// — the 49.51% "Approved" bug). Those behaviors are:
//   • load-time propagation of the coach's suggested changes  (DISPLAY: folded)
//   • the propagation-aware MILP DTI guarantee                (GENERATION: folded)
// This master switch is the ONLY place either is set; both flags below (and
// PROPAGATION_AWARE_DTI_CONSTRAINT in ebm/gamcoach.js, which imports this) derive
// from it, so a mismatched state is impossible.
//   true  → ADVANCED condition:  propagate at load (folded display) + folded guarantee
//   false → ORIGINAL condition:  no load-time propagation (un-folded display) + original algorithm
export const USE_ADVANCED_CONDITION = true;

// Derived — DO NOT set independently. When true, each plan runs the SAME
// causal-propagation engine on its coach-suggested changes at load, so dependent
// features display their propagated values immediately (instead of only after the
// user's first edit). Routed exclusively through this flag (see
// FeaturePanel.propagateSuggestedChangesAtLoad).
export const PROPAGATE_SUGGESTED_ON_LOAD = USE_ADVANCED_CONDITION;

export { propagate, DTI_WARN_THRESHOLD, FICO_WARN_THRESHOLD } from './engine.mjs';
export { EDGES, LEAF_FEATURES, computeDtiParts, DTI_USER_EDITS_ONLY } from './edges.mjs';
export { DEROG_BINS, derogRank, derogBin, derogAdd, derogSubtract } from './edges.mjs';
export {
  computeParams,
  masterFico,
  aprForPurpose,
  creditLimitFromBaseline,
  loanMonthlyPayment,
  increase,
  APR_BY_PURPOSE,
  DEFAULT_APR,
  MORTGAGE_HOME_VALUE,
  FICO_FLOOR,
  FICO_CEIL,
  MODEL_BOUNDS
} from './params.mjs';

import { EDGES } from './edges.mjs';

/** The 20 features the engine operates over (internal names). */
export const ALL_FEATURES = [
  'loan_amnt',
  'dti',
  'revol_bal',
  'open_acc',
  'fico_score',
  'term',
  'home_ownership',
  'purpose',
  'inq_last_6mths',
  'pub_rec_bankruptcies',
  'annual_inc',
  'earliest_cr_line',
  'revol_util',
  'total_acc',
  'emp_length',
  'verification_status',
  'delinq_2yrs',
  'pub_rec',
  'application_type',
  'mort_acc'
];

/**
 * True when editing `featureName` propagates to at least one dependent.
 * @param {string} featureName internal feature name
 * @returns {boolean}
 */
export function featureHasOutgoingEdges(featureName) {
  return Array.isArray(EDGES[featureName]) && EDGES[featureName].length > 0;
}

/**
 * The set of every feature that can be indirectly changed by some edge — i.e.
 * appears as a `dependent`. Useful for UI "this may change automatically" hints.
 * @returns {Set<string>}
 */
export function allDependentFeatures() {
  const deps = new Set();
  for (const list of Object.values(EDGES)) {
    for (const edge of list) deps.add(edge.dependent);
  }
  return deps;
}
