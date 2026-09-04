// ─────────────────────────────────────────────────────────────────────────────
// Per-plan "Ideas to try" — a self-contained port of FeaturePanel's isolated
// speculative what-if evaluation, parameterized on a Plan object so the Compare
// Plans summarized view can compute ideas for ANY of the five plans (not just the
// active one). Reuses the SAME propagation engine, config, and gate logic.
//
// Side-effect-free: perturbs cloned state, scores a cloned sample, discards it.
// It never mutates the plan, its ebmLocal, or any store.
//
// Context is reconstructed from the plan alone: baseline from feature.originalValue,
// current from ebmLocal.sample, modifiedFeatures from "changed from baseline". The
// manual-edit deltas are treated as 0 (a clean probe); this can shift a gain
// magnitude slightly but preserves the suggested DIRECTION, which is what the
// chips convey. Difficulty (runtime "Impossible to Change") comes from the shared
// global constraints.
// ─────────────────────────────────────────────────────────────────────────────
import { sigmoid } from '../../ebm/ebm';
import {
  propagate,
  featureHasOutgoingEdges,
  MODEL_BOUNDS,
  MORTGAGE_HOME_VALUE
} from '../../engine/index.mjs';
import {
  IMPOSSIBLE_TO_CHANGE,
  SMALL_STEP_FRACTION,
  LARGE_STEP_FRACTION,
  MIN_GAIN,
  ideaVerb,
  isBaselineActionable
} from './ideasConfig';

// Display names (mirrors FeaturePanel.DISPLAY_NAMES).
const DISPLAY_NAMES = {
  loan_amnt: 'Loan Amount', dti: 'Debt to Income Ratio',
  annual_inc: 'Annual Income', revol_bal: 'Unpaid Credit Card Balance',
  open_acc: 'Number of Open Accounts', fico_score: 'FICO Score',
  term: 'Payment Period', home_ownership: 'Home Ownership',
  purpose: 'Loan Purpose', inq_last_6mths: 'Number of Credit Inquiries',
  pub_rec_bankruptcies: 'Number of Bankruptcies', revol_util: 'Credit Utilization',
  total_acc: 'Number of Accounts', mort_acc: 'Number of Mortgages',
  earliest_cr_line: 'Credit History Length', emp_length: 'Employment Length',
  verification_status: 'Income Verification Status', delinq_2yrs: 'Number of Past Due',
  pub_rec: 'Number of Derogatory Records', application_type: 'Application Type'
};

const parseTermMonths = (termLabel) => {
  const match = String(termLabel || '').match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 36;
};

const engineValuesEqual = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
};

// ── Engine adapter (standalone; mirrors FeaturePanel) ────────────────────────
const toInternalValue = (feature, displayValue) => {
  if (!feature.isCont) return displayValue;
  let d = displayValue;
  if (feature.requiresInt) d = Math.round(d);
  return feature.transform === 'log10' ? (d > 0 ? Math.log10(d) : 0) : d;
};

const displayToInternal = (feature, displayValue) => {
  const name = feature.data.name;
  if (!feature.isCont && name === 'mort_acc') {
    const n = Math.round(displayValue);
    const labels = feature.labelEncoder ? Object.values(feature.labelEncoder) : [];
    const exact = String(n);
    return labels.includes(exact) ? exact : labels[labels.length - 1];
  }
  if (!feature.isCont) return displayValue;
  return toInternalValue(feature, displayValue);
};

const buildEngineState = (plan, getInternal) => {
  const state = {};
  plan.features.forEach((f) => {
    const name = f.data.name;
    const raw = getInternal(f);
    if (!f.isCont) {
      const label = typeof raw === 'number' && f.labelEncoder ? f.labelEncoder[raw] : raw;
      if (name === 'term') state[name] = parseTermMonths(label);
      else if (name === 'mort_acc') state[name] = label === '7+' ? 8 : (parseInt(label, 10) || 0);
      else if (name === 'inq_last_6mths') state[name] = label === '3+' ? 4 : (parseInt(label, 10) || 0);
      else state[name] = label;
    } else {
      state[name] = f.transform === 'log10' ? Math.pow(10, raw) : raw;
    }
  });
  return state;
};

