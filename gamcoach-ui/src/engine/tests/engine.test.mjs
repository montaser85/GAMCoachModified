/**
 * Causal Propagation Engine — test suite (Brief Section 10).
 *
 * Zero-dependency: uses Node's built-in `assert`. Run with:
 *   node src/engine/tests/engine.test.mjs
 * (wired as `npm test`). Exits non-zero if any case fails.
 */

import assert from 'assert';
import { propagate } from '../index.mjs';
import {
  creditLimitFromBaseline,
  masterFico,
  computeParams,
  loanMonthlyPayment,
  aprForPurpose
} from '../params.mjs';

// ── Tiny test harness ──────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}
const approx = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~= ${b}`);

// ── A representative applicant baseline (display units) ─────────────────────
function makeBaseline(overrides = {}) {
  return {
    loan_amnt: 10000,
    dti: 20, // %
    revol_bal: 5000,
    open_acc: 8,
    fico_score: 700,
    term: 36,
    home_ownership: 'RENT',
    purpose: 'car', // APR 6.22%
    inq_last_6mths: 1,
    pub_rec_bankruptcies: 0,
    annual_inc: 60000,
    earliest_cr_line: 2005,
    revol_util: 25, // %
    total_acc: 15,
    emp_length: 5,
    verification_status: 'Verified',
    delinq_2yrs: 0,
    pub_rec: 0,
    application_type: 'Individual',
    mort_acc: 0,
    ...overrides
  };
}
const edit = (base, feature, value) => ({ ...base, [feature]: value });
const dtiEdge = (log) => log.find((l) => l.dependent === 'dti' && !l.note);

// Independent reference implementation of the full-state DTI, used to assert
// the engine settles derived DTI from ALL of its inputs (base debt + applied
// loan payment + 2%-of-revolving-delta) over current income.
function expectedDti(base, current) {
  const monthlyIncome = current.annual_inc / 12;
  const baseDebt = (base.dti * (base.annual_inc / 12)) / 100;
  const loanPay = loanMonthlyPayment(
    current.loan_amnt,
    aprForPurpose(current.purpose) / 12,
    current.term
  );
  const revolDelta = (current.revol_bal - base.revol_bal) * 0.02;
  return ((baseDebt + loanPay + revolDelta) / monthlyIncome) * 100;
}

console.log('Causal Propagation Engine — Section 10 tests');

// 1. Loan Amount ↑ → DTI ↑ only (FICO is NOT affected by loan amount);
//    CC/Debt-Consolidation DTI = conservative
test('1a. Loan Amount up -> DTI up, FICO unchanged (no loan->FICO edge)', () => {
  const base = makeBaseline();
  const next = edit(base, 'loan_amnt', 20000);
  const { state, log } = propagate('loan_amnt', base, next, base);
  assert.ok(state.dti > base.dti, 'DTI should rise');
  approx(state.fico_score, base.fico_score); // FICO must NOT change
  assert.ok(
    !log.some((l) => l.dependent === 'fico_score'),
    'loan amount must not write FICO'
  );
  assert.strictEqual(dtiEdge(log).tag, 'C', 'loan->dti is conservative');
});

test('1b. Loan Amount DTI tagged conservative for debt consolidation', () => {
  const base = makeBaseline({ purpose: 'debt_consolidation' });
  const next = edit(base, 'loan_amnt', 25000);
  const { state, log } = propagate('loan_amnt', base, next, base);
  assert.strictEqual(dtiEdge(log).tag, 'C');
  assert.ok(state.dti > base.dti);
});

test('1d. Loan DTI is path-independent (no stacking across edits)', () => {
  const base = makeBaseline();
  const direct = propagate('loan_amnt', base, edit(base, 'loan_amnt', 20000), base)
    .state.dti;
  // Compute from a state that already carries a prior (propagated) DTI/loan:
  // the result must be identical because the base is fixed to the profile.
  const afterFirst = propagate('loan_amnt', base, edit(base, 'loan_amnt', 50000), base).state;
  const viaPath = propagate('loan_amnt', base, edit(afterFirst, 'loan_amnt', 20000), base)
    .state.dti;
  approx(direct, viaPath);
});

// 2. Revolving Balance edit -> Utilization tracks; DTI recomputes from the FULL
//    state (includes the applied loan payment) and moves with the balance.
test('2a. Revolving Balance down -> Utilization down; DTI includes loan payment', () => {
  const base = makeBaseline();
  const next = edit(base, 'revol_bal', 2000);
  const { state } = propagate('revol_bal', base, next, base);
  const limit = creditLimitFromBaseline(base); // 20000
  approx(state.revol_util, (2000 / limit) * 100); // 10
  assert.ok(state.revol_util < base.revol_util);
  // DTI still includes the current loan's payment (loan is always in DTI).
  approx(state.dti, expectedDti(base, next));
});

test('2b. Revolving Balance up -> Utilization up; higher balance -> higher DTI', () => {
  const base = makeBaseline();
  const down = propagate('revol_bal', base, edit(base, 'revol_bal', 2000), base).state;
  const up = propagate('revol_bal', base, edit(base, 'revol_bal', 8000), base).state;
  assert.ok(up.revol_util > base.revol_util); // 40 > 25
  approx(up.dti, expectedDti(base, edit(base, 'revol_bal', 8000)));
  assert.ok(up.dti > down.dti); // higher revolving balance -> higher DTI
});

// 3. Edit Utilization → Revolving Balance (inverse); edit both → last-edit-wins
test('3a. Edit Utilization -> Revolving Balance updates (inverse)', () => {
  const base = makeBaseline();
  const next = edit(base, 'revol_util', 50);
  const { state } = propagate('revol_util', base, next, base);
  const limit = creditLimitFromBaseline(base); // 20000
  approx(state.revol_bal, (50 / 100) * limit); // 10000
});

test('3b. Edit both -> last-edit-wins, credit limit unchanged', () => {
  const base = makeBaseline();
  // First the user edited revol_bal; then, more recently, revol_util.
  const afterBalEdit = edit(base, 'revol_bal', 9000);
  const afterUtilEdit = edit(afterBalEdit, 'revol_util', 50);
  // Most recent edit is revol_util => it is the input; revol_bal is recomputed
  // from the FROZEN baseline credit limit (never altered to reconcile).
  const { state } = propagate('revol_util', afterBalEdit, afterUtilEdit, base);
  const limit = creditLimitFromBaseline(base); // still 20000
  approx(limit, 20000);
  approx(state.revol_bal, (50 / 100) * limit); // 10000, from baseline limit
  approx(state.revol_util, 50); // input untouched
});

// 4. Inquiries 21→17→20 (net −1) → floored to 0; FICO unchanged from that channel
test('4. Inquiries net -1 -> floored to 0, FICO unchanged', () => {
  const base = makeBaseline({ inq_last_6mths: 21 });
  const next = edit(base, 'inq_last_6mths', 20); // net -1 vs baseline
  const { state } = propagate('inq_last_6mths', base, next, base);
  approx(state.fico_score, 700); // no loan application, channel floors to 0
});

// 5. Open Accounts opening → both +1 and FICO −4; closing → open −1, total held, FICO unchanged
test('5a. Open account opening -> both counters +1 and FICO -4', () => {
  const base = makeBaseline();
  const next = edit(base, 'open_acc', 9);
  const { state } = propagate('open_acc', base, next, base);
  assert.strictEqual(state.open_acc, 9);
  assert.strictEqual(state.total_acc, 16); // 15 + 1
  approx(state.fico_score, 696); // one hard inquiry
});

test('5b. Open account closing -> open -1, total unchanged, FICO unchanged', () => {
  const base = makeBaseline();
  const next = edit(base, 'open_acc', 7);
  const { state } = propagate('open_acc', base, next, base);
  assert.strictEqual(state.open_acc, 7);
  assert.strictEqual(state.total_acc, 15); // unchanged
  approx(state.fico_score, 700); // no increase => no penalty
});

// 6. Home Ownership →Mortgage → mortgages +1, both counters +1, FICO −4 (not −8)
test('6. Home Ownership -> Mortgage: +1 each, FICO -4 exactly once', () => {
  const base = makeBaseline({ home_ownership: 'RENT' });
  const next = edit(base, 'home_ownership', 'MORTGAGE');
  const { state } = propagate('home_ownership', base, next, base);
  assert.strictEqual(state.mort_acc, 1);
  assert.strictEqual(state.open_acc, 9); // 8 + 1
  assert.strictEqual(state.total_acc, 16); // 15 + 1
  approx(state.fico_score, 696); // -4 once, NOT -8
});

test('6b. Home Ownership non-mortgage change -> nothing propagates', () => {
  const base = makeBaseline({ home_ownership: 'RENT' });
  const next = edit(base, 'home_ownership', 'OWN');
  const { state } = propagate('home_ownership', base, next, base);
  assert.strictEqual(state.mort_acc, base.mort_acc);
  assert.strictEqual(state.open_acc, base.open_acc);
  assert.strictEqual(state.total_acc, base.total_acc);
  approx(state.fico_score, base.fico_score);
});

// 7. Direct edit to DTI / FICO / any leaf → nothing else changes
test('7. Direct edit to DTI / FICO / leaf propagates to nothing', () => {
  const base = makeBaseline();
  for (const [feature, value] of [
    ['dti', 30],
    ['fico_score', 650],
    ['emp_length', 10],
    ['verification_status', 'Not Verified'],
    ['earliest_cr_line', 2010]
  ]) {
    const next = edit(base, feature, value);
    const { state } = propagate(feature, base, next, base);
    for (const key of Object.keys(base)) {
      assert.strictEqual(
        state[key],
        next[key],
        `${feature} edit must not change ${key}`
      );
    }
  }
});

// 8. Zero-balance applicant edits utilization → no divide-by-zero; fallback taken
test('8. Zero-balance util edit -> no divide-by-zero, fallback holds values', () => {
  const base = makeBaseline({ revol_bal: 0, revol_util: 0 });
  assert.strictEqual(creditLimitFromBaseline(base), null);
  const next = edit(base, 'revol_util', 40);
  const { state } = propagate('revol_util', base, next, base);
  assert.ok(Number.isFinite(state.revol_bal), 'revol_bal finite');
  assert.ok(Number.isFinite(state.dti), 'dti finite');
  assert.strictEqual(state.revol_bal, base.revol_bal); // held (fallback => zero delta)
  approx(state.dti, expectedDti(base, next)); // no divide-by-zero; delta is zero
});

// 9. Total ≥ Open bound holds after any account edit
test('9a. Total >= Open after opening many accounts', () => {
  const base = makeBaseline();
  const next = edit(base, 'open_acc', 20); // beyond total (15)
  const { state } = propagate('open_acc', base, next, base);
  assert.ok(state.total_acc >= state.open_acc, 'total >= open');
});

test('9b. Total cannot be set below Open on a direct total edit', () => {
  const base = makeBaseline(); // open 8
  const next = edit(base, 'total_acc', 5); // below open
  const { state } = propagate('total_acc', base, next, base);
  assert.strictEqual(state.total_acc, 8); // bumped up to open
});

// Extra invariants (Brief Sections 4/8)
test('X1. Bankruptcy increase drops FICO, clamped to the 662 floor', () => {
  const base = makeBaseline({ pub_rec_bankruptcies: 0 }); // fico 700
  const next = edit(base, 'pub_rec_bankruptcies', 1);
  const { state } = propagate('pub_rec_bankruptcies', base, next, base);
  approx(state.fico_score, 662); // 700 - 200 = 500, clamped up to the 662 floor
});

test('D3. FICO never drops below 662, however many accounts open', () => {
  const base = makeBaseline({ open_acc: 8 }); // fico 700
  const next = edit(base, 'open_acc', 58); // +50 accounts
  const { state } = propagate('open_acc', base, next, base);
  approx(state.fico_score, 662); // 700 - 50*4 = 500, clamped to the floor
  assert.ok(state.fico_score >= 662);
});

test('X2. Reducing bankruptcies never raises FICO', () => {
  const base = makeBaseline({ pub_rec_bankruptcies: 2 });
  const next = edit(base, 'pub_rec_bankruptcies', 0); // net -2, floored to 0
  const { state } = propagate('pub_rec_bankruptcies', base, next, base);
  assert.ok(state.fico_score <= base.fico_score);
  approx(state.fico_score, 700); // floored, no change from this channel
});

test('X3. Mortgage direct edit -> counters up, FICO -4 once (not -8)', () => {
  const base = makeBaseline({ mort_acc: 0, open_acc: 8, total_acc: 15 });
  const next = edit(base, 'mort_acc', 1);
  const { state } = propagate('mort_acc', base, next, base);
  assert.strictEqual(state.open_acc, 9);
  assert.strictEqual(state.total_acc, 16);
  approx(state.fico_score, 696); // single hard inquiry
});

test('X4. Annual income up -> DTI down; numerator still includes loan payment', () => {
  const base = makeBaseline();
  const next = edit(base, 'annual_inc', 120000); // double income
  const { state, log } = propagate('annual_inc', base, next, base);
  const atOriginalIncome = propagate('annual_inc', base, base, base).state.dti;
  assert.ok(state.dti < atOriginalIncome); // higher income -> lower DTI
  approx(state.dti, expectedDti(base, next)); // full-state numerator over new income
  assert.strictEqual(dtiEdge(log).tag, 'E');
});

// Design principle: any DTI input edit recomputes DTI from the FULL state.
test('D1. Editing Revolving Balance still includes the current loan payment', () => {
  const base = makeBaseline();
  const next = edit(base, 'revol_bal', 3000);
  const { state } = propagate('revol_bal', base, next, base);
  // DTI must reflect base debt + the applied loan's payment + the revolving delta.
  approx(state.dti, expectedDti(base, next));
  // ...and it must be strictly above a hypothetical no-loan DTI, proving the
  // loan payment is present even though we edited a different feature.
  const monthlyIncome = base.annual_inc / 12;
  const noLoanDti =
    (((base.dti * monthlyIncome) / 100 + (3000 - base.revol_bal) * 0.02) / monthlyIncome) * 100;
  assert.ok(state.dti > noLoanDti);
});

test('D2. DTI is order-independent (same final state -> same DTI)', () => {
  const base = makeBaseline();
  // Same final feature values, reached by editing different inputs last.
  const finalState = edit(edit(base, 'loan_amnt', 18000), 'revol_bal', 4000);
  const viaLoan = propagate('loan_amnt', base, finalState, base).state.dti;
  const viaRevol = propagate('revol_bal', base, finalState, base).state.dti;
  const viaIncome = propagate('annual_inc', base, finalState, base).state.dti;
  approx(viaLoan, viaRevol);
  approx(viaLoan, viaIncome);
  approx(viaLoan, expectedDti(base, finalState));
});

test('X6. No baseline inquiry: +1 credit inquiry -> FICO -4 (not -8)', () => {
  const base = makeBaseline({ inq_last_6mths: 1 });
  const next = edit(base, 'inq_last_6mths', 2); // net +1
  const { state } = propagate('inq_last_6mths', base, next, base);
  approx(state.fico_score, 696); // exactly one channel, no application +1
});

test('X7. Editing loan amount never animates/writes FICO', () => {
  const base = makeBaseline();
  const next = edit(base, 'loan_amnt', 50000);
  const { state, log } = propagate('loan_amnt', base, next, base);
  approx(state.fico_score, base.fico_score);
  assert.ok(!log.some((l) => l.dependent === 'fico_score'));
});

test('X5. Warnings raised but never block (DTI>36, FICO<670)', () => {
  const base = makeBaseline({ dti: 20, annual_inc: 60000 });
  const next = edit(base, 'loan_amnt', 400000); // huge payment -> DTI blows up
  const { state, warnings } = propagate('loan_amnt', base, next, base);
  assert.ok(state.dti > 36);
  assert.ok(warnings.some((w) => w.feature === 'dti'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(` - ${f.name}: ${f.err.message}`);
  process.exit(1);
}
