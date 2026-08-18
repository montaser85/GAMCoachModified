/**
 * Causal Propagation Engine — Shared Parameters (Brief Section 4)
 *
 * Computes the shared values used by the propagation rules ONCE per pass.
 * Everything here operates in DISPLAY units (dollars, %, months, raw FICO
 * points, integer counts) — never in the model's internal/log10 space. The
 * FeaturePanel adapter is responsible for converting at the boundary.
 *
 * A "state" is a plain object keyed by the model's internal feature names:
 *   loan_amnt, dti, revol_bal, open_acc, fico_score, term, home_ownership,
 *   purpose, inq_last_6mths, pub_rec_bankruptcies, annual_inc,
 *   earliest_cr_line, revol_util, total_acc, emp_length, verification_status,
 *   delinq_2yrs, pub_rec, application_type, mort_acc
 *
 * `term` is months as a number (e.g. 36 or 60). `home_ownership` and `purpose`
 * are category strings.
 */

/** Home-ownership category that represents holding a mortgage. */
export const MORTGAGE_HOME_VALUE = 'MORTGAGE';

// FICO is clamped to the model's valid bucket range: the EBM scores fico_score
// with bin edges from 662 to ~847.5, so any value below 662 or above 848 lands
// in the bottom/top bucket and scores identically. FICO therefore never moves
// the decision outside this band, and we hold the displayed value there too —
// no matter how many penalties accumulate.
export const FICO_FLOOR = 662;
export const FICO_CEIL = 848;

// Valid display-unit range for every derived feature the engine writes, taken
// from the model's bin edges. Any value the engine computes outside these
// bounds lands in the bottom/top bucket and scores identically, so we clamp the
// written value to keep the displayed number inside the range the model can
// actually distinguish. (mort_acc is excluded — it is a capped category whose
// '7+' bucket is handled at the adapter, and its raw count must stay unclamped
// so a mortgage added at 7+ still registers as a hard inquiry.)
export const MODEL_BOUNDS = {
  fico_score: [FICO_FLOOR, FICO_CEIL], // 662 – 848
  revol_util: [0, 100],
  dti: [0, 99.9],
  open_acc: [1, 72],
  total_acc: [2, 118],
  revol_bal: [0, 1696796] // 10^0 .. 10^6.229629631710783 dollars
};

/**
 * Annual Percentage Rate by loan purpose (Brief Section 4).
 * Anything not explicitly listed is treated as a personal loan.
 */
export const APR_BY_PURPOSE = {
  house: 0.061,
  small_business: 0.089,
  car: 0.0622,
  renewable_energy: 0.0849
};
export const DEFAULT_APR = 0.1165; // personal / everything else

// ── TEST TOGGLE: fold the applied-for loan into baseline DTI ──────────────────
// When true, the applicant's baseline DTI is raised at load to INCLUDE the
// applied-for loan's amortized monthly payment — a harder, more realistic starting
// point (the loan they're asking for counts against them from the start). Applied
// once to curExample (see foldAppliedLoanIntoDti), so generation, scoring, and
// display all use the same loan-included DTI (display == score). It composes with
// the Model B loan-change delta WITHOUT double-counting: the folded baseline already
// carries the original loan's payment, and a loan change moves DTI by
// (new − original) payment from that baseline.
// When false → byte-identical to current behavior (baseline DTI excludes the loan).
// Independent of USE_ADVANCED_CONDITION — flip this one line to toggle.
export const FOLD_APPLIED_LOAN_INTO_DTI = true;

/**
 * Resolve the APR for a given purpose string. Case-insensitive; unknown
 * purposes fall back to the personal-loan rate.
 * @param {string} purpose
 * @returns {number}
 */
export function aprForPurpose(purpose) {
  if (purpose === null || purpose === undefined) return DEFAULT_APR;
  const key = String(purpose).toLowerCase();
  return Object.prototype.hasOwnProperty.call(APR_BY_PURPOSE, key)
    ? APR_BY_PURPOSE[key]
    : DEFAULT_APR;
}

