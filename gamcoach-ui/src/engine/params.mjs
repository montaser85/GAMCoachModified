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
 * Compute every Section-4 shared parameter for a single propagation pass.
 *
 * @param {object} baseline  Applicant's ORIGINAL input profile (frozen).
 * @param {object} current   Full feature vector AFTER the user's direct edit.
 * @returns {object} params consumed by the rule functions.
 */
export function computeParams(baseline, current) {
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

  const bankruptciesIncrease = increase(
    current.pub_rec_bankruptcies,
    baseline.pub_rec_bankruptcies
  );

  return {
    baseline,
    current,
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
    bankruptciesIncrease,
    creditLimit: creditLimitFromBaseline(baseline)
  };
}

/**
 * Master FICO formula (Brief Section 4). FICO is primitive-with-deltas: start
 * from the baseline score and subtract exactly two penalty channels. FICO can
 * only hold or fall — never increase (Brief Section 8).
 * @param {object} params
 * @returns {number}
 */
export function masterFico(params) {
  const baseFico = params.baseline.fico_score || 0;
  const newFico =
    baseFico - params.hardInquiries * 4 - params.bankruptciesIncrease * 200;
  // Never-increase invariant (defensive; penalties are already >= 0).
  return Math.min(newFico, baseFico);
}
