/**
 * History Manager for tracking exploration state changes per plan
 *
 * Manages:
 * - Creating history entries when score changes
 * - Pinning/unpinning entries
 * - Removing old entries when cap is reached
 * - Restoring previous states
 */

/**
 * Create a history entry from a plan state
 * @param {number} planIndex - Plan index
 * @param {Plan} plan - The current plan object
 * @param {Set<string>} propagatedFeatures - Set of feature names that were auto-changed
 * @param {number} previousScore - Previous probability (for delta calculation)
 * @param {number} entryNumber - Sequential entry number
 * @param {HistoryEntry} previousEntry - Previous entry (to compare against) or null for first entry
 * @param {object} initialFeatureState - Initial feature state (after coach suggestions) for first entry
 * @returns {HistoryEntry}
 */
export function createHistoryEntry(planIndex, plan, propagatedFeatures, previousScore, entryNumber, previousEntry, initialFeatureState) {
  const changedFeatures = [];
  const unchangedFeatures = [];

  // Determine the baseline values: either from previous entry's complete state, initial state, or original input
  const baselineValues = {};
  if (previousEntry && previousEntry.allFeatureValues) {
    // Use the complete feature state from previous entry as baseline
    // This includes all features, not just the ones that changed
    Object.assign(baselineValues, previousEntry.allFeatureValues);
  } else if (initialFeatureState) {
    // First entry: use the initial state (after coach suggestions were applied)
    Object.assign(baselineValues, initialFeatureState);
  } else {
    // Fallback: use original values as baseline
    for (const feature of plan.features) {
      baselineValues[feature.featureID] = plan.curExample[feature.featureID];
    }
  }

  // Capture all features - both changed and unchanged
  for (const feature of plan.features) {
    try {
      const currentVal = plan.ebmLocal.sample[feature.featureID];
      const baselineVal = baselineValues[feature.featureID];
      const displayName = feature.data?.description?.displayName || feature.data?.name || `Feature ${feature.featureID}`;

      // Check if feature changed
      if (currentVal !== baselineVal) {
        // Determine if this feature was auto-changed (propagated)
        // Check if the feature name appears in propagatedFeatures (same logic as arrows)
        const featureName = feature.data?.name;
        const isAuto = propagatedFeatures && featureName && propagatedFeatures.has(featureName);

        changedFeatures.push({
          featureID: feature.featureID,
          name: displayName,
          oldValue: baselineVal,
          newValue: currentVal,
          displayOldValue: formatValue(baselineVal, feature),
          displayNewValue: formatValue(currentVal, feature),
          isAuto: isAuto || false  // Default to false if propagation check fails
        });
      } else {
        // Feature didn't change - add to unchanged list
        unchangedFeatures.push({
          featureID: feature.featureID,
          name: displayName,
          value: currentVal,
          displayValue: formatValue(currentVal, feature)
        });
      }
    } catch (error) {
      // Silently skip features with errors in propagation logic
      // They will be treated as direct changes if they appear in the history
    }
  }

  const currentProb = Math.round(sigmoid(plan.ebmLocal.predScore) * 100);
  const previousProb = Math.round(sigmoid(previousScore) * 100);

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
    features: changedFeatures,  // Features that changed (DIRECT or AUTO)
    unchangedFeatures: unchangedFeatures,  // Features that didn't change
    allFeatureValues,  // Store complete state for next baseline
    timestamp: Date.now()
  };
}

/**
 * Format a value for display (reuse from FeatureCard logic)
 */
function formatValue(val, feature) {
  if (val === null || val === undefined) return '—';

  if (feature.data?.type === 'categorical') {
    const enc = feature.labelEncoder;
    if (enc) {
      const entry = Object.entries(enc).find(([, v]) => v === val);
      return entry ? entry[0] : String(val);
    }
    return String(val);
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
export function addHistoryEntry(historyMap, planIndex, entry) {
  const entries = historyMap.get(planIndex) || [];

  // Add the new entry
  entries.push(entry);

  // Enforce 10-entry cap (remove oldest entry if exceeded)
  if (entries.length > 10) {
    entries.shift();
  }

  // Renumber all entries
  entries.forEach((e, idx) => {
    e.entryNumber = idx + 1;
  });

  // Ensure we have a copy of the array with the updated entries
  const newMap = new Map(historyMap);
  newMap.set(planIndex, [...entries]);  // Create a new array reference for reactivity
  return newMap;
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
