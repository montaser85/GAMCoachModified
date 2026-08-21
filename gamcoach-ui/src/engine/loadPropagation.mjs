/**
 * Eager load-time propagation of the coach's suggested changes — for ALL plans.
 *
 * Background: `FeaturePanel.propagateSuggestedChangesAtLoad()` runs the causal
 * engine on a plan's coach-suggested inputs and folds the propagated DEPENDENTS
 * (DTI, revolving balance, account counts, …) into that plan's `ebmLocal.sample`
 * + `coachSample`, recomputing `predScore`. But a FeaturePanel is mounted only
 * for the ACTIVE plan, so only the plan the user is currently viewing gets its
 * stored state folded. Any consumer that reads ALL plans at once — most visibly
 * "Compare Plans" (CompareModal reads every entry of CoachPanel's `localPlans`)
 * — therefore sees RAW, un-propagated solver state for the plans the user has
 * not yet opened: wrong approval scores and missing suggested changes (e.g. no
 * DTI change shown). Re-opening after visiting each plan "fixes" it only because
 * visiting a plan mounts its FeaturePanel.
 *
 * This module performs the SAME plan-state mutation eagerly, once per plan, at
 * load — independent of which FeaturePanel is mounted — so every plan's stored
 * state reflects the folded suggestions from the start. It deliberately mutates
 * ONLY the state that all-plans consumers read: `ebmLocal.sample` (+ recomputed
 * `predScore`) and `coachSample`. It does NOT touch the per-feature display
 * fields (`f.coachValue` / `f.myValue` / `f.isChanged` / `f.hypotheticalValue`),
 * which FeaturePanel freezes from `f.coachValue` on mount — leaving those raw
 * keeps this pass byte-neutral to the active/visited-plan behavior, which
 * re-folds them itself (idempotently) when its FeaturePanel mounts.
 *
 * Idempotent & drift-safe: the fold is derived from the IMMUTABLE `plan.cfDataRaw`
 * (never from the live, already-folded sample), so applying it here and then
 * again when the FeaturePanel mounts (which reads the same cfDataRaw) reproduces
 * the identical result. The two paths must stay in lock-step — this is a faithful
 * transcription of the plan-mutation core of
 * FeaturePanel.propagateSuggestedChangesAtLoad(); keep them in sync.
 */

import {
  propagate,
  featureHasOutgoingEdges,
  MORTGAGE_HOME_VALUE,
  derogSubtract
} from './index.mjs';

// ── Pure helpers (transcribed verbatim from FeaturePanel, parameterized by the
// plan). They depend only on plan.features + the baseline state + constants. ──

const parseTermMonths = (termLabel) => {
  const match = String(termLabel || '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 36;
};

/** Build a full engine state (all features, display units) from a per-feature
 *  source of internal values. Mirror of FeaturePanel.buildEngineState. */
const buildEngineState = (plan, getInternal) => {
  const state = {};
  if (!plan) return state;
  plan.features.forEach((f) => {
    const name = f.data.name;
    const raw = getInternal(f);
    if (!f.isCont) {
      const label =
        typeof raw === 'number' && f.labelEncoder ? f.labelEncoder[raw] : raw;
      if (name === 'term') {
        state[name] = parseTermMonths(label);
      } else if (name === 'mort_acc') {
        state[name] = label === '7+' ? 8 : parseInt(label, 10) || 0;
      } else if (name === 'inq_last_6mths') {
        state[name] = label === '3+' ? 4 : parseInt(label, 10) || 0;
      } else {
        state[name] = label;
      }
    } else {
      state[name] = f.transform === 'log10' ? Math.pow(10, raw) : raw;
    }
  });
  return state;
};

/** Convert a display value back into the internal representation the EBM/slider
 *  expect. Mirror of FeaturePanel.displayToInternal (+ toInternalValue). */
const displayToInternal = (plan, featureName, displayValue) => {
  const f = plan?.features.find((ff) => ff.data.name === featureName);
  if (!f) return displayValue;
  if (!f.isCont && featureName === 'mort_acc') {
    const n = Math.round(displayValue);
    const labels = f.labelEncoder ? Object.values(f.labelEncoder) : [];
    const exact = String(n);
    return labels.includes(exact) ? exact : labels[labels.length - 1];
  }
  if (!f.isCont) return displayValue;
  let d = displayValue;
  if (f.requiresInt) d = Math.round(d);
  if (f.transform === 'log10') return d > 0 ? Math.log10(d) : 0;
  return d;
};

const engineValuesEqual = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
};

