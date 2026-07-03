/**
 * Causal Propagation Engine — public surface.
 *
 * The engine operates purely in DISPLAY units over a plain state object keyed by
 * the model's internal feature names. Import `propagate` for the runtime and the
 * metadata exports (EDGES / LEAF_FEATURES / featureHasOutgoingEdges) for UI
 * concerns such as the linked-feature icon.
 */

export { propagate, DTI_WARN_THRESHOLD, FICO_WARN_THRESHOLD } from './engine.mjs';
export { EDGES, LEAF_FEATURES } from './edges.mjs';
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
