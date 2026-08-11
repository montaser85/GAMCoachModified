import { writable } from 'svelte/store';

export const tooltipConfigStore = writable({
  show: false,
  html: 'null',
  left: 0,
  top: 0,
  width: 80,
  maxWidth: 80,
  fontSize: '14px',
  orientation: 's',
  mouseoverTimeout: null
});

export const constraintsStore = writable(null);

export const diffPickerConfigStore = writable({
  feature: null,
  focusOutTime: 0,
  difficulty: 'neutral',
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  action: ''
});

export const confirmModalConfigStore = writable({
  title: 'Confirmation',
  show: false,
  confirmed: false,
  contextLines: [''],
  confirmText: 'OK',
  cancelText: 'Cancel',
  doNotShowAgain: false,
  confirmCallback: () => null
});

export const bookmarkConfigStore = writable({
  show: false,
  features: null,
  plans: new Map(),
  focusOutTime: 0,
  plansInfo: null,
});

export const ratingFormConfigStore = writable({
  show: false,
  planRatings: [],
  action: ''
});

export const constraintRatingFormConfigStore = writable({
  show: false,
  constraintRatings: [],
  action: ''
});

export const inputFormConfigStore = writable({
  show: false,
  ebm: null,
  features: null,
  plansInfo: null,
  curExample: [],
  action: null
});

export const getInputFormConfigStore = () => {
  return writable({
    show: false,
    ebm: null,
    features: null,
    plansInfo: null,
    curExample: [],
    action: null
  });
};

export const ebmStore = writable({});

export const checkModalConfigStore = writable({
  show: false,
  ebm: null,
  modelData: null
});

// Maps feature name → internal value for programmatic slider overrides.
// FeatureCard subscribes and moves its slider when its name appears here.
export const featureValueOverrideStore = writable({});

// Set of feature names whose current values were changed via propagation
// (as opposed to direct user interaction).  FeaturePanel updates this
// whenever applyLoanAmountPropagation runs; ScorePanel reads it to label
// rows in the score-change breakdown popup as DIRECT or PROPAGATED.
export const propagatedFeaturesStore = writable(new Set());

// Score-change breakdown popup.  ScorePanel.js sets this from D3 event
// handlers; BreakdownPopup.svelte (rendered at app root, outside any CSS
// transform) reads it and renders the popup with position:absolute.
export const breakdownPopupStore = writable({ show: false, x: 0, y: 0, data: null, pinned: false });

// Incremented each time any FeatureCard header is clicked (expand/collapse).
// FeaturePanel subscribes to this to know it must recompute arrow positions
// throughout the 250 ms card animation.
export const cardToggleStore = writable(0);

// Controls the Plan Comparison modal visibility.
export const compareOpenStore = writable(false);

// Sidebar open/closed state
export const historySidebarOpenStore = writable(false);

// History entries per plan: Map<planIndex, HistoryEntry[]>
// Each HistoryEntry contains: { entryNumber, score, probPct, features, timestamp, previousScore }
export const historyEntriesStore = writable(new Map());

// Flag to indicate when we're restoring a history entry (to prevent new entry creation)
export const isRestoringEntryStore = writable(false);

// "Effects of your changes" (right panel, last section). An array of source-edit
// events, NEWEST FIRST. Each event describes one source feature the user edited
// and the dependent features that changed via propagation as a result:
//   {
//     sourceName, sourceDisplayName, sourceValueDisplay,
//     effects: [{ depName, depDisplayName, beforeDisplay, afterDisplay,
//                 helps, contributionDelta, tooltip }]
//   }
// FeaturePanel writes to it from triggerPropagation (reusing the engine's
// existing propagation output + the same per-feature contribution used by
// "What's driving this score"). ChangeEffects.svelte renders it. Cleared when
// FeaturePanel (re)initializes (plan switch / regenerate / restore).
export const changeEffectsStore = writable([]);

// "Ideas to try" (right panel). An array of directional next-step suggestions,
// STRONGEST FIRST (top 2–3). Each entry:
//   { name, displayName, verb, direction, gain }
// where verb ∈ {Lower, Raise, Change}, direction ∈ {raise, lower, change},
// gain = the isolated speculative propagated approval gain used for ranking.
// FeaturePanel computes it via the side-effect-free what-if evaluation and
// publishes it here; IdeasToTry.svelte renders the amber lever chips.
export const ideasStore = writable([]);

// Transient inline hint for the Derogatory-Records floor guard: when the user
// tries to set Number of Derogatory Records below their current Number of
// Bankruptcies, the edit is clamped and a brief message is shown on that card.
// Shape: { feature: string, message: string, token: number } — token changes on
// each trigger so the card re-shows/re-times even for an identical message.
// Empty object = no hint.
export const derogFloorHintStore = writable({});