const displayRange = (plan, name) => {
  if (MODEL_BOUNDS[name]) return MODEL_BOUNDS[name];
  const f = plan.features.find((ff) => ff.data.name === name);
  const bins = (f?.data?.binEdge || []).filter(Number.isFinite);
  if (bins.length >= 2) {
    let lo = bins[0];
    let hi = bins[bins.length - 1];
    if (f.transform === 'log10') { lo = Math.pow(10, lo); hi = Math.pow(10, hi); }
    return [lo, hi];
  }
  return null;
};

// ── Speculative evaluation (mirrors FeaturePanel.speculativeApprovalDelta) ────
const speculativeApprovalDelta = (plan, baseline, current, modifiedFeatures, deltas, candidateName, isCont, perturb) => {
  const engineVal = isCont
    ? perturb
    : candidateName === 'term'
    ? parseTermMonths(perturb)
    : perturb;

  const perturbed = { ...current };
  perturbed[candidateName] = engineVal;

  const specModified = new Set(modifiedFeatures);
  specModified.add(candidateName);

  let next = perturbed;
  if (featureHasOutgoingEdges(candidateName)) {
    const res = propagate(
      candidateName, baseline, perturbed, baseline,
      specModified, deltas.appliedHomeMortgage, deltas.userOpenDelta, deltas.userTotalDelta,
      deltas.userFicoDelta, deltas.userDtiDelta, deltas.userRevolDelta
    );
    next = res.state;
  }

  const sample = plan.ebmLocal.sample.slice();
  const cf = plan.features.find((f) => f.data.name === candidateName);
  sample[cf.featureID] = isCont ? toInternalValue(cf, perturb) : perturb;
  plan.features.forEach((f) => {
    const name = f.data.name;
    if (name === candidateName) return;
    if (next[name] !== undefined && !engineValuesEqual(next[name], current[name])) {
      sample[f.featureID] = displayToInternal(f, next[name]);
    }
  });

  const scores = plan.ebmLocal.countScore(sample);
  const logOdds = Object.values(scores).reduce((a, b) => a + b, 0) + plan.ebmLocal.intercept;
  return sigmoid(logOdds) - sigmoid(plan.ebmLocal.predScore);
};

const evaluateIdea = (plan, baseline, current, modifiedFeatures, deltas, feature) => {
  const name = feature.data.name;

  if (feature.isCont) {
    const range = displayRange(plan, name);
    if (!range) return null;
    const [lo, hi] = range;
    const cur = current[name];
    const clamp = (v) => Math.max(lo, Math.min(hi, v));
    const stepMag = (frac) => {
      const byValue = frac * Math.abs(cur);
      return byValue > 1e-9 ? byValue : frac * (hi - lo);
    };

    const evalStep = (frac) => {
      const mag = stepMag(frac);
      if (!(mag > 0)) return { dir: 'raise', gain: 0 };
      const up = speculativeApprovalDelta(plan, baseline, current, modifiedFeatures, deltas, name, true, clamp(cur + mag));
      const down = speculativeApprovalDelta(plan, baseline, current, modifiedFeatures, deltas, name, true, clamp(cur - mag));
      return { dir: up >= down ? 'raise' : 'lower', gain: Math.max(up, down) };
    };

    const small = evalStep(SMALL_STEP_FRACTION);
    const large = evalStep(LARGE_STEP_FRACTION);

    if (small.dir !== large.dir) return null; // Gate 3
    if (large.gain <= MIN_GAIN) return null; // Gate 4
    return { direction: small.dir, gain: large.gain };
  }

  // Categorical: best alternative level; "Change" is the only direction.
  const curLabel = current[name];
  const levels = feature.labelEncoder ? Object.values(feature.labelEncoder) : [];
  let best = 0;
  levels.forEach((lvl) => {
    const asEngine = name === 'term' ? parseTermMonths(lvl) : lvl;
    if (engineValuesEqual(asEngine, curLabel)) return;
    const eff = speculativeApprovalDelta(plan, baseline, current, modifiedFeatures, deltas, name, false, lvl);
    if (eff > best) best = eff;
  });
  if (best <= MIN_GAIN) return null;
  return { direction: 'change', gain: best };
};

/**
 * Compute the top 2–3 "Ideas to try" for one plan. Returns
 * [{ name, displayName, verb, direction, gain }] strongest first.
 * @param {import('../coach/Coach').Plan} plan
 * @param {import('../coach/Coach').Constraints} [constraints] for the runtime
 *        "Impossible to Change" (difficulty 'lock') exclusion.
 */
