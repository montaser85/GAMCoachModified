/**
 * Causal Propagation Engine — Declarative Edge Set (Brief Section 5)
 *
 * The dependency graph is kept as DATA, not control flow. Each edge is a row:
 *   { dependent, tag, phase, rule }
 * grouped under the edited feature that owns the outgoing edge.
 *
 *   tag   — 'E' exact | 'C' conservative | 'A' approximate (carried through
 *           for logging / explainability, per the brief).
 *   phase — 'structural' (account counts / two-way balances) or 'value'
 *           (FICO / DTI). Structural writes are staged first so the shared
 *           parameters (hard-inquiry counter) see the updated counts before the
 *           FICO / DTI rules read them. This keeps parameters computed ONCE per
 *           pass while respecting topological order.
 *   rule  — pure function (state, params) => value, where `state` is the
 *           working (post-edit) vector and `params` carries `.baseline` plus
 *           every Section-4 value.
 *
 * IMPORTANT: every multi-effect edge (Home Ownership, Number of Mortgages,
 * Revolving Balance / Credit Utilization) enumerates its FULL direct target set
 * here. Propagation is therefore single-hop by design — the engine never
 * re-walks a dependent's own outgoing edges, which is what prevents the
 * mortgage/open double-count and the two-way-pair cycle.
 *
 * Only the edges in Brief Section 5 exist. Every exclusion in Section 6 is
 * realised as an ABSENT edge (e.g. DTI and FICO have no outgoing edges; a loan
 * amount edit never touches revolving balance).
 */

import {
  masterFico,
  MORTGAGE_HOME_VALUE,
  loanMonthlyPayment,
  aprForPurpose
} from './params.mjs';

const REVOL_DTI_FACTOR = 0.02; // 2%-of-delta on revolving balance change

// ── DTI_USER_EDITS_ONLY — single gate ──────────────────────────────────────
// Determines which inputs feed the DTI recompute:
//   true  -> a feature contributes to DTI only if the user actively edited it
//            (its name is in params.modifiedFeatures). Unedited features — even
//            when they display a suggested value — use their profile baseline,
//            so an untouched suggested loan is NOT folded into DTI.
//   false -> every current value feeds DTI (the prior "all current values"
//            behavior).
// Flip this ONE constant to revert. When params.modifiedFeatures is absent the
// gate also falls back to "all current values" (used by the engine tests).
export const DTI_USER_EDITS_ONLY = true;

// ── DTI — single full-state function ───────────────────────────────────────
// DTI ALWAYS recomputes from the full current state of every input, never from
// only the feature that just changed. Whichever DTI input is edited (loan
// amount, term, purpose, revolving balance, credit utilization, or income),
// DTI settles from all of them together:
//
//   New Monthly Debt = Base Monthly Debt               (fixed, from profile DTI)
//                    + Applied Loan Payment            (current loan/term/purpose)
//                    + (Current Revol Bal − Profile Revol Bal) × 2%
//   New DTI          = New Monthly Debt / New Monthly Income × 100
//
// The applied loan is always part of DTI, so e.g. editing revolving balance
// still includes the current loan's payment. `state.revol_bal` is the live
// balance — for a credit-utilization edit it is the balance just derived from
// the recovered credit limit (set in the structural phase before this runs),
// which naturally falls back to the profile balance (zero delta) when the
// limit is indeterminate.
/**
 * Decompose DTI into its parts, honoring the DTI_USER_EDITS_ONLY gate. Every DTI
 * path (the `dti` edge below and the UI breakdown popup) goes through here, so
 * the gate lives in exactly one place.
 *
 * @param {object} state   current feature vector (post-edit / post-structural)
 * @param {object} params  from computeParams (carries baseline, modifiedFeatures)
 * @returns {{baseDebt:number, loanPayment:number, revolDelta:number,
 *            monthlyIncome:number, newMonthlyDebt:number, newDti:number,
 *            loanEngaged:boolean, revolEngaged:boolean, loanAmount:number,
 *            loanPurpose:string, paymentPeriod:number, revolvingBalance:number,
 *            creditUtilization:number}}
 */
