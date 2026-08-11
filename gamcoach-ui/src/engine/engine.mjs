/**
 * Causal Propagation Engine — Entry Point (Brief Sections 3, 8, 9)
 *
 * propagate() takes the edited feature and the full feature vector after the
 * user's direct edit, then deterministically overwrites every dependent feature
 * so the resulting profile stays internally consistent. Propagation is HARD:
 * dependents are auto-applied, with no intermediate confirmation step.
 *
 * Design (Brief Section 9):
 *   1. Stage structural writes (account counts, two-way balances) so the shared
 *      parameters see updated counts.
 *   2. Compute the Section-4 parameters ONCE per pass.
 *   3. Apply value writes (FICO, DTI).
 *   4. Apply engine-level guards (Section 8) and collect warnings.
 *
 * Two-way pair (Brief Section 8, "last-edit-wins"): the engine only walks edges
 * OUT of `editedFeature`, so whichever member of Revolving Balance <-> Credit
 * Utilization was edited most recently is the input and the other is recomputed.
 * The credit limit is always recovered from the frozen baseline and never
 * altered to reconcile a conflict.
 */

import { computeParams, creditLimitFromBaseline, MODEL_BOUNDS } from './params.mjs';
import { EDGES } from './edges.mjs';

/**
 * Clamp a derived value to its model bin range (MODEL_BOUNDS). Features without
 * a bounds entry (or non-numeric values) pass through unchanged.
 * @param {string} feature
 * @param {number} value
 * @returns {number}
 */
function clampToBounds(feature, value) {
  const b = MODEL_BOUNDS[feature];
  if (!b || typeof value !== 'number') return value;
  return Math.max(b[0], Math.min(b[1], value));
}

/** Members of the one two-way pair — used only to surface a UI cue. */
const TWO_WAY_PAIR = { revol_bal: 'revol_util', revol_util: 'revol_bal' };

/** DTI warning threshold (Brief Section 8: warn, never block). */
export const DTI_WARN_THRESHOLD = 36;
/** FICO warning threshold (Brief Section 8: warn, never block). */
export const FICO_WARN_THRESHOLD = 670;

/**
 * Run one propagation pass.
 *
 * @param {string} editedFeature  Internal name of the directly edited feature.
 * @param {object} oldState       Full vector before this edit (accepted for
 *                                 signature parity / logging; net-change math
 *                                 uses `baseline`, not this).
 * @param {object} newState       Full vector AFTER the user's direct edit.
 * @param {object} [baseline]     Applicant's ORIGINAL input profile (frozen).
 *                                 The single reference for every net-change
 *                                 computation (Brief Section 8). Falls back to
 *                                 `oldState` only if omitted.
 * @param {Set<string>} [modifiedFeatures]  Names of features the user has
 *                                 actively edited — consumed only by the
 *                                 DTI_USER_EDITS_ONLY gate. Omit for the prior
 *                                 "all current values" behavior.
 * @param {number} [appliedHomeMortgage]  The +1 (0 or 1) Home Ownership
 *                                 currently contributes to the account counters
 *                                 (baked into the live count). Lets a Home
 *                                 Ownership change add/remove only its own +1
 *                                 instead of resetting the counters.
 * @param {number} [userOpenDelta]  The user's manual change to Number of Open
 *                                 Accounts (excluding the mortgage-driven part).
 *                                 Lets the account counters sum all sources.
 * @param {number} [userTotalDelta]  The user's manual change to Number of
 *                                 Accounts (excluding open/mortgage parts).
 * @param {number} [userFicoDelta]  The user's manual change to FICO Score
 *                                 (signed: profile → user-set value). Applied as
 *                                 a base adjustment before the hard-inquiry
 *                                 penalty, so a source change no longer discards
 *                                 the manual edit.
 * @param {number} [userDtiDelta]  The user's manual change to DTI (signed:
 *                                 profile → user-set value). Folded onto the
 *                                 computed DTI so a source change (loan/income/
 *                                 revolving) no longer discards the manual edit.
 * @param {number} [userRevolDelta]  The user's manual change to Revolving Balance
 *                                 (signed: profile → user-set value). Summed with
 *                                 the utilization-driven balance so a Credit
 *                                 Utilization change no longer discards it.
 * @param {string} [userDerogIndependent]  The provenance-tracked "independent
 *                                 part" of Number of Derogatory Records — the
 *                                 user's own (non-bankruptcy) marks, as a bin
 *                                 label ('0'..'2+'). The Bankruptcies → Derogatory
 *                                 edge computes min(2+, independent + bankruptcy).
 *                                 When null, the rule falls back to the
 *                                 baseline-derived split.
 * @returns {{ state: object, warnings: Array, log: Array }}
 */
