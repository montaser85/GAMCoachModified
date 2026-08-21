/**
 * History Manager for tracking exploration state changes per plan
 *
 * Manages:
 * - Creating history entries when score changes
 * - Pinning/unpinning entries
 * - Removing old entries when cap is reached
 * - Restoring previous states
 */

import { appliedLoanDtiContribution } from '../engine/index.mjs';

/**
 * Displayed approval percentage that never CONTRADICTS the approval status. Approval
 * keys off the TRUE probability (≥ 0.5), so a score like 0.4966 is "not approved" —
 * but a plain round() would show it as "50%" (looks approved). Floor a not-approved
 * score to 49 and lift an approved score to 50, so "50%" always means approved.
 */
function approvalPct(prob) {
  const raw = Math.round((prob || 0) * 100);
  return prob >= 0.5 ? Math.max(50, raw) : Math.min(49, raw);
}

/**
 * The applicant's RAW profile DTI (model units), i.e. the load-time baseline DTI
 * with the applied-for loan's fold removed — matching the DTI feature card's left
 * (profile) value. Returns null if DTI isn't present.
 */
function rawProfileDtiValue(plan) {
  const dtiFeat = plan.features.find((f) => f.data?.name === 'dti');
  if (!dtiFeat) return null;
  const names = plan.features.map((f) => f.data.name);
  const example = plan.features.map((f) => plan.curExample[f.featureID]);
  const contribution = appliedLoanDtiContribution(example, names);
  return (plan.curExample[dtiFeat.featureID] || 0) - contribution;
}

/**
 * Create a history entry from a plan state.
 *
 * The changed/unchanged split is a CUMULATIVE SNAPSHOT against the load-time
 * baseline (the applicant's starting application, plan.curExample) — never a
 * diff of the last interaction. A feature edited and later returned to its
 * baseline value lands back in "unchanged".
 *
 * @param {number} planIndex - Plan index
 * @param {Plan} plan - The current plan object
 * @param {Set<string>} propagatedFeatures - (unused; kept for call-site parity)
 * @param {number} previousScore - Previous probability (for delta calculation)
 * @param {number} entryNumber - Sequential entry number
 * @returns {HistoryEntry}
 */
export function createHistoryEntry(planIndex, plan, propagatedFeatures, previousScore, entryNumber, previousEntry = null, initialState = null) {
  const changedFeatures = [];
  const unchangedFeatures = [];

  // State at the PREVIOUS entry (or the post-coach-suggestion initial state for the
  // first entry). Used to flag which features the user changed in THIS step so they
  // sort to the top of the list — the change the user just made leads.
  const prevValues =
    (previousEntry && previousEntry.allFeatureValues) || initialState || null;

  // Per-feature score contributions (log-odds) vs the original profile — the
  // same values that color the score-breakdown and plan-comparison panels:
  // >0 raised approval (blue), <0 lowered it (red).
  let origScores = {};
  let curScores = {};
  try {
    origScores = plan.ebmLocal.countScore(plan.curExample);
    curScores = plan.ebmLocal.countScore(plan.ebmLocal.sample);
  } catch (e) {
    // Leave empty → contributions default to 0 (neutral).
  }

  // Capture all features - both changed and unchanged (vs load-time baseline).
  for (const feature of plan.features) {
    try {
      const currentVal = plan.ebmLocal.sample[feature.featureID];
      const baselineVal = plan.curExample[feature.featureID];
      const displayName = feature.data?.description?.displayName || feature.data?.name || `Feature ${feature.featureID}`;
      const featureName = feature.data?.name;

      const displayNewValue = formatValue(currentVal, feature);
      const displayBaselineValue = formatValue(baselineVal, feature);

      // Compare on the DECODED labels: the baseline stores category codes while
      // the live sample stores label strings, so raw comparison would misfire.
      if (displayNewValue !== displayBaselineValue) {
        // Did the user change this feature in THIS step (differs from the previous
        // entry / initial state)? Those lead the list.
        const recentlyChanged = prevValues
          ? formatValue(prevValues[feature.featureID], feature) !== displayNewValue
          : false;
        // For DTI, show the applicant's RAW profile DTI on the left (matching the
        // DTI card's left value) — not the loan-folded baseline. The changed/
        // unchanged determination above still uses the folded baseline.
        let displayOldValue = displayBaselineValue;
        if (featureName === 'dti') {
          const raw = rawProfileDtiValue(plan);
          if (raw != null) displayOldValue = formatValue(raw, feature);
        }
        changedFeatures.push({
          featureID: feature.featureID,
          name: displayName,
          displayOldValue,                       // from = profile value (raw for DTI)
          displayNewValue,                       // to = value at this entry
          contribution: (curScores[featureName] ?? 0) - (origScores[featureName] ?? 0),
          recentlyChanged,
          // The user's DIRECT edit this step (changed, but not via propagation).
          propagated: !!(propagatedFeatures && propagatedFeatures.has(featureName))
        });
      } else {
        unchangedFeatures.push({
          featureID: feature.featureID,
          name: displayName,
          value: currentVal,
          displayValue: displayNewValue
        });
      }
    } catch (error) {
      // Silently skip features with errors; they will simply not be listed.
    }
  }

  // Lead with the change the user just made: their DIRECT edit this step first,
  // then that edit's propagated effects, then the rest (coach-suggested / earlier
  // changes). Stable — preserves the original model order within each tier.
  const rank = (f) =>
    f.recentlyChanged && !f.propagated ? 0 : f.recentlyChanged ? 1 : 2;
  changedFeatures.sort((a, b) => rank(a) - rank(b));

  const currentProb = approvalPct(sigmoid(plan.ebmLocal.predScore));
  const previousProb = approvalPct(sigmoid(previousScore));

  // Store the complete current state of ALL features (not just changed ones)
  // This is needed to correctly determine what changed in the NEXT entry
  const allFeatureValues = {};
  for (const feature of plan.features) {
    allFeatureValues[feature.featureID] = plan.ebmLocal.sample[feature.featureID];
  }

  return {
    entryNumber,
    score: plan.ebmLocal.predScore,
    probPct: currentProb,
    previousScore,
    previousProbPct: previousProb,
    features: changedFeatures,  // Features that differ from the load-time baseline
    unchangedFeatures: unchangedFeatures,  // Features still at their baseline value
    allFeatureValues,  // Complete state (used by Restore)
    saved: false,  // Star/bookmark: saved entries are pinned (never auto-pruned)
    timestamp: Date.now()
  };
}