export function computeIdeasForPlan(plan, constraints) {
  if (!plan || !plan.ebmLocal) return [];

  const baseline = buildEngineState(plan, (f) => f.originalValue);
  const current = buildEngineState(plan, (f) => plan.ebmLocal.sample[f.featureID]);

  const modifiedFeatures = new Set();
  plan.features.forEach((f) => {
    const n = f.data.name;
    if (!engineValuesEqual(current[n], baseline[n])) modifiedFeatures.add(n);
  });

  const deltas = {
    appliedHomeMortgage:
      current.home_ownership === MORTGAGE_HOME_VALUE &&
      baseline.home_ownership !== MORTGAGE_HOME_VALUE
        ? 1
        : 0,
    userOpenDelta: 0,
    userTotalDelta: 0,
    userFicoDelta: 0,
    userDtiDelta: 0,
    userRevolDelta: 0
  };

  const ideas = [];
  plan.features.forEach((feature) => {
    const name = feature.data.name;
    if (constraints?.difficulties?.get(name) === IMPOSSIBLE_TO_CHANGE) return; // Gate 1 runtime
    if (!isBaselineActionable(name)) return; // Gate 1 baseline

    let res = null;
    try {
      res = evaluateIdea(plan, baseline, current, modifiedFeatures, deltas, feature);
    } catch (e) {
      res = null;
    }
    if (!res) return;
    ideas.push({
      name,
      displayName: DISPLAY_NAMES[name] || feature.data.description?.displayName || name,
      verb: ideaVerb(feature.isCont, res.direction),
      direction: res.direction,
      gain: res.gain
    });
  });

  ideas.sort((a, b) => b.gain - a.gain);
  return ideas.slice(0, 3);
}

// Features displayed as currency (mirrors FeaturePanel.MONEY_FEATURES).
const MONEY_FEATURES = new Set(['loan_amnt', 'annual_inc', 'revol_bal']);

/** Unit-aware display of a value in engine display units (mirrors FeaturePanel). */
const formatEffectValue = (name, val) => {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') {
    return val
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (name === 'dti' || name === 'revol_util') return Number(val).toFixed(2);
  const s = Math.round(Number(val)).toLocaleString();
  return MONEY_FEATURES.has(name) ? `$${s}` : s;
};

/**
 * A plan's SUGGESTED CHANGES as ideas WITH amounts — the coach's counterfactual
 * (cfDataRaw) diffed against the applicant baseline. Each plan yields its own,
 * distinct set (this is what makes Compare Plans meaningful now that every plan's
 * live state is re-baselined to the same user baseline). Mirrors FeaturePanel's
 * buildInitialIdeas so the main panel and Compare Plans agree.
 * @param {import('../coach/Coach').Plan} plan
 * @param {import('../coach/Coach').Constraints} [constraints]
 */
export function planSuggestedIdeas(plan, constraints) {
  if (!plan || !plan.cfDataRaw) return [];
  const baseline = buildEngineState(plan, (f) => f.originalValue);
  const suggested = buildEngineState(plan, (f) => plan.cfDataRaw[f.featureID]);
  const out = [];
  plan.features.forEach((feature) => {
    const name = feature.data.name;
    if (engineValuesEqual(suggested[name], baseline[name])) return; // coach didn't change it
    if (constraints?.difficulties?.get(name) === IMPOSSIBLE_TO_CHANGE) return;
    if (!isBaselineActionable(name)) return;
    const direction = feature.isCont
      ? Number(suggested[name]) > Number(baseline[name])
        ? 'raise'
        : 'lower'
      : 'change';
    out.push({
      name,
      displayName: DISPLAY_NAMES[name] || feature.data.description?.displayName || name,
      verb: ideaVerb(feature.isCont, direction),
      direction,
      mode: 'amount',
      targetDisplay: formatEffectValue(name, suggested[name]),
      // Value to APPLY on click (mirrors FeaturePanel.buildInitialIdeas): internal
      // for continuous (what the card + model use), the raw level LABEL for
      // categorical. We decode cfDataRaw directly rather than reusing
      // `suggested[name]`, because buildEngineState rewrites some categoricals to a
      // NUMBER (e.g. `term` → 36/60) that codeFromLabel can't map back to a level.
      applyValue: feature.isCont
        ? displayToInternal(feature, suggested[name])
        : (typeof plan.cfDataRaw[feature.featureID] === 'number' && feature.labelEncoder
            ? feature.labelEncoder[plan.cfDataRaw[feature.featureID]]
            : plan.cfDataRaw[feature.featureID])
    });
  });
  return out;
}