/**
 * A net increase vs. the frozen applicant baseline, zero-floored
 * (Brief Section 8: "Zero-floor on all FICO increase terms" and
 * "Net-change, not path").
 * @param {number} current
 * @param {number} baseline
 * @returns {number} max(0, current - baseline)
 */
export function increase(current, baseline) {
  return Math.max(0, (current || 0) - (baseline || 0));
}

/**
 * Recover the applicant's revolving credit limit from the baseline
 * (Brief Section 7). Indeterminate when either baseline term is 0 — in that
 * case we return null and callers must fall back (hold utilization / skip the
 * recompute) instead of dividing by zero.
 * @param {object} baseline
 * @returns {number|null} credit limit, or null if indeterminate
 */
export function creditLimitFromBaseline(baseline) {
  const bal = baseline.revol_bal;
  const util = baseline.revol_util;
  if (!bal || !util) return null; // 0 balance or 0 utilization => indeterminate
  return bal / (util / 100);
}

/**
 * Compute the amortized monthly payment for the current loan terms
 * (Brief Section 4). Uses the standard annuity formula.
 * @param {number} loanAmount
 * @param {number} monthlyInterestRate  APR / 12
 * @param {number} termMonths
 * @returns {number}
 */
export function loanMonthlyPayment(loanAmount, monthlyInterestRate, termMonths) {
  const mir = monthlyInterestRate;
  const n = termMonths;
  if (!n) return 0;
  if (mir === 0) return loanAmount / n; // zero-interest edge case
  return (loanAmount * mir) / (1 - Math.pow(1 + mir, -n));
}

/**
 * TEST TOGGLE (FOLD_APPLIED_LOAN_INTO_DTI): return a copy of the raw model example
 * with its `dti` raised to INCLUDE the applied-for loan's monthly payment. Applied
 * once, at the applicant-baseline source, so generation + scoring + display all see
 * the same loan-included DTI. Byte-identical passthrough (returns the SAME array,
 * no copy) when the flag is off. Operates in model-internal units: `dti` is a raw
 * percentage, `annual_inc` is log10 dollars, `loan_amnt` is raw dollars, `term` is
 * raw months, `purpose` is the category string.
 * @param {Array} curExample model example (feature values by index)
 * @param {string[]} featureNames feature names, same order as curExample
 * @returns {Array} folded copy (flag on) or the original array (flag off)
 */
export function foldAppliedLoanIntoDti(curExample, featureNames) {
  if (!FOLD_APPLIED_LOAN_INTO_DTI) return curExample; // off → byte-identical
  if (!curExample || !featureNames) return curExample;
  const idx = (n) => featureNames.indexOf(n);
  const dtiIdx = idx('dti');
  const loanIdx = idx('loan_amnt');
  const incIdx = idx('annual_inc');
  const purpIdx = idx('purpose');
  const termIdx = idx('term');
  if (dtiIdx < 0 || loanIdx < 0 || incIdx < 0) return curExample; // not the LC model
  const monthlyIncome = Math.pow(10, curExample[incIdx]) / 12; // log10 $/yr → $/mo
  if (!(monthlyIncome > 0)) return curExample;
  const apr = purpIdx >= 0 ? aprForPurpose(curExample[purpIdx]) : aprForPurpose(null);
  const termMonths = termIdx >= 0 ? (parseInt(String(curExample[termIdx]), 10) || 0) : 0;
  const loanPayment = loanMonthlyPayment(curExample[loanIdx], apr / 12, termMonths);
  const dtiContribution = (loanPayment / monthlyIncome) * 100; // payment → DTI points
  const folded = curExample.slice();
  const b = MODEL_BOUNDS.dti;
  folded[dtiIdx] = Math.min(b[1], Math.max(b[0], (folded[dtiIdx] || 0) + dtiContribution));
  return folded;
}

/**
 * Compute every Section-4 shared parameter for a single propagation pass.
 *
 * @param {object} baseline  Applicant's ORIGINAL input profile (frozen).
 * @param {object} current   Full feature vector AFTER the user's direct edit.
 * @param {Set<string>} [modifiedFeatures]  Names of features the user has
 *   actively edited. Consumed only by the DTI_USER_EDITS_ONLY gate (see
 *   edges.mjs). When omitted, the gate treats every input as engaged (the prior
 *   "all current values" behavior).
 * @returns {object} params consumed by the rule functions.
 */
