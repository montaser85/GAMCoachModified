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