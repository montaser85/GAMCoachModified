import { sigmoid } from '../../ebm/ebm';

/**
 * Per-feature score decomposition — the SAME values that feed the hover
 * breakdown bar (ScorePanel.computeBreakdown). Data source and formula are
 * identical: each feature's contribution is its share of the net log-odds shift
 * (current − original per-feature EBM score), scaled to the total pp change.
 *
 * @param {import('../coach/Coach').Plan} plan
 * @returns {{ features: {name:string, displayName:string, delta:number, actualPP:number}[], totalPPChange:number }}
 */
export function computeScoreDrivers(plan) {
  if (!plan) return { features: [], totalPPChange: 0 };

  // Original applicant per-feature scores (frozen baseline) vs the live scores.
  const originalCountedScores = plan.ebmLocal.countScore(plan.curExample);
  const currentScores = plan.ebmLocal.countedScores;

  const curValue = sigmoid(plan.ebmLocal.predScore);
  const originalValue = sigmoid(plan.originalScore);

  const changed = [];
  plan.features.forEach((f) => {
    const name = f.data.name;
    const origScore = originalCountedScores[name] ?? 0;
    const curScore = currentScores[name] ?? 0;
    const delta = curScore - origScore;
    if (Math.abs(delta) > 1e-6) {
      const displayName =
        f.data.description?.displayName ||
        f.data.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      changed.push({ name, displayName, delta });
    }
  });

  if (changed.length === 0) return { features: [], totalPPChange: 0 };

  const totalLogOddsDelta = changed.reduce((s, d) => s + d.delta, 0); // net (signed)
  const totalPPChange = (curValue - originalValue) * 100;

  changed.forEach((d) => {
    // Each feature's share of the net log-odds shift, scaled to the total pp
    // change (identical to computeBreakdown's actualPP).
    d.actualPP =
      totalLogOddsDelta !== 0
        ? parseFloat(((d.delta / totalLogOddsDelta) * totalPPChange).toFixed(1))
        : 0;
  });

  return { features: changed, totalPPChange };
}
