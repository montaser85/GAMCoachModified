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

// Incremented each time any FeatureCard header is clicked (expand/collapse).
// FeaturePanel subscribes to this to know it must recompute arrow positions
// throughout the 250 ms card animation.
export const cardToggleStore = writable(0);