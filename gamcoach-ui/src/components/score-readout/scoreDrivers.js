import { sigmoid } from '../../ebm/ebm';

// ── Interaction attribution (tunable) ────────────────────────────────────────
// The EBM's pairwise interaction terms ("i x j") are no longer left unattributed
// (which smeared their movement proportionally across all changed main-effect
// bars). Each interaction term's change is instead attributed to the two features
// that constitute it, so the interaction mass lands on the features responsible.
//
// Split rule when BOTH constituents changed value: divide the interaction delta
// between them by INTERACTION_SPLIT_FIRST (default 0.5 → an even 50/50 split).
// Implemented as a strategy function so it can later become, e.g., main-effect-
// magnitude-proportional WITHOUT touching the attribution loop.
export const INTERACTION_SPLIT_FIRST = 0.5; // fraction to the pair's FIRST feature

/**
 * Weights [w1, w2] (summing to 1) for splitting an interaction delta between the
 * pair's two features when both changed. `ctx` (the per-feature records) is
 * passed so a future strategy can weight by main-effect magnitude, etc.
 */
function interactionSplitWeights(name1, name2, ctx) {
  return [INTERACTION_SPLIT_FIRST, 1 - INTERACTION_SPLIT_FIRST];
}

const valuesEqual = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
};

const defaultDisplayName = (name) =>
  name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Per-feature score decomposition for "What's driving this score".
 *
 * Each feature's contribution is the change (current − original) in its own EBM
 * main-effect score PLUS its attributed share of any pairwise interaction terms
 * it participates in. The result is scaled to the true approval-probability
 * change (pp), so the bars sum to the actual total change.
 *
 * @param {import('../coach/Coach').Plan} plan
 * @returns {{ features: {name:string, displayName:string, delta:number, actualPP:number}[], totalPPChange:number }}
 */
export function computeScoreDrivers(plan) {
  if (!plan) return { features: [], totalPPChange: 0 };

  // Per-feature EBM scores: the ORIGINAL applicant profile vs the live plan. The
  // reference is the pre-fold original profile (the applicant's own DTI), so the
  // decomposition matches `originalScore` and, on load, surfaces the applied-loan DTI
  // fold as a driver "from the original". Falls back to curExample for older plans.
  const reference = plan.originalExample || plan.curExample;
  const originalCountedScores = plan.ebmLocal.countScore(reference);
  const currentScores = plan.ebmLocal.countedScores;

  const curValue = sigmoid(plan.ebmLocal.predScore);
  const originalValue = sigmoid(plan.originalScore);

  // ── 1. Main-effect delta + value-change flag, per feature ───────────────────
  // `valueChanged` is the feature's own VALUE moving (sample vs original) — NOT
  // its score moving — so a feature that changed but stayed in the same bin can
  // still receive interaction mass, and an unchanged feature never does.
  /** @type {Map<string, {name:string, displayName:string, delta:number, valueChanged:boolean}>} */
  const byName = new Map();
  plan.features.forEach((f) => {
    const name = f.data.name;
    const fid = f.featureID;
    const mainDelta = (currentScores[name] ?? 0) - (originalCountedScores[name] ?? 0);
    const valueChanged = !valuesEqual(plan.ebmLocal.sample[fid], reference[fid]);
    byName.set(name, {
      name,
      displayName: f.data.description?.displayName || defaultDisplayName(name),
      delta: mainDelta,
      valueChanged
    });
  });

  // ── 2. Attribute each interaction term's change to its constituent feature(s) ─
  Object.keys(currentScores).forEach((key) => {
    if (!key.includes(' x ')) return; // main-effect keys have no " x "
    const sep = key.indexOf(' x ');
    const n1 = key.slice(0, sep);
    const n2 = key.slice(sep + 3);
    const r1 = byName.get(n1);
    const r2 = byName.get(n2);
    if (!r1 && !r2) return;

    const interDelta = (currentScores[key] ?? 0) - (originalCountedScores[key] ?? 0);
    if (Math.abs(interDelta) <= 1e-9) return; // interaction didn't move

    const c1 = !!(r1 && r1.valueChanged);
    const c2 = !!(r2 && r2.valueChanged);

    if (c1 && c2) {
      // Both changed → split (default 50/50).
      const [w1, w2] = interactionSplitWeights(n1, n2, byName);
      r1.delta += interDelta * w1;
      r2.delta += interDelta * w2;
    } else if (c1) {
      // Only feature 1 changed → assign the full interaction delta to it.
      r1.delta += interDelta;
    } else if (c2) {
      // Only feature 2 changed → assign the full interaction delta to it.
      r2.delta += interDelta;
    }
    // Neither constituent's value changed → interDelta is ~0 anyway; attribute
    // nothing, so an unchanged-value feature never gets a bar.
  });

  // ── 3. Keep features with a non-negligible total contribution change ────────
  const changed = [];
  byName.forEach((r) => {
    if (Math.abs(r.delta) > 1e-6) {
      changed.push({ name: r.name, displayName: r.displayName, delta: r.delta });
    }
  });

  if (changed.length === 0) return { features: [], totalPPChange: 0 };

  // ── 4. Scale to the true approval-probability change (pp) ───────────────────
  // totalLogOddsDelta now includes the interaction movement, so it equals the
  // real log-odds change and the previously-smeared residual is gone — the bars
  // still sum to totalPPChange.
  const totalLogOddsDelta = changed.reduce((s, d) => s + d.delta, 0);
  const totalPPChange = (curValue - originalValue) * 100;

  changed.forEach((d) => {
    d.actualPP =
      totalLogOddsDelta !== 0
        ? parseFloat(((d.delta / totalLogOddsDelta) * totalPPChange).toFixed(1))
        : 0;
  });

  return { features: changed, totalPPChange };
}