export function computeParams(baseline, current, modifiedFeatures = null, ficoManualDelta = 0, dtiManualDelta = 0, revolManualDelta = 0) {
  // Income denominators — one shared "New Monthly Income" everywhere. If income
  // was not edited, current.annual_inc === baseline.annual_inc and the two
  // collapse to the same value (Brief Section 8: New-Monthly-Income discipline).
  const currentMonthlyIncome = (baseline.annual_inc || 0) / 12;
  const newMonthlyIncome = (current.annual_inc || 0) / 12;

  // Loan payment under the CURRENT terms (loan amount, term, purpose APR).
  const apr = aprForPurpose(current.purpose);
  const mir = apr / 12;
  const monthlyLoanPayment = loanMonthlyPayment(
    current.loan_amnt || 0,
    mir,
    current.term || 0
  );

  // Existing monthly debt payment — the fixed base, derived once from the
  // profile DTI and profile (current) income. Never rebuilt from the live DTI,
  // so repeated loan-based edits never stack.
  const currentMonthlyDebtPayment =
    ((baseline.dti || 0) * currentMonthlyIncome) / 100;

  // ── Hard-inquiry counter — single source of truth for all -4 FICO deltas ──
  const creditInquiriesIncrease = increase(
    current.inq_last_6mths,
    baseline.inq_last_6mths
  );
  const openAccountsIncrease = increase(current.open_acc, baseline.open_acc);
  const mortgagesIncrease = increase(current.mort_acc, baseline.mort_acc);

  // Mortgage double-count rule: a mortgage bumps BOTH open accounts and
  // mortgages, but must add to the counter only once (via the mortgages term).
  // Exclude the mortgage-driven open-account increments from the open term.
  const openAccountsIncreaseExMortgage = Math.max(
    0,
    openAccountsIncrease - mortgagesIncrease
  );

  // There is NO baseline "+1" application inquiry. FICO changes only in
  // response to user edits that add credit inquiries, open accounts, or
  // mortgages — nothing on load, and nothing from editing the loan amount.
  const hardInquiries =
    creditInquiriesIncrease +
    openAccountsIncreaseExMortgage +
    mortgagesIncrease;

  return {
    baseline,
    current,
    modifiedFeatures,
    apr,
    monthlyInterestRate: mir,
    currentMonthlyIncome,
    newMonthlyIncome,
    monthlyLoanPayment,
    currentMonthlyDebtPayment,
    creditInquiriesIncrease,
    openAccountsIncrease,
    mortgagesIncrease,
    openAccountsIncreaseExMortgage,
    hardInquiries,
    ficoManualDelta,
    dtiManualDelta,
    revolManualDelta,
    creditLimit: creditLimitFromBaseline(baseline)
  };
}

/**
 * Master FICO formula (Brief Section 4). FICO is primitive-with-deltas: start
 * from the baseline score, add the user's SIGNED manual edit (ficoManualDelta —
 * the user may raise or lower their own score), then subtract the SINGLE penalty
 * channel — the shared hard-inquiry counter (−4 per inquiry: opened accounts,
 * mortgages, and direct credit-inquiry edits all feed it). The bankruptcy → FICO
 * channel has been removed.
 *
 * Source penalties can only hold or lower the score — they never raise it above
 * the user's own set point (the adjusted base). Only the manual edit may raise
 * FICO above the profile value.
 * @param {object} params
 * @returns {number}
 */
export function masterFico(params) {
  const baseFico = params.baseline.fico_score || 0;
  const adjustedBase = baseFico + (params.ficoManualDelta || 0);
  const newFico = adjustedBase - params.hardInquiries * 4;
  // Never-increase-from-penalties invariant (defensive; the penalty is already
  // >= 0). The valid-range clamp (662–848) is applied centrally in propagate()
  // via MODEL_BOUNDS, together with every other derived feature.
  return Math.min(newFico, adjustedBase);
}
