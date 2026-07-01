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

import { computeParams, creditLimitFromBaseline } from './params.mjs';
import { EDGES } from './edges.mjs';

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
 * @returns {{ state: object, warnings: Array, log: Array }}
 */
export function propagate(editedFeature, oldState, newState, baseline) {
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
    creditLimit: creditLimitFromBaseline(base)
  };
  for (const edge of edges) {
    if (edge.phase !== 'structural') continue;
    const value = edge.rule(working, structuralCtx);
    working[edge.dependent] = value;
    log.push({
      edited: editedFeature,
      dependent: edge.dependent,
      tag: edge.tag,
      value
    });
  }

  // ── Phase 2: compute Section-4 parameters ONCE per pass ──────────────────
  const params = computeParams(base, working);

  // ── Phase 3: value writes (FICO / DTI) ───────────────────────────────────
  for (const edge of edges) {
    if (edge.phase !== 'value') continue;
    const value = edge.rule(working, params);
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