export function propagate(editedFeature, oldState, newState, baseline, modifiedFeatures, appliedHomeMortgage = 0, userOpenDelta = 0, userTotalDelta = 0, userFicoDelta = 0, userDtiDelta = 0, userRevolDelta = 0, userDerogIndependent = null) {
  const base = baseline || oldState;
  const working = { ...newState };
  const log = [];
  const edges = EDGES[editedFeature] || [];

  // ── Phase 1: structural writes (accounts / two-way balances) ─────────────
  // These rules depend only on the baseline and the edited value, so a light
  // context carrying the baseline and the (baseline-derived) credit limit is
  // sufficient. Staging them first lets the hard-inquiry counter see updated
  // account counts in Phase 2.
  const structuralCtx = {
    baseline: base,
    creditLimit: creditLimitFromBaseline(base),
    appliedHomeMortgage,
    userOpenDelta,
    userTotalDelta,
    revolManualDelta: userRevolDelta,
    derogIndependentPart: userDerogIndependent,
    editedFeature
  };
  for (const edge of edges) {
    if (edge.phase !== 'structural') continue;
    const value = clampToBounds(edge.dependent, edge.rule(working, structuralCtx));
    working[edge.dependent] = value;
    log.push({
      edited: editedFeature,
      dependent: edge.dependent,
      tag: edge.tag,
      value
    });
  }

  // ── Phase 2: compute Section-4 parameters ONCE per pass ──────────────────
  const params = computeParams(base, working, modifiedFeatures, userFicoDelta, userDtiDelta, userRevolDelta);

  // ── Phase 3: value writes (FICO / DTI) ───────────────────────────────────
  for (const edge of edges) {
    if (edge.phase !== 'value') continue;
    const value = clampToBounds(edge.dependent, edge.rule(working, params));
    working[edge.dependent] = value;
    log.push({
      edited: editedFeature,
      dependent: edge.dependent,
      tag: edge.tag,
      value
    });
  }

  // ── Guards (Brief Section 8) ─────────────────────────────────────────────
  // Total >= Open bound: Number of Accounts can never be below Open Accounts.
  if (working.total_acc !== undefined && working.open_acc !== undefined) {
    working.total_acc = Math.max(working.total_acc, working.open_acc);
  }
  // (FICO never-increases and all zero-floors are enforced inside the rules /
  // params, so no further clamping is needed here.)

  // Two-way-pair UI cue: note that the sibling was recomputed and overwritten.
  if (TWO_WAY_PAIR[editedFeature]) {
    const sibling = TWO_WAY_PAIR[editedFeature];
    if (edges.some((e) => e.dependent === sibling)) {
      log.push({
        edited: editedFeature,
        dependent: sibling,
        tag: 'E',
        note: 'two-way-overwrite',
        value: working[sibling]
      });
    }
  }

  // ── Warnings, not blocks (Brief Section 8) ───────────────────────────────
  const warnings = [];
  if ((working.dti || 0) > DTI_WARN_THRESHOLD) {
    warnings.push({ feature: 'dti', value: working.dti, message: 'DTI exceeds 36%' });
  }
  if ((working.fico_score || 0) < FICO_WARN_THRESHOLD) {
    warnings.push({
      feature: 'fico_score',
      value: working.fico_score,
      message: 'FICO below 670'
    });
  }

  return { state: working, warnings, log };
}
