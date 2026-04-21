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
 * @returns {HistoryEntry}
 */
export function createHistoryEntry(planIndex, plan, propagatedFeatures, previousScore, entryNumber, previousEntry) {
  const features = [];

  // Determine the baseline values: either from previous entry or from original input
  const baselineValues = {};
  if (previousEntry && previousEntry.features) {
    // Use previous entry's final values as baseline
    for (const feat of previousEntry.features) {
      baselineValues[feat.featureID] = feat.newValue;
    }
    // Also add unchanged features from previous entry
    for (const feature of plan.features) {
      if (!baselineValues.hasOwnProperty(feature.featureID)) {
        // This feature wasn't in previous entry, so use original
        baselineValues[feature.featureID] = plan.curExample[feature.featureID];
      }
    }
  } else {
    // First entry: use original values as baseline
    for (const feature of plan.features) {
      baselineValues[feature.featureID] = plan.curExample[feature.featureID];
    }
  }

  // Capture features that changed in THIS step (compared to previous state)
  for (const feature of plan.features) {
    const currentVal = plan.ebmLocal.sample[feature.featureID];
    const baselineVal = baselineValues[feature.featureID];

    // Only include features that changed in THIS step
    if (currentVal !== baselineVal) {
      const isAuto = propagatedFeatures && propagatedFeatures.has(feature.data.name);

      features.push({
        featureID: feature.featureID,
        name: feature.data?.description?.displayName || feature.data?.name || `Feature ${feature.featureID}`,
        oldValue: baselineVal,
        newValue: currentVal,
        displayOldValue: formatValue(baselineVal, feature),
        displayNewValue: formatValue(currentVal, feature),
        isAuto
      });
    }
  }

  const currentProb = Math.round(sigmoid(plan.ebmLocal.predScore) * 100);
  const previousProb = Math.round(sigmoid(previousScore) * 100);

  return {
    entryNumber,
    score: plan.ebmLocal.predScore,
    probPct: currentProb,
    previousScore,
    previousProbPct: previousProb,
    features,
    timestamp: Date.now(),
    isPinned: false
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

  // Renumber all entries after adding
  entries.push(entry);

  // Enforce 10-entry cap
  if (entries.length > 10) {
    // Find how many pinned entries there are
    const pinnedCount = entries.filter(e => e.isPinned).length;

    if (pinnedCount < 3) {
      // Remove oldest unpinned entry
      const unpinnedIdx = entries.findIndex(e => !e.isPinned);
      if (unpinnedIdx !== -1) {
        entries.splice(unpinnedIdx, 1);
      }
    } else {
      // All 3 pins used, remove oldest entry (pinned or not)
      entries.shift();
    }
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
 * Toggle pin on a history entry
 * @param {Map<number, HistoryEntry[]>} historyMap - Map of plan index to entries
 * @param {number} planIndex - Plan index
 * @param {number} entryIndex - Entry index within that plan
 * @returns {Map<number, HistoryEntry[]>} - Updated history map
 */
export function toggleEntryPin(historyMap, planIndex, entryIndex) {
  const entries = historyMap.get(planIndex) || [];
  const entry = entries[entryIndex];

  if (!entry) return historyMap;

  // Count current pins
  const currentPins = entries.filter(e => e.isPinned).length;

  // If trying to pin and already at 3, do nothing
  if (!entry.isPinned && currentPins >= 3) {
    return historyMap;
  }

  entry.isPinned = !entry.isPinned;

  const newMap = new Map(historyMap);
  newMap.set(planIndex, [...entries]);
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