export function computeDtiParts(state, params) {
  const base = params.baseline;
  const mod = params.modifiedFeatures;
  // Gate: with the flag on, a feature is "engaged" only if the user edited it;
  // otherwise (flag off, or no modified set supplied) every feature is engaged.
  const isEdited = (f) => !DTI_USER_EDITS_ONLY || !mod || mod.has(f);

  // Base debt is always reconstructed once from profile DTI and profile income.
  const baseDebt = params.currentMonthlyDebtPayment;

  // Loan row: engaged when the user edited the Loan Amount, Loan Purpose, or
  // Payment Period (any of the three sets the loan's monthly payment). When
  // engaged, the payment uses the loan's current terms (what the cards show).
  const loanEngaged =
    isEdited('loan_amnt') || isEdited('purpose') || isEdited('term');
  const loanAmount = state.loan_amnt || 0;
  const loanPurpose = state.purpose;
  const paymentPeriod = state.term || 0;
  const loanPayment = loanEngaged
    ? loanMonthlyPayment(loanAmount, aprForPurpose(loanPurpose) / 12, paymentPeriod)
    : 0;

  // Revolving row: engaged when the user edited Revolving Balance or Credit
  // Utilization (utilization drives the balance).
  const revolEngaged = isEdited('revol_bal') || isEdited('revol_util');
  const revolvingBalance = revolEngaged ? (state.revol_bal || 0) : (base.revol_bal || 0);
  const revolDelta = (revolvingBalance - (base.revol_bal || 0)) * REVOL_DTI_FACTOR;

  // Income affects the denominator only if Income was edited.
  const monthlyIncome =
    ((isEdited('annual_inc') ? state.annual_inc : base.annual_inc) || 0) / 12;

  const newMonthlyDebt = baseDebt + loanPayment + revolDelta;
  const newDti = monthlyIncome ? (newMonthlyDebt / monthlyIncome) * 100 : base.dti;

  return {
    baseDebt,
    loanPayment,
    revolDelta,
    monthlyIncome,
    newMonthlyDebt,
    newDti,
    loanEngaged,
    revolEngaged,
    loanAmount,
    loanPurpose,
    paymentPeriod,
    revolvingBalance,
    creditUtilization: revolEngaged ? (state.revol_util || 0) : (base.revol_util || 0)
  };
}

function dtiFull(state, params) {
  return computeDtiParts(state, params).newDti;
}

// ── Two-way pair: Revolving Balance <-> Credit Utilization (Brief Sec 5/7) ──
// New Util = New Bal / Credit Limit * 100. Limit indeterminate => hold util.
function revolUtilFromBal(state, params) {
  if (params.creditLimit === null) return params.baseline.revol_util;
  return ((state.revol_bal || 0) / params.creditLimit) * 100;
}

// Inverse: New Bal = New Util / 100 * Credit Limit. Limit indeterminate => hold.
function revolBalFromUtil(state, params) {
  if (params.creditLimit === null) return params.baseline.revol_bal;
  return ((state.revol_util || 0) / 100) * params.creditLimit;
}

// ── Account counters — sum ALL contributions ───────────────────────────────
// Number of Open Accounts and Number of Accounts are BOTH recomputed as
//   profile + the user's manual Open-Accounts delta + the mortgage delta
// on every source change, so no single source overwrites the others.
//   openDelta = the user's manual change to Open Accounts (excluding the
//     mortgage-driven part). For a direct Open Accounts edit it is read from
//     the edited value; otherwise it is the tracked value the caller supplies
//     (params.userOpenDelta).
//   mortDelta = current mortgage count − profile mortgage count (already
//     reflects both Home Ownership → Mortgage and direct mortgage edits).
function mortgageDeltaOf(state, params) {
  return Math.max(0, (state.mort_acc || 0) - (params.baseline.mort_acc || 0));
}
function manualOpenDelta(state, params) {
  if (params.editedFeature === 'open_acc') {
    // The just-edited Open Accounts value minus the mortgage-driven part.
    return (state.open_acc || 0) - (params.baseline.open_acc || 0) - mortgageDeltaOf(state, params);
  }
  return params.userOpenDelta || 0;
}
function openAccountsValue(state, params) {
  return Math.max(
    0,
    (params.baseline.open_acc || 0) + manualOpenDelta(state, params) + mortgageDeltaOf(state, params)
  );
}
function totalAccountsValue(state, params) {
  // Number of Accounts sums ALL contributions, and manual deltas are SIGNED —
  // both the user's OWN direct edit (params.userTotalDelta) and the manual open
  // delta may be negative, so a downward edit on either lowers the total. Only
  // the mortgage (source) delta is floored at 0. The Total >= Open bound is
  // enforced by the engine guard, not here.
  const accountsManual = params.userTotalDelta || 0;
  return Math.max(
    0,
    (params.baseline.total_acc || 0) +
      accountsManual +
      manualOpenDelta(state, params) +
      mortgageDeltaOf(state, params)
  );
}

