<script>
  // @ts-check
  import FeatureCard from '../feature-card/FeatureCard.svelte';
  import FeatureCardCat from '../feature-card-cat/FeatureCardCat.svelte';
  import { FeatureGrid } from './FeaturePanel';

  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG } from '../../utils/utils';
  import '../../typedef';
  import { EBMLocal } from '../../ebm/ebmLocal';
  import { Plan, Constraints } from '../coach/Coach';

  import { onMount, onDestroy, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { tooltipConfigStore, featureValueOverrideStore, cardToggleStore, propagatedFeaturesStore } from '../../store';
  import {
    propagate,
    allDependentFeatures,
    featureHasOutgoingEdges,
    computeParams,
    computeDtiParts,
    creditLimitFromBaseline,
    EDGES
  } from '../../engine/index.mjs';

  export let windowLoaded = false;
  export let planStore = null;
  export let constraintsStore = null;

  /** @type {Logger} */
  export let logger = null;

  const unsubscribes = [];

  // Set up tooltip
  let tooltipConfig = null;
  unsubscribes.push(
    tooltipConfigStore.subscribe(value => {tooltipConfig = value;})
  );

  // Component variables
  /** @type {HTMLElement}*/
  let component = null;
  let initialized = false;
  let mounted = false;

  /** @type {Plan} */
  let plan = null;

  /** @type {Constraints} */
  let constraints = null;

  /** @type {HTMLElement}*/
  let leftColumn = null;

  /** @type {HTMLElement}*/
  let midColumn = null;

  /** @type {HTMLElement}*/
  let rightColumn = null;

  /** @type {FeatureGrid} */
  let featureGrid = new FeatureGrid();

  let maxFeatureNum = 'null';

  // ── Link-popup explanatory text for indirectly-affected features ────────────
  // Add an entry here whenever a feature gets real calculation mechanics so the
  // popup shows an informative message instead of the default placeholder.
  const LINK_POPUP_TEXT = {
    'fico_score': "A new loan requires a hard credit inquiry — a formal review process that lenders use to assess applicant's creditworthiness. One hard inquiry will typically reduce credit score by fewer than five points.",
    'dti': "A new loan adds to your monthly debt obligations, increasing your Debt-to-Income ratio. A higher DTI signals greater financial risk to lenders, as a larger share of your income is committed to debt repayment.",
    'revol_bal':  "When a loan is taken for credit card payoff or debt consolidation, the proceeds are used to pay down your revolving balance — the total outstanding amount owed on revolving credit accounts such as credit cards.",
    'revol_util': "Reducing revolving balance reduces credit utilization and generally improves credit profile."
  };

  // Reactive calculations displayed in popup once propagation has been applied.
  // null = don't show the calculation block yet.
  let ficoLinkCalculation     = null;
  let dtiLinkCalculation      = null;
  let revolBalLinkCalculation = null;
  let revolUtilLinkCalculation = null;

  // ── Causal Propagation Engine wiring ────────────────────────────────────────
  // The engine (src/engine) is the single source of truth for every
  // indirect/dependent change. The set of features that can be indirectly
  // changed — used to show the linked icon — is derived from the engine's
  // declarative edge set so the UI always matches the implemented edges.
  const ALL_TARGETS = allDependentFeatures();

  // The applicant's ORIGINAL input profile, in engine display units, frozen at
  // load. This is the single baseline for every net-change computation
  // (engine Section 8). Built in initLastKnownValues() once the plan is ready.
  /** @type {Record<string, number|string>|null} */
  let applicantBaselineState = null;

  // RESET_TO_LOAD_STATE: snapshot of the model's sample exactly as it appears on
  // first load (suggested values on suggested features, profile values on
  // everything else including dependents). Captured once at init and never
  // mutated. Reset restores from this snapshot instead of propagating.
  /** @type {Array<number|string>|null} */
  let loadTimeSample = null;

  // Names of features the user has modified (directly edited, or changed via
  // propagation from an edit) and NOT since reset. Drives the blue outline.
  // A feature stays "modified" even if its value coincidentally returns to the
  // load-time value — only a reset clears it.
  let modifiedFeatures = new Set();
  // Display names for all features — used in arrow labels
  const DISPLAY_NAMES = {
    'loan_amnt': 'Loan Amount', 'dti': 'Debt to Income Ratio',
    'annual_inc': 'Annual Income', 'revol_bal': 'Revolving Balance',
    'open_acc': 'Number of Open Accounts', 'fico_score': 'FICO Score',
    'term': 'Payment Period', 'home_ownership': 'Home Ownership',
    'purpose': 'Loan Purpose', 'inq_last_6mths': 'Number of Credit Inquiries',
    'pub_rec_bankruptcies': 'Number of Bankruptcies', 'revol_util': 'Credit Utilization',
    'total_acc': 'Number of Accounts', 'mort_acc': 'Number of Mortgages',
    'earliest_cr_line': 'Credit History Length', 'emp_length': 'Employment Length',
    'verification_status': 'Verification Status', 'delinq_2yrs': 'Number of Past Due',
    'pub_rec': 'Number of Derogatory Records', 'application_type': 'Application Type'
  };

  let showPropagationMessage = false;
  let propagationMessage = '';
  let bannerEl = null;
  let showArrows = false;
  let arrowPaths = [];
  let arrowLabels = [];
  let arrowDismissBtn = null;   // { x, y } for the single × button near the source card
  let panelClipRect = null;
  let propagationDebounceTimer = null;
  // Remembered so the scroll handler can redraw arrows at updated positions
  let lastArrowSource = null;
  let lastArrowTargets = [];
  let scrollRafId = null;
  let cardAnimRafId = null;   // rAF handle for the card-expand/collapse loop
  let cardAnimEndTime = 0;    // timestamp after which the loop should stop
  // Track last known values to avoid triggering on card expansion (not real user changes)
  let lastKnownValues = {};
  // Snapshot of every feature's value at page-load time (coach suggestions).
  // Never modified after initialization — used as the baseline for all propagation
  // calculations so that repeated changes don't stack on top of each other.
  let originalValues = {};

  // Set up the GAM Coach feature cards
  const initFeatureCards = () => {
    initialized = true;

    // Subscribe to the plan store and initialize features
    unsubscribes.push(
      planStore.subscribe(value => {
        plan = value;
      })
    );

    unsubscribes.push(
      constraintsStore.subscribe(value => {
        constraints = value;
      })
    );

    if (constraints.maxNumFeaturesToVary === null) {
      maxFeatureNum = 'null';
    } else {
      maxFeatureNum = `${constraints.maxNumFeaturesToVary}`;
    }

    // Organize the features into corresponding sections
    featureGrid.loadFeatures(plan.features, constraints);
    featureGrid = featureGrid;

    // Seed lastKnownValues with the initial coach-suggested values so that
    // the propagation helpers have baseline data even before the user moves any slider.
    initLastKnownValues();

    // console.log(featureGrid);
  };

  /**
   * Handler when cur feature is updated by the user
   * @param {CustomEvent} e
   * @param {Feature} feature
   */
  const curValueUpdatedHandler = (e, feature) => {
    // RESET_TO_LOAD_STATE: a reset restores the load-time snapshot for this
    // feature, its direct sources, and the affected dependents — WITHOUT
    // running propagation. Edits (no isReset flag) still propagate below.
    if (e.detail.isReset) {
      handleFeatureReset(feature.data.name);
      return;
    }

    let newValue = e.detail.newValue;

    // Encode the level if it is a categorical feature
    if (feature.data.type === 'categorical') {
      newValue = feature.labelEncoder[newValue];
    }

    // Update the local EBM
    plan.ebmLocal.updateFeature(feature.data.name, newValue);

    // Persist the user's chosen value on the feature object so that when the
    // plan tab is revisited (causing FeatureCard to remount), the slider
    // re-initialises to this value instead of falling back to coachValue.
    feature.hypotheticalValue = newValue;

    // Update the store
    planStore.set(plan);

    // Only trigger propagation if the value actually changed from what was last seen.
    // This prevents arrows firing when a card is expanded (which replays the current value).
    const featureName = feature.data.name;
    const previousValue = lastKnownValues[featureName];
    lastKnownValues[featureName] = newValue;

    if (previousValue !== undefined && previousValue !== newValue) {
      // The user actively edited this feature — mark it modified (drives the
      // blue outline). Stays set even if the value later returns to the load
      // value; only a reset clears it.
      modifiedFeatures.add(featureName);
      modifiedFeatures = modifiedFeatures;

      // Debounce — only fire after user stops dragging (350ms of silence)
      if (propagationDebounceTimer) clearTimeout(propagationDebounceTimer);
      propagationDebounceTimer = setTimeout(() => {
        propagationDebounceTimer = null;
        triggerPropagation(featureName);
      }, 350);
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // RESET_TO_LOAD_STATE — restore load-time values instead of propagating
  // ────────────────────────────────────────────────────────────────────────────

  /** Direct source features of `name` (one level up): features that write to it. */
  const sourcesOf = (name) =>
    Object.entries(EDGES)
      .filter(([, edges]) => edges.some(e => e.dependent === name))
      .map(([src]) => src);

  /**
   * Restore a single feature to its load-time snapshot value (model + card +
   * bookkeeping) and clear its modified flag. Returns true if applied.
   */
  const restoreToLoadTime = (name, overrides) => {
    const f = plan.features.find(ff => ff.data.name === name);
    if (!f) return false;
    const loadVal = loadTimeSample[f.featureID];
    if (loadVal === undefined) return false;
    plan.ebmLocal.updateFeature(name, loadVal);
    f.hypotheticalValue = loadVal;
    lastKnownValues[name] = loadVal;
    overrides[name] = loadVal;
    modifiedFeatures.delete(name);
    return true;
  };

  /**
   * Reset handler.
   * 1. Restore the reset feature and its direct sources (one level up) to their
   *    load-time values and clear their modified flags.
   * 2. Recompute the affected dependents from the STILL-modified sources
   *    (respecting DTI_USER_EDITS_ONLY) — so a dependent keeps the contributions
   *    of sources the user hasn't reset, and only falls back to its profile
   *    value when all of its sources are unmodified.
   * @param {string} featureName
   */
  const handleFeatureReset = (featureName) => {
    if (!plan || !loadTimeSample) return;

    const overrides = {};

    // ── 1. Un-modify: reset feature + its direct sources -> load-time ─────────
    const unmodify = new Set([featureName, ...sourcesOf(featureName)]);
    unmodify.forEach(name => restoreToLoadTime(name, overrides));
    modifiedFeatures = modifiedFeatures;

    // ── 2. Recompute affected dependents from the remaining modified state ────
    // Restoring a SOURCE (e.g. Open Accounts / Mortgages) changes that source's
    // OTHER dependents (e.g. FICO, Number of Accounts). So recompute the
    // dependents of every restored feature — the reset feature AND its sources —
    // not just the reset feature (which may itself be a leaf, e.g. total_acc).
    const baseline = applicantBaselineState;
    const current = buildCurrentEngineState();
    const recomputed = {};
    unmodify.forEach(src => {
      const { state: next, log } = propagate(src, baseline, current, baseline, modifiedFeatures);
      log.filter(l => !l.note).forEach(l => {
        if (!unmodify.has(l.dependent)) recomputed[l.dependent] = next[l.dependent];
      });
    });

    Object.entries(recomputed).forEach(([dep, val]) => {
      const internal = displayToInternal(dep, val);
      plan.ebmLocal.updateFeature(dep, internal);
      const f = plan.features.find(ff => ff.data.name === dep);
      if (f) f.hypotheticalValue = internal;
      lastKnownValues[dep] = internal;
      overrides[dep] = internal;

      // A recomputed dependent stays modified (outline stays) only while at
      // least one of its sources is still modified; otherwise it is back to its
      // profile value and un-modifies.
      if (sourcesOf(dep).some(s => modifiedFeatures.has(s))) {
        modifiedFeatures.add(dep);
      } else {
        modifiedFeatures.delete(dep);
      }
    });
    modifiedFeatures = modifiedFeatures;

    // Push all restored/recomputed values to the store and the cards.
    planStore.set(plan);
    featureValueOverrideStore.set(overrides);
    setTimeout(() => featureValueOverrideStore.set({}), 400);

    // Reset is NOT a user propagation — clear any propagation UI it might collide with.
    propagatedFeaturesStore.set(new Set());
    showPropagationMessage = false;
    dismissArrows();
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Value helpers — read / convert feature values from lastKnownValues or plan
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Seed lastKnownValues AND originalValues with each feature's coach/suggested
   * value at page-load time.  originalValues is never modified after this point
   * so it always represents the starting baseline for propagation calculations.
   */
  const initLastKnownValues = () => {
    if (!plan) return;
    plan.features.forEach(f => {
      const name = f.data.name;
      let val;
      if (f.isCont) {
        // Continuous: store in internal (possibly log) space — same as curValue
        val = f.coachValue;
      } else if (f.labelEncoder && f.coachValue !== null && f.coachValue !== undefined) {
        // Categorical: store as label string (e.g. 'debt_consolidation')
        val = f.labelEncoder[f.coachValue];
      }
      if (val !== undefined) {
        lastKnownValues[name] = val;
        originalValues[name]  = val; // frozen baseline — never overwritten
      }
    });

    // Freeze the applicant's ORIGINAL input as the engine baseline (display
    // units). Uses feature.originalValue (the applicant's real starting profile),
    // NOT the coach-suggested values.
    applicantBaselineState = buildEngineState(f => f.originalValue);

    // RESET_TO_LOAD_STATE: capture the load-time snapshot once (the sample here
    // holds exactly what the cards display on first load, before any edit).
    if (!loadTimeSample) {
      loadTimeSample = plan.ebmLocal.sample.slice();
    }
  };

  /**
   * Return the current internal value for a feature.
   * For continuous: the raw (possibly log-space) number.
   * For categorical: the label string (e.g. 'debt_consolidation').
   */
  const getCurrentValue = (featureName) => {
    if (lastKnownValues[featureName] !== undefined) return lastKnownValues[featureName];
    const f = plan?.features.find(f => f.data.name === featureName);
    if (!f) return null;
    if (!f.isCont) return f.labelEncoder ? f.labelEncoder[f.coachValue] : null;
    return f.coachValue;
  };

  /**
   * Return the display (human-readable) value for a continuous feature.
   * Applies the inverse of any stored transform (e.g. 10^x for log10 features).
   */
  const getDisplayValue = (featureName) => {
    const internal = getCurrentValue(featureName);
    if (internal === null || internal === undefined) return null;
    const f = plan?.features.find(f => f.data.name === featureName);
    if (!f || !f.isCont) return internal;
    return f.transform === 'log10' ? Math.pow(10, internal) : internal;
  };

  /**
   * Return the display value for a feature as it was at page-load time
   * (the coach's suggestion), regardless of any subsequent changes.
   * Used as the fixed baseline in propagation calculations so that
   * repeated changes don't stack on top of previously computed values.
   */
  const getOriginalDisplayValue = (featureName) => {
    const internal = originalValues[featureName];
    if (internal === null || internal === undefined) return null;
    const f = plan?.features.find(f => f.data.name === featureName);
    if (!f || !f.isCont) return internal;
    return f.transform === 'log10' ? Math.pow(10, internal) : internal;
  };

  /**
   * Convert a display value back to the internal representation expected by
   * the EBM and the slider (e.g. log10 for annual_inc / revol_bal).
   */
  const toInternalValue = (displayValue, featureName) => {
    const f = plan?.features.find(f => f.data.name === featureName);
    if (!f || !f.isCont) return displayValue;
    return f.transform === 'log10'
      ? (displayValue > 0 ? Math.log10(displayValue) : 0)
      : displayValue;
  };

  /**
   * Parse a term label like '36 months' or '60 months' into an integer.
   */
  const parseTermMonths = (termLabel) => {
    const match = String(termLabel || '').match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 36;
  };

  // ────────────────────────────────────────────────────────────────────────────
  // Causal engine adapter — convert between the model's internal representation
  // and the engine's plain display-unit state (keyed by internal feature name).
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Build a full engine state (all features, display units) from a per-feature
   * source of internal values.
   *   - continuous: raw internal number, un-transformed for display (10^x for log10)
   *   - categorical: decoded to its label string; `term` further parsed to months
   * @param {(f: Feature) => (number|string)} getInternal
   * @returns {Record<string, number|string>}
   */
  const buildEngineState = (getInternal) => {
    const state = {};
    if (!plan) return state;
    plan.features.forEach(f => {
      const name = f.data.name;
      const raw = getInternal(f);
      if (!f.isCont) {
        // Categorical values arrive in two forms:
        //   - numeric level code (e.g. the frozen baseline uses feature.originalValue),
        //     which we decode via labelEncoder[code] -> label string;
        //   - the level label string itself (ebmLocal.sample keeps the original
        //     level string), which is already what we want.
        // Normalise both to the label string.
        const label =
          typeof raw === 'number' && f.labelEncoder ? f.labelEncoder[raw] : raw;
        if (name === 'term') {
          state[name] = parseTermMonths(label);
        } else if (name === 'mort_acc') {
          // Numeric-count categorical: labels are '0'..'7' and '7+'. The engine
          // needs the integer count; the capped "more than 7" bucket ('7+') is
          // treated as 8.
          state[name] = label === '7+' ? 8 : (parseInt(label, 10) || 0);
        } else {
          state[name] = label;
        }
      } else {
        state[name] = f.transform === 'log10' ? Math.pow(10, raw) : raw;
      }
    });
    return state;
  };

  /** Current full state (post-edit) read from the authoritative EBM sample. */
  const buildCurrentEngineState = () =>
    buildEngineState(f => plan.ebmLocal.sample[f.featureID]);

  /**
   * Convert an engine display value for `featureName` back into the internal
   * representation the EBM/slider expect (log10 for annual_inc/revol_bal;
   * rounded for integer features).
   */
  const displayToInternal = (featureName, displayValue) => {
    const f = plan?.features.find(ff => ff.data.name === featureName);
    if (!f) return displayValue;
    // Numeric-count categorical (mort_acc): map the integer count back to its
    // level label ('0'..'7', capped at '7+'), which is what ebmLocal stores.
    if (!f.isCont && featureName === 'mort_acc') {
      const n = Math.round(displayValue);
      const labels = f.labelEncoder ? Object.values(f.labelEncoder) : [];
      const exact = String(n);
      return labels.includes(exact) ? exact : labels[labels.length - 1];
    }
    if (!f.isCont) return displayValue; // other categoricals: pass the label through
    let d = displayValue;
    if (f.requiresInt) d = Math.round(d);
    return toInternalValue(d, featureName);
  };

  /**
   * Populate the FICO / DTI / revolving link-popup calculation blocks from the
   * engine's own parameters so the explanation matches the applied values.
   * Blocks whose shape doesn't fit a given trigger are left null (the popup then
   * shows just its generic explanatory text).
   */
  const populateLinkCalculations = (editedFeature, baseline, current, next, changedSet) => {
    ficoLinkCalculation = null;
    dtiLinkCalculation = null;
    revolBalLinkCalculation = null;
    revolUtilLinkCalculation = null;

    const params = computeParams(baseline, current, modifiedFeatures);
    const fmt = (n) => '$' + Math.round(n).toLocaleString();

    if (changedSet.has('fico_score')) {
      ficoLinkCalculation = {
        type: 'fico',
        before: Math.round(baseline.fico_score),
        after: Math.round(next.fico_score)
      };
    }

    const fmtSigned = (n) => (n < 0 ? '−$' : '+$') + Math.round(Math.abs(n)).toLocaleString();

    if (changedSet.has('dti')) {
      // Breakdown from the SAME gated DTI computation the engine used, so the
      // popup only shows contributions from features the user actually edited
      // (DTI_USER_EDITS_ONLY) — an untouched suggested loan is not shown.
      const parts = computeDtiParts(next, params);
      dtiLinkCalculation = {
        type: 'dti',
        currentDebt: fmt(parts.baseDebt),
        newLoanPayment: fmt(parts.loanPayment),
        revolAdj: fmtSigned(parts.revolDelta),
        showRevolAdj: Math.abs(parts.revolDelta) >= 0.5,
        newMonthlyDebt: fmt(parts.newMonthlyDebt),
        originalDTI: Number(baseline.dti).toFixed(2) + '%',
        newDTI: Number(next.dti).toFixed(2) + '%'
      };
    }

    // Credit Utilization popup (New Util = current balance / recovered limit).
    if (changedSet.has('revol_util')) {
      const creditLimit = creditLimitFromBaseline(baseline);
      if (creditLimit) {
        revolUtilLinkCalculation = {
          type: 'revol_util',
          creditLimit: fmt(creditLimit),
          currentBalance: fmt(baseline.revol_bal),
          currentUtil: Number(baseline.revol_util).toFixed(2) + '%',
          newBalance: fmt(next.revol_bal),
          originalUtil: Number(baseline.revol_util).toFixed(2) + '%',
          newUtil: Number(next.revol_util).toFixed(2) + '%'
        };
      }
    }
  };

  /**
   * Iteratively push overlapping labels apart so they never stack on top of each other.
   * Modifies the label array in place and returns it.
   */
  const resolveOverlaps = (labels) => {
    const LABEL_H = 20;    // approximate label height in px
    const PAD = 5;         // minimum gap between labels
    const MAX_ITER = 40;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      let anyMoved = false;
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i];
          const b = labels[j];
          const aHalfW = (a.text.length * 6.4 + 16) / 2;
          const bHalfW = (b.text.length * 6.4 + 16) / 2;
          const minDx = aHalfW + bHalfW + PAD;
          const minDy = LABEL_H + PAD;
          const dx = Math.abs(a.x - b.x);
          const dy = Math.abs(a.y - b.y);

          if (dx < minDx && dy < minDy) {
            // Resolve on the axis with the smaller overlap to move labels the least
            if (minDy - dy <= minDx - dx) {
              const push = (minDy - dy) / 2 + 1;
              if (a.y <= b.y) { a.y -= push; b.y += push; }
              else             { a.y += push; b.y -= push; }
            } else {
              const push = (minDx - dx) / 2 + 1;
              if (a.x <= b.x) { a.x -= push; b.x += push; }
              else             { a.x += push; b.x -= push; }
            }
            anyMoved = true;
          }
        }
      }
      if (!anyMoved) break;
    }
    return labels;
  };

  /**
   * Find the t parameter (0–1) where the line from (sx,sy)→(tx,ty) crosses
   * a rect boundary.  `side` = 'exit' returns the smallest positive t (leaving
   * the source); 'entry' returns the largest t < 1 (entering the target).
   * Edge crossings are validated against the perpendicular axis so only real
   * intersections with the rectangle sides are returned.
   */
  const rectEdgeT = (sx, sy, tx, ty, rect, side) => {
    const dx = tx - sx;
    const dy = ty - sy;
    const ts = [];
    if (dx !== 0) {
      const tR = (rect.right  - sx) / dx;
      const tL = (rect.left   - sx) / dx;
      const yR = sy + tR * dy;
      const yL = sy + tL * dy;
      if (tR > 0 && tR < 1 && yR >= rect.top && yR <= rect.bottom) ts.push(tR);
      if (tL > 0 && tL < 1 && yL >= rect.top && yL <= rect.bottom) ts.push(tL);
    }
    if (dy !== 0) {
      const tB = (rect.bottom - sy) / dy;
      const tT = (rect.top    - sy) / dy;
      const xB = sx + tB * dx;
      const xT = sx + tT * dx;
      if (tB > 0 && tB < 1 && xB >= rect.left && xB <= rect.right) ts.push(tB);
      if (tT > 0 && tT < 1 && xT >= rect.left && xT <= rect.right) ts.push(tT);
    }
    if (ts.length === 0) return side === 'exit' ? 0 : 1;
    return side === 'exit' ? Math.min(...ts) : Math.max(...ts);
  };


  /**
   * (Re)draw SVG arrows from lastArrowSource to each of lastArrowTargets using
   * fresh getBoundingClientRect() calls.  Safe to call at any time — including
   * from a scroll handler — because it reads live viewport coordinates.
   */
  const recomputeArrows = () => {
    if (!showArrows || !lastArrowSource || !lastArrowTargets.length) return;

    if (component) {
      const rect = component.getBoundingClientRect();
      panelClipRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }

    const sourceEl = document.querySelector(`[data-feature-name="${lastArrowSource}"]`);
    if (!sourceEl) return;

    const sourceRect = sourceEl.getBoundingClientRect();
    const sx = sourceRect.left + sourceRect.width / 2;
    const sy = sourceRect.top  + sourceRect.height / 2;

    // ── Step 1: collect all valid target positions ────────────────────────
    const targets = lastArrowTargets
      .map(name => ({ name, el: document.querySelector(`[data-feature-name="${name}"]`) }))
      .filter(({ el }) => el !== null)
      .map(({ name, el }) => {
        const r = el.getBoundingClientRect();
        return { name, targetRect: r,
                 tx: r.left + r.width  / 2,
                 ty: r.top  + r.height / 2 };
      });

    if (!targets.length) return;

    // ── Step 2: single bundle origin on the source card edge ─────────────
    // Average unit vectors from source centre toward every target gives the
    // dominant outward direction.  Following that direction to the card
    // boundary produces one shared starting point so all arrows originate
    // from the same spot.
    let sumUx = 0, sumUy = 0;
    targets.forEach(({ tx, ty }) => {
      const dx = tx - sx, dy = ty - sy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) { sumUx += dx / len; sumUy += dy / len; }
    });
    const domLen = Math.sqrt(sumUx * sumUx + sumUy * sumUy);
    const domUx  = domLen > 0 ? sumUx / domLen : 0;
    const domUy  = domLen > 0 ? sumUy / domLen : 1;   // fallback: downward

    const tBundle  = rectEdgeT(sx, sy, sx + domUx * 1000, sy + domUy * 1000, sourceRect, 'exit');
    const bundleX  = sx + tBundle * domUx * 1000;
    const bundleY  = sy + tBundle * domUy * 1000;

    // ── Step 3: per-target arrow data ────────────────────────────────────
    const targetData = targets.map(({ name, targetRect, tx, ty }) => {
      // End point: entry into the target card edge (line from source centre)
      const dx = tx - sx, dy = ty - sy;
      const tTgtEntry = rectEdgeT(sx, sy, tx, ty, targetRect, 'entry');
      const x2 = sx + tTgtEntry * dx;
      const y2 = sy + tTgtEntry * dy;

      // Label placed along the bundle-origin → target-edge segment,
      // srcMargin px from the bundle origin and at least tgtBuffer px
      // before the target edge.
      const adx = x2 - bundleX, ady = y2 - bundleY;
      const alen = Math.sqrt(adx * adx + ady * ady);
      const srcMargin = 55;   // px from bundle origin
      const tgtBuffer = 90;   // px before target edge
      const tNear = alen > 0 ? srcMargin / alen : 0;
      const tFar  = alen > 0 ? Math.max(0, (alen - tgtBuffer) / alen) : 1;
      const tLabel = tFar > tNear ? tNear : (tNear + tFar) / 2;

      // Float the label perpendicular to the arrow to keep the line visible
      const perpX = alen > 0 ?  ady / alen : 0;
      const perpY = alen > 0 ? -adx / alen : 0;
      const lx = bundleX + tLabel * adx + perpX * 24;
      const ly = bundleY + tLabel * ady + perpY * 24;

      return {
        path: `M${bundleX},${bundleY} L${x2},${y2}`,
        endX: x2, endY: y2,
        labelX: lx, labelY: ly,
        labelText: `${DISPLAY_NAMES[name] || name} changed`
      };
    });

    arrowPaths = targetData.map(d => d.path);
    arrowLabels = resolveOverlaps(targetData.map(d => ({
      x: d.labelX, y: d.labelY, text: d.labelText
    })));

    // ── Step 4: dismiss button beside the last arrowhead ─────────────────
    // Start from the last (bottom-most) arrowhead tip and try candidate
    // positions in order until one doesn't overlap any feature card.
    const last   = targetData[targetData.length - 1];
    const adxL   = last.endX - bundleX;
    const adyL   = last.endY - bundleY;
    const alenL  = Math.sqrt(adxL * adxL + adyL * adyL);
    // Unit vectors: perpendicular (clockwise) and reverse-arrow direction
    const pUx    = alenL > 0 ?  adyL / alenL : 1;
    const pUy    = alenL > 0 ? -adxL / alenL : 0;
    const rUx    = alenL > 0 ? -adxL / alenL : 0;   // back along arrow
    const rUy    = alenL > 0 ? -adyL / alenL : -1;

    // Collect all feature-card bounding rects for overlap testing.
    const btnR = 14;
    const cardRects = Array.from(
      document.querySelectorAll('[data-feature-name]')
    ).map(el => el.getBoundingClientRect());

    const overlapsCard = (bx, by) => cardRects.some(r =>
      bx + btnR > r.left && bx - btnR < r.right &&
      by + btnR > r.top  && by - btnR < r.bottom
    );

    // Candidate positions: perp both sides at increasing distances,
    // then pull back along the arrow (between tip and source).
    const candidates = [
      [ pUx,  pUy, 26], [ -pUx, -pUy, 26],
      [ pUx,  pUy, 40], [ -pUx, -pUy, 40],
      [ pUx,  pUy, 56], [ -pUx, -pUy, 56],
      [ rUx,  rUy, 30], [ rUx,   rUy, 50],
    ];

    let btnX = last.endX + pUx * 26;
    let btnY = last.endY + pUy * 26;

    for (const [ux, uy, dist] of candidates) {
      const cx = last.endX + ux * dist;
      const cy = last.endY + uy * dist;
      if (!overlapsCard(cx, cy)) { btnX = cx; btnY = cy; break; }
    }

    arrowDismissBtn = { x: btnX, y: btnY };
  };

  /**
   * Remove all arrows and the dismiss button when the user clicks ×.
   */
  const dismissArrows = () => {
    showArrows      = false;
    arrowPaths      = [];
    arrowLabels     = [];
    arrowDismissBtn = null;
    lastArrowSource  = null;
    lastArrowTargets = [];
  };

  /**
   * Scroll handler — redraws arrows at updated viewport positions once per
   * animation frame so the lines always connect to the cards while scrolling.
   * Uses capture phase so it fires for any scrollable container, not just window.
   */
  const onScroll = () => {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      recomputeArrows();
      scrollRafId = null;
    });
  };

  /**
   * Called whenever a FeatureCard starts its expand/collapse animation.
   * Runs a rAF loop for slightly longer than the 250 ms card animation so
   * arrows continuously track every card as it moves during the transition.
   */
  const onCardToggle = () => {
    // Extend the deadline by the animation duration + a small buffer each time
    // a card is clicked (handles rapid successive clicks gracefully).
    cardAnimEndTime = performance.now() + 320;

    if (cardAnimRafId) return;   // loop already running

    const loop = () => {
      recomputeArrows();
      if (performance.now() < cardAnimEndTime) {
        cardAnimRafId = requestAnimationFrame(loop);
      } else {
        cardAnimRafId = null;
      }
    };
    cardAnimRafId = requestAnimationFrame(loop);
  };

  /**
   * Run the causal propagation engine for a directly-edited feature, then show
   * the message / outlines / arrows and push the engine's computed dependent
   * values into the EBM and the affected slider cards. The engine (src/engine)
   * is the single source of truth for which features change and by how much.
   */
  const triggerPropagation = async (featureName) => {
    if (!featureHasOutgoingEdges(featureName)) return;
    if (!applicantBaselineState || !plan) return;

    // ── 1. Run the engine against the frozen applicant baseline ──────────────
    const baseline = applicantBaselineState;
    const current  = buildCurrentEngineState();
    // DTI_USER_EDITS_ONLY: pass the set of user-edited features so DTI counts
    // only touched inputs (unedited suggested values fall back to profile).
    const { state: next, log } = propagate(featureName, baseline, current, baseline, modifiedFeatures);

    // Dependents that actually changed vs. the current state.
    const computedUpdates = {}; // internal feature name → internal value
    const activeTargets = [];
    const changedSet = new Set();
    const deps = [...new Set(log.filter(l => !l.note).map(l => l.dependent))];
    deps.forEach(dep => {
      const before = current[dep];
      const after  = next[dep];
      const changed = (typeof after === 'number' && typeof before === 'number')
        ? Math.abs(after - before) > 1e-6
        : after !== before;
      if (!changed) return;
      computedUpdates[dep] = displayToInternal(dep, after);
      activeTargets.push(dep);
      changedSet.add(dep);
    });

    // Publish which features changed via propagation so ScorePanel can label
    // them PROPAGATED (vs DIRECT) in the score-change breakdown popup.
    propagatedFeaturesStore.set(changedSet);
    // Populate the link-popup calculation blocks from the engine's parameters.
    populateLinkCalculations(featureName, baseline, current, next, changedSet);

    // Nothing actually propagated (e.g. a home-ownership change that is not a
    // mortgage transition) — clear any prior banner / arrows and stop.
    if (activeTargets.length === 0) {
      showPropagationMessage = false;
      dismissArrows();
      return;
    }

    // Keep lastKnownValues in sync so re-expanding a card doesn't refire.
    Object.entries(computedUpdates).forEach(([name, internalValue]) => {
      lastKnownValues[name] = internalValue;
    });

    // ── 2. Build + show the sticky message ───────────────────────────────────
    const count = activeTargets.length;
    const featureWord = count === 1 ? 'feature' : 'features';
    const targetNames = activeTargets
      .map(name => DISPLAY_NAMES[name] || name)
      .join(', ');
    propagationMessage = `Changing ${DISPLAY_NAMES[featureName] || featureName} changed ${count} other ${featureWord}: ${targetNames}`;
    showPropagationMessage = true;
    showArrows = false;
    arrowPaths = [];
    arrowLabels = [];
    arrowDismissBtn = null;

    await tick();

    // Restart blink animation on the banner (works whether or not message text changed)
    if (bannerEl) {
      bannerEl.style.animation = 'none';
      void bannerEl.offsetHeight; // force reflow so browser resets the animation
      bannerEl.style.animation = '';
    }

    // ── 3. Blue outline on the edited feature + affected dependents ───────────
    // Mark them modified (reactive); the outline shows while modified and clears
    // only on reset — never from value equality.
    modifiedFeatures.add(featureName);
    activeTargets.forEach(name => modifiedFeatures.add(name));
    modifiedFeatures = modifiedFeatures;

    // ── 4. Push computed values into the EBM and move the sliders ───────────
    Object.entries(computedUpdates).forEach(([name, internalValue]) => {
      plan.ebmLocal.updateFeature(name, internalValue);
    });
    planStore.set(plan);
    // Signal FeatureCard instances to update their slider positions
    featureValueOverrideStore.set(computedUpdates);
    // Clear the override store after a short delay; the coachValue on each
    // feature object has already been updated (by reference) so collapsed
    // cards will still initialize at the correct position when expanded.
    setTimeout(() => featureValueOverrideStore.set({}), 400);

    // ── 5. Draw SVG arrows ────────────────────────────────────────────────────
    lastArrowSource = featureName;
    lastArrowTargets = activeTargets;
    showArrows = true;
    recomputeArrows();
  };

  const maxFeatureNumChanged = () => {
    resizeFeatureSelect();

    if (constraints === null) return;

    const oldValue = constraints.maxNumFeaturesToVary;

    // Update the constraints
    if (maxFeatureNum === 'null') {
      constraints.maxNumFeaturesToVary = null;
    } else {
      constraints.maxNumFeaturesToVary = parseInt(maxFeatureNum);
    }
    constraintsStore.set(constraints);

    logger?.addLog({
      eventName: 'feature num changed',
      elementName: 'select',
      valueName: 'maxNumFeaturesToVary',
      oldValue,
      newValue: constraints.maxNumFeaturesToVary
    });
  };

  /**
   * Change the width of the select button so it fits the current content
   */
  const resizeFeatureSelect = () => {
    const optionMap = {
      'null': 'any number of',
      '1': 'at most one',
      '2': 'at most two',
      '3': 'at most three',
      '4': 'at most four',
    };

    const hiddenSelect = d3.select(component)
      .select('#hidden-select')
      .style('display', 'initial');

    hiddenSelect.select('#hidden-option')
      .text(optionMap[maxFeatureNum]);

    const selectWidth = hiddenSelect.node().clientWidth + 5 + 'px';
    hiddenSelect.style('display', 'none');

    d3.select(component)
      .select('#feature-num-select')
      .style('width', selectWidth);
  };

  /**
   * Return true if two sets are the same
   * @param {Set<object>} a
   * @param {Set<object>} b
   */
  const areSetsEqual = (a, b) => {
    return a.size === b.size && [...a].every(value => b.has(value));
  };

  /**
   * Handler when a feature constraint is updated by the user
   * @param {CustomEvent} e
   * @param {Feature} feature
   */
  const constraintUpdatedHandler = (e, feature) => {
    const curConstraint = e.detail;
    const difficulty = curConstraint.difficulty;
    const acceptableRange = curConstraint.acceptableRange;

    const name = feature.data.name;
    let needToUpdateStore = false;

    // Update existing difficulty
    if (constraints.difficulties.has(name) &&
      constraints.difficulties.get(name) !== difficulty
    ) {
      needToUpdateStore = true;

      if (difficulty !== 'neutral') {
        constraints.difficulties.set(name, difficulty);
      } else {
        constraints.difficulties.delete(name);
      }
    }

    // Add new difficulty
    if (!constraints.difficulties.has(name) && difficulty !== 'neutral') {
      needToUpdateStore = true;
      constraints.difficulties.set(name, difficulty);
    }

    // Update existing acceptable range
    if (constraints.acceptableRanges.has(name)) {

      // Remove existing acceptable range
      if (acceptableRange === null) {
        needToUpdateStore = true;
        constraints.acceptableRanges.delete(name);
      } else {
        const ranges = new Set(constraints.acceptableRanges.get(name).values());
        const newRanges = new Set(acceptableRange);
        if (!areSetsEqual(ranges, newRanges)) {
          needToUpdateStore = true;
          constraints.acceptableRanges.set(name, acceptableRange);
        }
      }
    }

    if (!constraints.acceptableRanges.has(name) && acceptableRange !== null) {
      needToUpdateStore = true;
      constraints.acceptableRanges.set(name, acceptableRange);
    }

    if (needToUpdateStore) {
      constraints.hasNewConstraints = true;
      constraintsStore.set(constraints);
    }

  };

  onMount(() => {
    mounted = true;
    const iconList = [];
    bindInlineSVG(component, iconList);
    // capture:true catches scroll events from any scrollable container, not
    // just the window — required because the feature panel has its own scroll area.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    // Subscribe to cardToggleStore so we recompute arrows throughout every
    // expand/collapse animation without touching every <FeatureCard> tag.
    // The store starts at 0; skip the initial emission (n === 0) so we don't
    // fire at mount time before any cards or arrows exist.
    const unsubCardToggle = cardToggleStore.subscribe(n => {
      if (n > 0) onCardToggle();
    });
    unsubscribes.push(unsubCardToggle);
  });

  onDestroy(() => {
    unsubscribes.forEach(unsub => unsub());
    if (propagationDebounceTimer) clearTimeout(propagationDebounceTimer);
    window.removeEventListener('scroll', onScroll, { capture: true });
    if (scrollRafId) cancelAnimationFrame(scrollRafId);
    if (cardAnimRafId) cancelAnimationFrame(cardAnimRafId);
  });

  $: windowLoaded && planStore && !initialized && initFeatureCards();
  $: mounted && maxFeatureNum && maxFeatureNumChanged();