/** "debt_consolidation" → "Debt consolidation", "MORTGAGE" → "Mortgage". */
function prettifyLabel(s) {
  const t = String(s).replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Format a value for display, ALWAYS decoding categoricals to their label (never
 * a raw index). The stored value may be a category CODE or an already-decoded
 * LABEL, so both directions of the feature's {code: label} encoder are handled.
 */
function formatValue(val, feature) {
  if (val === null || val === undefined) return '—';

  if (feature.data?.type === 'categorical') {
    const enc = feature.labelEncoder; // {code: label}
    if (enc) {
      if (enc[val] !== undefined) return prettifyLabel(enc[val]);       // code → label
      if (Object.values(enc).includes(val)) return prettifyLabel(val);  // already a label
    }
    return prettifyLabel(val);
  }

  if (feature.transform === 'log10') {
    val = Math.pow(10, val);
  }

  if (val >= 1000) {
    return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  if (feature.requiresInt) return Math.round(val).toString();

  return parseFloat(val.toFixed(2)).toString();
}

/**
 * Sigmoid function for probability conversion
 */
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Add a history entry for a plan
 * @param {Map<number, HistoryEntry[]>} historyMap - Map of plan index to entries
 * @param {number} planIndex - Plan to add entry to
 * @param {HistoryEntry} entry - The entry to add
 * @returns {Map<number, HistoryEntry[]>} - Updated history map
 */
// Lifecycle caps (independent): up to 15 transient (unsaved) entries pruned
// FIFO, and up to 5 saved entries which are pinned — never auto-pruned.
export const MAX_TRANSIENT_ENTRIES = 15;
export const MAX_SAVED_ENTRIES = 5;

export function addHistoryEntry(historyMap, planIndex, entry) {
  const entries = historyMap.get(planIndex) || [];

  // Add the new entry (always transient at creation)
  entries.push(entry);

  // FIFO-prune the OLDEST UNSAVED entries beyond the transient cap. Saved
  // entries are skipped — pruning never touches them.
  let unsavedCount = entries.filter((e) => !e.saved).length;
  while (unsavedCount > MAX_TRANSIENT_ENTRIES) {
    const oldestUnsaved = entries.findIndex((e) => !e.saved);
    entries.splice(oldestUnsaved, 1);
    unsavedCount -= 1;
  }

  // Renumber all entries (numbering always reflects list order; oldest = 1)
  entries.forEach((e, idx) => {
    e.entryNumber = idx + 1;
  });

  // Ensure we have a copy of the array with the updated entries
  const newMap = new Map(historyMap);
  newMap.set(planIndex, [...entries]);  // Create a new array reference for reactivity
  return newMap;
}

/**
 * Toggle an entry's saved (starred) state.
 * - Saving is blocked (ok:false, reason:'cap') when MAX_SAVED_ENTRIES entries
 *   are already saved — never silently discards an existing save.
 * - Unsaving returns the entry to the transient pool.
 * @returns {{map: Map, ok: boolean, reason?: string}}
 */
export function toggleSaveEntry(historyMap, planIndex, entry) {
  const entries = historyMap.get(planIndex) || [];
  const target = entries.find(
    (e) => e === entry || (e.timestamp === entry.timestamp && e.score === entry.score)
  );
  if (!target) return { map: historyMap, ok: false, reason: 'missing' };

  if (target.saved) {
    target.saved = false;
  } else {
    const savedCount = entries.filter((e) => e.saved).length;
    if (savedCount >= MAX_SAVED_ENTRIES) {
      return { map: historyMap, ok: false, reason: 'cap' };
    }
    target.saved = true;
  }

  const newMap = new Map(historyMap);
  newMap.set(planIndex, [...entries]);
  return { map: newMap, ok: true };
}

/**
 * Get current history entries for a plan
 * @param {Map<number, HistoryEntry[]>} historyMap
 * @param {number} planIndex
 * @returns {HistoryEntry[]}
 */
export function getHistoryForPlan(historyMap, planIndex) {
  return historyMap.get(planIndex) || [];
}