// ── Home Ownership -> Mortgage transition (Brief Section 5) ────────────────
// Home Ownership contributes exactly +1 to mortgages and to both account
// counters while it is set to "Mortgage" (relative to a non-mortgage profile).
// Crucially it ADDS or REMOVES only its own single contribution against the
// LIVE count — it never resets the counter to the profile — so the user's
// manual edits to the count persist across Home Ownership changes.
//   params.appliedHomeMortgage = the +1 the home currently has baked into the
//   live count (0 or 1). We swap it for the new contribution.
function isMortgageTransition(state, params) {
  return (
    state.home_ownership === MORTGAGE_HOME_VALUE &&
    params.baseline.home_ownership !== MORTGAGE_HOME_VALUE
  );
}
function homeCountAfterTransition(currentValue, state, params) {
  const prior = params.appliedHomeMortgage || 0;          // home's current +1
  const contribution = isMortgageTransition(state, params) ? 1 : 0; // new +1
  return Math.max(0, (currentValue || 0) - prior + contribution);   // floor at 0
}
// Number of Mortgages is the one counter that tracks the home's single +1
// against the LIVE count (preserving manual mortgage edits). The account
// counters (open/total) then derive from the resulting mortgage count via
// openAccountsValue / totalAccountsValue above.
function mortAccFromHome(state, params) {
  return homeCountAfterTransition(state.mort_acc, state, params);
}

// FICO — every FICO-writing edge recomputes the score from baseline via the
// single master formula (Brief Section 4). Idempotent and order-independent.
function ficoMaster(state, params) {
  return masterFico(params);
}

/**
 * The complete edge set. Keys are edited-feature internal names; each value is
 * the list of that feature's outgoing edges. Features absent from this table
 * (or present with an empty list) have zero outgoing edges — that includes all
 * of Section 6's deliberate exclusions and every leaf/sink.
 */
export const EDGES = {
  loan_amnt: [
    { dependent: 'dti', tag: 'C', phase: 'value', rule: dtiFull }
  ],
  revol_bal: [
    { dependent: 'revol_util', tag: 'E', phase: 'structural', rule: revolUtilFromBal },
    { dependent: 'dti', tag: 'A', phase: 'value', rule: dtiFull }
  ],
  revol_util: [
    { dependent: 'revol_bal', tag: 'E', phase: 'structural', rule: revolBalFromUtil },
    { dependent: 'dti', tag: 'A', phase: 'value', rule: dtiFull }
  ],
  open_acc: [
    { dependent: 'total_acc', tag: 'E', phase: 'structural', rule: totalAccountsValue },
    { dependent: 'fico_score', tag: 'E', phase: 'value', rule: ficoMaster }
  ],
  term: [
    { dependent: 'dti', tag: 'C', phase: 'value', rule: dtiFull }
  ],
  home_ownership: [
    { dependent: 'mort_acc', tag: 'E', phase: 'structural', rule: mortAccFromHome },
    { dependent: 'open_acc', tag: 'E', phase: 'structural', rule: openAccountsValue },
    { dependent: 'total_acc', tag: 'E', phase: 'structural', rule: totalAccountsValue },
    { dependent: 'fico_score', tag: 'E', phase: 'value', rule: ficoMaster }
  ],
  purpose: [
    { dependent: 'dti', tag: 'C', phase: 'value', rule: dtiFull }
  ],
  inq_last_6mths: [
    { dependent: 'fico_score', tag: 'E', phase: 'value', rule: ficoMaster }
  ],
  pub_rec_bankruptcies: [
    { dependent: 'fico_score', tag: 'E', phase: 'value', rule: ficoMaster }
  ],
  annual_inc: [
    { dependent: 'dti', tag: 'E', phase: 'value', rule: dtiFull }
  ],
  mort_acc: [
    { dependent: 'open_acc', tag: 'E', phase: 'structural', rule: openAccountsValue },
    { dependent: 'total_acc', tag: 'E', phase: 'structural', rule: totalAccountsValue },
    { dependent: 'fico_score', tag: 'E', phase: 'value', rule: ficoMaster }
  ]
};

/**
 * Features that are editable but have ZERO outgoing edges (Brief Section 5 list
 * plus the two sinks). Kept explicit for the UI (linked-icon logic) and for the
 * "direct edit propagates to nothing" test.
 */
export const LEAF_FEATURES = [
  'dti',
  'fico_score',
  'earliest_cr_line',
  'total_acc',
  'emp_length',
  'verification_status',
  'delinq_2yrs',
  'pub_rec',
  'application_type'
];
