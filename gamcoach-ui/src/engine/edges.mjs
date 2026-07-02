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

import { masterFico, MORTGAGE_HOME_VALUE } from './params.mjs';

const REVOL_DTI_FACTOR = 0.02; // 2%-of-delta on revolving balance change

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
function dtiFrom(newMonthlyDebtPayment, params) {
  const denom = params.newMonthlyIncome;
  if (!denom) return params.baseline.dti; // indeterminate income => hold
  return (newMonthlyDebtPayment / denom) * 100;
}

function dtiFull(state, params) {
  const revolBalDelta = (state.revol_bal || 0) - (params.baseline.revol_bal || 0);
  const newMonthlyDebtPayment =
    params.currentMonthlyDebtPayment +
    params.monthlyLoanPayment +
    revolBalDelta * REVOL_DTI_FACTOR;
  return dtiFrom(newMonthlyDebtPayment, params);
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

// ── Account counters (Brief Section 5) ─────────────────────────────────────
// Open Accounts -> Number of Accounts. Opening: total rises with the net open
// increase. Closing: total is unchanged (open falls, total holds).
function totalAccFromOpen(state, params) {
  const openIncrease = Math.max(
    0,
    (state.open_acc || 0) - (params.baseline.open_acc || 0)
  );
  return (params.baseline.total_acc || 0) + openIncrease;
}

// ── Home Ownership -> Mortgage transition (Brief Section 5) ────────────────
// Only on a transition INTO mortgage: +1 to mortgages and to both account
// counters. Any other home-ownership change propagates to nothing.
function isMortgageTransition(state, params) {
  return (
    state.home_ownership === MORTGAGE_HOME_VALUE &&
    params.baseline.home_ownership !== MORTGAGE_HOME_VALUE
  );
}
function mortAccFromHome(state, params) {
  return (params.baseline.mort_acc || 0) + (isMortgageTransition(state, params) ? 1 : 0);
}
function openAccFromHome(state, params) {
  return (params.baseline.open_acc || 0) + (isMortgageTransition(state, params) ? 1 : 0);
}
function totalAccFromHome(state, params) {
  return (params.baseline.total_acc || 0) + (isMortgageTransition(state, params) ? 1 : 0);
}

// ── Number of Mortgages -> account counters (Brief Section 5) ──────────────
// A direct mortgage increase bumps both counters by the (floored) increase.
function openAccFromMort(state, params) {
  const mortIncrease = Math.max(
    0,
    (state.mort_acc || 0) - (params.baseline.mort_acc || 0)
  );
  return (params.baseline.open_acc || 0) + mortIncrease;
}
function totalAccFromMort(state, params) {
  const mortIncrease = Math.max(
    0,
    (state.mort_acc || 0) - (params.baseline.mort_acc || 0)
  );
  return (params.baseline.total_acc || 0) + mortIncrease;
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
    { dependent: 'total_acc', tag: 'E', phase: 'structural', rule: totalAccFromOpen },
    { dependent: 'fico_score', tag: 'E', phase: 'value', rule: ficoMaster }
  ],
  term: [
    { dependent: 'dti', tag: 'C', phase: 'value', rule: dtiFull }
  ],
  home_ownership: [
    { dependent: 'mort_acc', tag: 'E', phase: 'structural', rule: mortAccFromHome },
    { dependent: 'open_acc', tag: 'E', phase: 'structural', rule: openAccFromHome },
    { dependent: 'total_acc', tag: 'E', phase: 'structural', rule: totalAccFromHome },
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
    { dependent: 'open_acc', tag: 'E', phase: 'structural', rule: openAccFromMort },
    { dependent: 'total_acc', tag: 'E', phase: 'structural', rule: totalAccFromMort },
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