const homeMortgageContribution = (baseline, stateHome) =>
  stateHome === MORTGAGE_HOME_VALUE &&
  baseline &&
  baseline.home_ownership !== MORTGAGE_HOME_VALUE
    ? 1
    : 0;

/**
 * Apply the coach-suggested propagation + dependent fold to ONE plan's stored
 * state. Mutates plan.ebmLocal / plan.coachSample / per-feature coach fields in
 * place and recomputes predScore. No-op when the plan is missing or when the coach
 * suggested no input changes.
 *
 * @param {import('../components/coach/Coach').Plan} plan
 * @returns {boolean} true if any dependent was folded (state changed)
 */
export function applySuggestedPropagationToPlan(plan) {
  if (!plan || !plan.features || !plan.ebmLocal) return false;

  // Baseline = the applicant's ORIGINAL profile (display units). f.originalValue
  // is the folded baseline example the plans were generated against, identical
  // across plans (same applicant) — matches FeaturePanel.applicantBaselineState.
  const baseline = buildEngineState(plan, (f) => f.originalValue);

  // Coach-suggested state derived from the IMMUTABLE raw CF (never the live,
  // possibly already-folded sample) — keeps this deterministic and idempotent.
  const suggested = plan.cfDataRaw
    ? buildEngineState(plan, (f) => plan.cfDataRaw[f.featureID])
    : buildEngineState(plan, (f) => plan.ebmLocal.sample[f.featureID]);

  // The coach's suggested INPUT changes (values differing from the profile).
  const changedInputs = plan.features
    .map((f) => f.data.name)
    .filter((name) => !engineValuesEqual(suggested[name], baseline[name]));
  if (changedInputs.length === 0) return false;
  const changedSet = new Set(changedInputs);

  // Deltas fed to the engine — deterministic functions of suggested vs baseline,
  // identical to the seeds in FeaturePanel.propagateSuggestedChangesAtLoad.
  const mortDelta = Math.max(0, (suggested.mort_acc || 0) - (baseline.mort_acc || 0));
  const userFicoDelta = changedSet.has('fico_score')
    ? suggested.fico_score - baseline.fico_score
    : 0;
  const userDtiDelta = changedSet.has('dti') ? suggested.dti - baseline.dti : 0;
  const userRevolDelta = changedSet.has('revol_bal')
    ? suggested.revol_bal - baseline.revol_bal
    : 0;
  const userOpenDelta = changedSet.has('open_acc')
    ? (suggested.open_acc || 0) - (baseline.open_acc || 0) - mortDelta
    : 0;
  const userTotalDelta = changedSet.has('total_acc')
    ? (suggested.total_acc || 0) - (baseline.total_acc || 0) - userOpenDelta - mortDelta
    : 0;
  const appliedHomeMortgage = homeMortgageContribution(baseline, suggested.home_ownership);
  const derogIndependentPart = derogSubtract(
    baseline.pub_rec,
    baseline.pub_rec_bankruptcies
  );

  const modifiedFeatures = new Set(changedInputs);

  // Run the engine for each suggested input with outgoing edges, accumulating so
  // dependents fed by multiple inputs (e.g. DTI) settle from the full state.
  let working = { ...suggested };
  changedInputs.forEach((name) => {
    if (!featureHasOutgoingEdges(name)) return;
    const { state } = propagate(
      name, baseline, working, baseline,
      modifiedFeatures, appliedHomeMortgage, userOpenDelta, userTotalDelta, userFicoDelta,
      userDtiDelta, userRevolDelta, derogIndependentPart
    );
    working = state;
  });

  // Fold the propagated DEPENDENTS (features the coach did not change directly,
  // whose value moved) into ebmLocal.sample AND coachSample → "suggested".
  // NOTE: per the module header, we mutate ONLY ebmLocal (sample + predScore) and
  // coachSample — never f.coachValue / f.myValue / f.isChanged / f.hypotheticalValue.
  // FeaturePanel freezes originalValues from f.coachValue on mount; leaving those
  // raw keeps this pass byte-neutral to the active/visited-plan path.
  let foldedAny = false;
  plan.features.forEach((f) => {
    const name = f.data.name;
    if (changedSet.has(name)) return; // never touch inputs
    if (engineValuesEqual(working[name], suggested[name])) return; // no propagation
    const internal = displayToInternal(plan, name, working[name]);
    plan.ebmLocal.updateFeature(name, internal); // current value + recompute score
    plan.coachSample[f.featureID] = internal; // → suggested provenance
    foldedAny = true;
  });

  return foldedAny;
}