</script>

<style lang='scss'>
  @import './FeaturePanel.scss';
</style>

<div class='feature-panel' bind:this={component}>

  {#if showPropagationMessage}
    <div class='propagation-message' bind:this={bannerEl} transition:fade={{ duration: 300 }}>
      {propagationMessage}
    </div>
  {/if}

  <div class='card-block'>
    <div class='row-header'>
      <span class='label'>Suggested Changes</span>
      <span class='label'>New plans can change
        <div class='select' id='hidden-select'>
          <select>
            <option id='hidden-option'></option>
          </select>
        </div>
        <div class='select'>
          <select id='feature-num-select' bind:value={maxFeatureNum}>
            <option value='null'>any number of</option>
            <option value='1'>at most one</option>
            <option value='2'>at most two</option>
            <option value='3'>at most three</option>
            <option value='4'>at most four</option>
          </select>
        </div>
        {maxFeatureNum === '1' ? 'feature' : 'features'}
      </span>
    </div>

    <div class='card-row'>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.changed.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

      <div class='card-column mid-column' bind:this={midColumn}>

        {#each featureGrid.changed.mid as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

      <div class='card-column right-column' bind:this={rightColumn}>

        {#each featureGrid.changed.right as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

    </div>
  </div>

  <div class='card-block'>
    <div class='row-header'>
      <span class='label'>Configured Features</span>
    </div>

    <div class='card-row'>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.configured.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

      <div class='card-column mid-column' bind:this={midColumn}>

        {#each featureGrid.configured.mid as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

      <div class='card-column right-column' bind:this={rightColumn}>

        {#each featureGrid.configured.right as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

    </div>
  </div>

  <div class='card-block'>
    <div class='row-header'>
      <span class='label'>Other Features</span>
    </div>

    <div class='card-row'>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.other.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

      <div class='card-column mid-column' bind:this={midColumn}>

        {#each featureGrid.other.mid as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

      <div class='card-column right-column' bind:this={rightColumn}>

        {#each featureGrid.other.right as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCardCat>
          {/if}
        {/each}

      </div>

    </div>
  </div>

  <!-- SVG overlay for propagation arrows — fixed to viewport, pointer-events off -->
  {#if showArrows}
    <svg
      class='propagation-arrows-overlay'
      xmlns='http://www.w3.org/2000/svg'
      transition:fade={{ duration: 300 }}
    >
      <defs>
        <marker
          id='prop-arrowhead'
          markerWidth='8'
          markerHeight='6'
          refX='7'
          refY='3'
          orient='auto'
        >
          <polygon points='0 0, 8 3, 0 6' fill='#1565C0' />
        </marker>
        {#if panelClipRect}
          <clipPath id='panel-clip'>
            <rect
              x={panelClipRect.x}
              y={panelClipRect.y}
              width={panelClipRect.width}
              height={panelClipRect.height}
            />
          </clipPath>
        {/if}
      </defs>
      <g clip-path={panelClipRect ? 'url(#panel-clip)' : ''}>
        {#each arrowPaths as d}
          <path
            {d}
            stroke='#1976D2'
            stroke-width='2.5'
            fill='none'
            marker-end='url(#prop-arrowhead)'
            stroke-dasharray='6 3'
          />
        {/each}
        {#each arrowLabels as label}
          {@const pad = 10}
          {@const approxWidth = label.text.length * 8.8 + pad * 2}
          <rect
            x={label.x - approxWidth / 2}
            y={label.y - 20}
            width={approxWidth}
            height={24}
            rx='3'
            fill='#E3F2FD'
            stroke='#1976D2'
            stroke-width='0.5'
          />
          <text
            x={label.x}
            y={label.y - 4}
            text-anchor='middle'
            fill='#1565C0'
            font-size='15'
            font-weight='600'
            font-family='system-ui, sans-serif'
          >{label.text}</text>
        {/each}

        {#if arrowDismissBtn}
          <!-- Single × button near the source card's top-right corner.
               pointer-events:all overrides the overlay's pointer-events:none
               so only this element is interactive. -->
          <g
            style='pointer-events: all; cursor: pointer;'
            on:click={dismissArrows}
            role='button'
            tabindex='0'
            aria-label='Hide dependency arrows'
            on:keydown={e => e.key === 'Enter' && dismissArrows()}
          >
            <title>Click to hide ALL the dependency arrows</title>
            <circle
              cx={arrowDismissBtn.x}
              cy={arrowDismissBtn.y}
              r='13'
              fill='white'
              stroke='#1976D2'
              stroke-width='1.5'
            />
            <text
              x={arrowDismissBtn.x}
              y={arrowDismissBtn.y + 5}
              text-anchor='middle'
              fill='#1976D2'
              font-size='15'
              font-weight='700'
              font-family='system-ui, sans-serif'
              style='pointer-events: none; user-select: none;'
            >✕</text>
          </g>
        {/if}
      </g>
    </svg>
  {/if}

</div>