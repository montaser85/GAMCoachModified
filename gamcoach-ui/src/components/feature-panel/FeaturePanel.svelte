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
  import { tooltipConfigStore, featureValueOverrideStore, cardToggleStore, propagatedFeaturesStore, historySidebarOpenStore, changeEffectsStore } from '../../store';
  import {
    propagate,
    allDependentFeatures,
    featureHasOutgoingEdges,
    computeParams,
    computeDtiParts,
    creditLimitFromBaseline,
    masterFico,
    MORTGAGE_HOME_VALUE,
    FICO_FLOOR,
    FICO_CEIL,
    MODEL_BOUNDS,
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

  // ── Link-popup explanatory text for indirectly-affected features ────────────
  // Add an entry here whenever a feature gets real calculation mechanics so the
  // popup shows an informative message instead of the default placeholder.
  const LINK_POPUP_TEXT = {
    'fico_score': "FICO score is your credit score, which lenders use to judge how likely you are to repay.",
    'dti': "Your Debt-to-Income ratio (DTI) is how much of your monthly income goes toward paying debts. A lower DTI looks better to lenders.",
    'revol_bal':  "Revolving balance is the unpaid amount left on your credit cards. Changing it affects two things: your credit utilization and your debt-to-income ratio.",
    'revol_util': "Credit utilization is how much of your available revolving credit you're using. It moves with your revolving balance — as the balance goes up or down, so does your utilization.",
    'mort_acc': "Number of mortgages is how many mortgage accounts you have.",
    'open_acc': "Number of open accounts is how many credit lines you currently have open, like credit cards and loans.",
    'total_acc': "Number of accounts is the total number of credit lines currently in your credit file.",
    'loan_amnt': "Loan amount is how much money you're asking to borrow.",
    'term': "Payment period is how long you'd take to repay the loan.",
    'purpose': "Loan purpose is what the loan is for, which sets its interest rate.",
    'annual_inc': "Annual income is how much you earn per year.",
    'inq_last_6mths': "Number of credit inquiries is how many hard credit checks you've had in the last 6 months.",
    'home_ownership': "Home ownership is your housing status — rent, own, or mortgage."
  };

  // ── Static two-way dependency lists for the info tooltip ────────────────────
  // Authoritative mapping (fixed; independent of session state). A feature is
  // listed here iff it has at least one edge — presence drives the "i" icon.
  const FEATURE_DEPS = {
    'loan_amnt':      { canChange: 'Debt to Income Ratio' },
    'term':           { canChange: 'Debt to Income Ratio' },
    'purpose':        { canChange: 'Debt to Income Ratio' },
    'annual_inc':     { canChange: 'Debt to Income Ratio' },
    'inq_last_6mths': { canChange: 'FICO Score' },
    'home_ownership': { canChange: 'Number of Mortgages, Number of Open Accounts, Number of Accounts, FICO Score' },
    'revol_bal':      { changedBy: 'Credit Utilization',
                        canChange: 'Credit Utilization, Debt to Income Ratio' },
    'revol_util':     { changedBy: 'Revolving Balance',
                        canChange: 'Revolving Balance, Debt to Income Ratio' },
    'open_acc':       { changedBy: 'Number of Mortgages, Home Ownership',
                        canChange: 'Number of Accounts, FICO Score' },
    'mort_acc':       { changedBy: 'Home Ownership',
                        canChange: 'Number of Open Accounts, Number of Accounts, FICO Score' },
    'dti':            { changedBy: 'Loan Amount, Payment Period, Loan Purpose, Annual Income, Revolving Balance, Credit Utilization' },
    'fico_score':     { changedBy: 'Number of Open Accounts, Number of Mortgages, Home Ownership, Number of Credit Inquiries' },
    'total_acc':      { changedBy: 'Number of Open Accounts, Number of Mortgages, Home Ownership' }
  };

  // Reactive calculations displayed in popup once propagation has been applied.
  // null = don't show the calculation block yet.
  let ficoLinkCalculation     = null;
  let dtiLinkCalculation      = null;
  let revolBalLinkCalculation = null;
  let revolUtilLinkCalculation = null;
  let mortAccLinkCalculation  = null;
  let openAccLinkCalculation  = null;
  let totalAccLinkCalculation = null;

  // ── Causal Propagation Engine wiring ────────────────────────────────────────
  // The engine (src/engine) is the single source of truth for every
  // indirect/dependent change. The set of features that can be indirectly
  // changed — used to show the linked icon — is derived from the engine's
  // declarative edge set so the UI always matches the implemented edges.
  // (The "i" icon is driven by FEATURE_DEPS above — any feature with ≥1 edge.)

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
  /** @type {ResizeObserver} */
  let arrowResizeObserver = null; // recomputes arrows on any panel geometry change
  let resizeRafId = null;         // rAF handle for the ResizeObserver callback
  // Track last known values to avoid triggering on card expansion (not real user changes)
  let lastKnownValues = {};
  // Snapshot of every feature's value at page-load time (coach suggestions).
  // Never modified after initialization — used as the baseline for all propagation
  // calculations so that repeated changes don't stack on top of each other.
  let originalValues = {};

  // Two-way pair direction: true when Credit Utilization was the most recently
  // edited side (so Revolving Balance is the DERIVED side). Drives whether the
  // Revolving Balance hover shows the utilization→balance derivation lines.
  let revolUtilIsInput = false;

  // The +1 (0 or 1) Home Ownership currently contributes to the account counters
  // (Number of Mortgages / Open / Total). Tracked so a Home Ownership change
  // adds or removes only its own contribution, preserving the user's manual
  // edits to those counts instead of resetting them.
  let appliedHomeMortgage = 0;

  /** True iff the given engine state has Home Ownership contributing a +1. */
  const homeMortgageContribution = (stateHome) =>
    stateHome === MORTGAGE_HOME_VALUE &&
    applicantBaselineState &&
    applicantBaselineState.home_ownership !== MORTGAGE_HOME_VALUE
      ? 1
      : 0;

  // The user's manual deltas to the account counters (excluding the mortgage /
  // open contributions), tracked so each counter sums ALL its inputs instead of
  // being overwritten by whichever source changed last. Updated on a direct
  // edit to Number of Open Accounts / Number of Accounts respectively.
  let userOpenDelta = 0;
  let userTotalDelta = 0;
  // The user's manual edit to FICO Score, tracked as a SIGNED delta vs. the
  // profile score (may raise or lower it). Applied as a base adjustment before
  // the hard-inquiry penalty, so a later source change (open account / mortgage /
  // inquiry) no longer discards the manual edit. Cleared only on a FICO reset.
  let userFicoDelta = 0;
  // Same pattern for the two other editable-and-derived features: a SIGNED manual
  // delta vs. the profile value, folded onto the computed result so a later
  // source change never discards it. Cleared only on that feature's own reset.
  let userDtiDelta = 0;    // DTI: newDTI = computedDTI + userDtiDelta
  let userRevolDelta = 0;  // Revolving Balance: newBal = profile + userRevolDelta + util-driven

  /**
   * Recompute the tracked manual account deltas from the current model state
   * after a direct edit to Number of Open Accounts or Number of Accounts.
   */
  const updateAccountManualDeltas = (featureName) => {
    if (!applicantBaselineState || !plan) return;
    const cur = buildCurrentEngineState();
    const mortDelta = Math.max(0, (cur.mort_acc || 0) - (applicantBaselineState.mort_acc || 0));
    if (featureName === 'open_acc') {
      userOpenDelta = (cur.open_acc || 0) - (applicantBaselineState.open_acc || 0) - mortDelta;
    } else if (featureName === 'total_acc') {
      // Isolate the user's Number-of-Accounts edit from the open/mortgage parts.
      userTotalDelta =
        (cur.total_acc || 0) - (applicantBaselineState.total_acc || 0) - userOpenDelta - mortDelta;
    }
  };

  /**
   * Settle FICO from the current full state and the given manual delta, honoring
   * the same master formula + 662/848 clamp the engine applies. Returns the
   * display-unit FICO value.
   */
  const settleFico = (ficoManualDelta) => {
    const current = buildCurrentEngineState();
    const params = computeParams(
      applicantBaselineState, current, modifiedFeatures, ficoManualDelta
    );
    return Math.max(FICO_FLOOR, Math.min(FICO_CEIL, masterFico(params)));
  };

  /**
   * Capture a direct FICO edit as a signed delta vs. the profile score, then
   * re-settle the displayed score so any active hard-inquiry penalty applies on
   * top of the manual edit (FICO is a leaf, so triggerPropagation can't do this).
   */
  const applyManualFicoEdit = () => {
    if (!applicantBaselineState || !plan) return;
    const cur = buildCurrentEngineState();
    userFicoDelta = (cur.fico_score || 0) - (applicantBaselineState.fico_score || 0);
    // Re-settle: profile + delta − active penalty, clamped. Write it back so the
    // card reflects the reconciled value (e.g. 720 typed with a −4 penalty → 716).
    const settled = settleFico(userFicoDelta);
    plan.ebmLocal.updateFeature('fico_score', settled);
    const f = plan.features.find(ff => ff.data.name === 'fico_score');
    if (f) f.hypotheticalValue = settled;
    lastKnownValues['fico_score'] = settled;
    planStore.set(plan);
    // Snap the slider to the settled value when an active penalty pulled it below
    // what the user typed (e.g. typed 720 with a −4 penalty → 716).
    if (Math.round(settled) !== Math.round(cur.fico_score || 0)) {
      featureValueOverrideStore.set({ fico_score: settled });
      setTimeout(() => featureValueOverrideStore.set({}), 400);
    }
    ficoLinkCalculation = buildFicoBreakdown(applicantBaselineState, buildCurrentEngineState());
  };

  /**
   * Settle DTI from the current full state and the given manual delta, honoring
   * the same computed-DTI + manual-delta formula and the model's [0, 99.9] clamp.
   */
  const settleDti = (dtiManualDelta) => {
    const current = buildCurrentEngineState();
    const params = computeParams(
      applicantBaselineState, current, modifiedFeatures, userFicoDelta, dtiManualDelta, userRevolDelta
    );
    const parts = computeDtiParts(current, params);
    const b = MODEL_BOUNDS.dti;
    return Math.max(b[0], Math.min(b[1], parts.newDti));
  };

  /**
   * Capture a direct DTI edit as a signed delta vs. the profile DTI, then
   * re-settle the displayed DTI so any active source contribution (loan /
   * revolving / income) applies on top of the manual edit (DTI is a leaf, so
   * triggerPropagation can't do this).
   */
  const applyManualDtiEdit = () => {
    if (!applicantBaselineState || !plan) return;
    const cur = buildCurrentEngineState();
    userDtiDelta = (cur.dti || 0) - (applicantBaselineState.dti || 0);
    const settled = settleDti(userDtiDelta);
    plan.ebmLocal.updateFeature('dti', settled);
    const f = plan.features.find(ff => ff.data.name === 'dti');
    if (f) f.hypotheticalValue = settled;
    lastKnownValues['dti'] = settled;
    planStore.set(plan);
    // Snap the slider to the settled value when a source contribution pulled it
    // away from what the user typed.
    if (Math.abs(settled - (cur.dti || 0)) > 1e-6) {
      featureValueOverrideStore.set({ dti: settled });
      setTimeout(() => featureValueOverrideStore.set({}), 400);
    }
    refreshDtiBreakdown();
  };

  /**
   * Capture a direct Revolving Balance edit as a signed delta vs. the profile
   * balance. Revolving Balance is NOT a leaf (triggerPropagation runs and derives
   * utilization + DTI), and its own value keeps what the user typed, so no
   * re-settle is needed here — the delta is what a LATER utilization change sums
   * with (via revolBalFromUtil).
   */
  const captureManualRevolDelta = () => {
    if (!applicantBaselineState || !plan) return;
    const cur = buildCurrentEngineState();
    userRevolDelta = (cur.revol_bal || 0) - (applicantBaselineState.revol_bal || 0);
  };

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

    // Organize the features into corresponding sections
    featureGrid.loadFeatures(plan.features, constraints);
    featureGrid = featureGrid;

    // Seed lastKnownValues with the initial coach-suggested values so that
    // the propagation helpers have baseline data even before the user moves any slider.
    initLastKnownValues();

    // Start the "Effects of your changes" section empty on (re)init — a fresh
    // mount happens on plan switch / regenerate / history restore, matching the
    // FeaturePanel's own per-mount reset of propagation tracking.
    changeEffectsStore.set([]);

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

    // Total Accounts >= Open Accounts bound. A direct Number of Accounts edit is
    // a leaf (no propagation), so the engine's guard never runs for it — enforce
    // the bound here so a manual reduction can't drop below the current Number of
    // Open Accounts. (Downward edits above the bound are honored — signed.)
    if (feature.data.name === 'total_acc') {
      const openFeat = plan.features.find(ff => ff.data.name === 'open_acc');
      if (openFeat) {
        const openNow = Math.round(plan.ebmLocal.sample[openFeat.featureID] || 0);
        if (newValue < openNow) newValue = openNow;
      }
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

      // Track which side of the two-way pair is the input (last edited), so the
      // Revolving Balance hover knows whether its value was derived from a
      // Credit Utilization edit.
      if (featureName === 'revol_util') revolUtilIsInput = true;
      else if (featureName === 'revol_bal') revolUtilIsInput = false;

      // Capture manual account-counter deltas here (Number of Accounts is a
      // leaf, so triggerPropagation returns early for it and can't do this).
      if (featureName === 'open_acc' || featureName === 'total_acc') {
        updateAccountManualDeltas(featureName);
        // Rebuild the account hovers from the just-updated deltas. For a Number
        // of Accounts (leaf) edit triggerPropagation returns early and never
        // refreshes them, so without this the breakdown would ignore the manual
        // change. (Harmless/redundant for open_acc, which also refreshes below.)
        const cur = buildCurrentEngineState();
        openAccLinkCalculation = buildOpenAccBreakdown(applicantBaselineState, cur);
        totalAccLinkCalculation = buildTotalAccBreakdown(applicantBaselineState, cur);
      }

      // FICO Score is a leaf too — capture the signed manual delta and re-settle
      // the score (profile + delta − active penalty) so any existing source
      // penalty applies on top of the manual edit, then refresh its hover.
      if (featureName === 'fico_score') {
        applyManualFicoEdit();
      }

      // DTI is a leaf as well — capture the signed manual delta and re-settle
      // (computedDTI + delta) so existing source contributions apply on top.
      if (featureName === 'dti') {
        applyManualDtiEdit();
      }

      // Revolving Balance is NOT a leaf — just capture its signed manual delta so
      // a LATER Credit Utilization change sums with it. triggerPropagation below
      // derives utilization + DTI and refreshes the hovers.
      if (featureName === 'revol_bal') {
        captureManualRevolDelta();
      }

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

    // Drop the "Effects of your changes" row sourced from this feature — its
    // ripple no longer applies once the edit is reset.
    changeEffectsStore.update((list) =>
      list.filter((ev) => ev.sourceName !== featureName)
    );

    // ── FICO Score reset — special case ──────────────────────────────────────
    // FICO's "sources" are real user edits (opened accounts / mortgages /
    // inquiries) whose penalties must PERSIST. Resetting FICO clears ONLY the
    // user's manual FICO delta and re-settles the score from the remaining
    // penalties (never touches the source cards).
    if (featureName === 'fico_score') {
      userFicoDelta = 0;
      const settled = settleFico(0); // profile − active penalty, clamped
      const profileFico = applicantBaselineState.fico_score || 0;
      plan.ebmLocal.updateFeature('fico_score', settled);
      const f = plan.features.find(ff => ff.data.name === 'fico_score');
      if (f) f.hypotheticalValue = settled;
      lastKnownValues['fico_score'] = settled;
      // Stays modified (outline) only while a penalty still moves it off profile.
      if (Math.round(settled) !== Math.round(profileFico)) modifiedFeatures.add('fico_score');
      else modifiedFeatures.delete('fico_score');
      modifiedFeatures = modifiedFeatures;
      planStore.set(plan);
      featureValueOverrideStore.set({ fico_score: settled });
      setTimeout(() => featureValueOverrideStore.set({}), 400);
      ficoLinkCalculation = buildFicoBreakdown(applicantBaselineState, buildCurrentEngineState());
      dismissArrows();
      return;
    }

    // NOTE: DTI is intentionally NOT special-cased. Unlike FICO (whose penalties
    // must persist), resetting DTI applies full RESET_TO_LOAD_STATE — it restores
    // DTI AND its source features (Loan Amount, Revolving Balance, Payment Period,
    // Loan Purpose, Annual Income) to their load-time snapshot values via the
    // general path below, and clears the DTI manual delta (see below).

    const overrides = {};

    // ── 1. Un-modify: reset feature + its direct sources -> load-time ─────────
    const unmodify = new Set([featureName, ...sourcesOf(featureName)]);
    unmodify.forEach(name => restoreToLoadTime(name, overrides));
    modifiedFeatures = modifiedFeatures;

    // Clear the two-way-pair input flag when the pair itself is reset.
    if (unmodify.has('revol_util') || unmodify.has('revol_bal')) {
      revolUtilIsInput = false;
    }
    // Reset each counter's manual delta when that counter is restored.
    if (unmodify.has('open_acc')) userOpenDelta = 0;
    if (unmodify.has('total_acc')) userTotalDelta = 0;
    // Clear the Revolving Balance manual delta when the balance (or its two-way
    // sibling) is restored, so the utilization-driven derivation starts clean.
    if (unmodify.has('revol_bal')) userRevolDelta = 0;
    // Clear the DTI manual delta when DTI is restored (its sources are restored
    // to load-time alongside it, so no contribution should linger).
    if (unmodify.has('dti')) userDtiDelta = 0;

    // ── 2. Recompute affected dependents from the remaining modified state ────
    // Restoring a SOURCE (e.g. Open Accounts / Mortgages) changes that source's
    // OTHER dependents (e.g. FICO, Number of Accounts). So recompute the
    // dependents of every restored feature — the reset feature AND its sources —
    // not just the reset feature (which may itself be a leaf, e.g. total_acc).
    const baseline = applicantBaselineState;
    const current = buildCurrentEngineState();
    const recomputed = {};
    unmodify.forEach(src => {
      const { state: next, log } = propagate(
        src, baseline, current, baseline,
        modifiedFeatures, appliedHomeMortgage, userOpenDelta, userTotalDelta, userFicoDelta,
        userDtiDelta, userRevolDelta
      );
      log.filter(l => !l.note).forEach(l => {
        if (!unmodify.has(l.dependent)) recomputed[l.dependent] = next[l.dependent];
      });
    });
    // Home Ownership may have been restored — record its now-applied contribution.
    appliedHomeMortgage = homeMortgageContribution(current.home_ownership);

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

    // Keep the DTI hover breakdown in sync with the post-reset state.
    refreshDtiBreakdown();

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

    // Make the DTI breakdown available on hover before any edit (base row only).
    refreshDtiBreakdown();
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
          // treated as 8 (N+1, the floor of the "more than 7" range).
          state[name] = label === '7+' ? 8 : (parseInt(label, 10) || 0);
        } else if (name === 'inq_last_6mths') {
          // Numeric-count categorical: labels are '0'..'3' and '3+'. The engine
          // needs the integer count; the capped "more than 3" bucket ('3+') is
          // treated as 4 (N+1, the floor of the "more than 3" range).
          state[name] = label === '3+' ? 4 : (parseInt(label, 10) || 0);
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
   * Format the engine's DTI parts into the itemized hover-breakdown object.
   * Row visibility flags come straight from the gated engine computation, so the
   * shown rows sum exactly to the displayed DTI (DTI_USER_EDITS_ONLY).
   */
  const formatDtiBreakdown = (parts) => {
    const money = (n) => '$' + Math.round(n).toLocaleString();
    const pct = (n) => Number(n).toFixed(2);
    const signed = (n) =>
      (n < 0 ? '−$' : '+$') + Math.round(Math.abs(n)).toLocaleString();

    // Build the total as an addition of the active contributors, e.g.
    // "$1,041 + $571 + $434" (or "− $434" for a revolving paydown).
    const pieces = [money(parts.baseDebt)];
    if (parts.loanEngaged) pieces.push('+ ' + money(parts.loanPayment));
    if (parts.revolEngaged) {
      pieces.push((parts.revolDelta < 0 ? '− ' : '+ ') + money(Math.abs(parts.revolDelta)));
    }

    return {
      type: 'dti',
      monthlyIncome: money(parts.monthlyIncome),
      baseDebt: money(parts.baseDebt),
      showLoanRow: parts.loanEngaged,
      loanAmount: money(parts.loanAmount),
      loanPurpose: String(parts.loanPurpose || '').replace(/_/g, ' '),
      paymentPeriod: parts.paymentPeriod,
      loanPayment: money(parts.loanPayment),
      showRevolRow: parts.revolEngaged,
      revolvingBalance: money(parts.revolvingBalance),
      creditUtilization: pct(parts.creditUtilization),
      revolvingDelta: signed(parts.revolDelta),
      hasContributors: parts.loanEngaged || parts.revolEngaged,
      debtSumExpr: pieces.join(' '),
      totalDebt: money(parts.newMonthlyDebt),
      // Computed DTI (from the debt rows) plus the user's own manual adjustment,
      // folded into the result line: "DTI = computed% ±manual% = new%".
      computedDTI: pct(parts.computedDti),
      showManualDti: Math.abs(parts.dtiManualDelta || 0) > 1e-9,
      dtiManualDelta: (parts.dtiManualDelta < 0 ? '−' : '+') + pct(Math.abs(parts.dtiManualDelta || 0)),
      newDTI: pct(parts.newDti)
    };
  };

  /**
   * Build the FICO Score hover breakdown. FICO has a SINGLE channel — the shared
   * hard-inquiry counter (−4 per inquiry). Opened accounts, mortgages, and direct
   * Number of Credit Inquiries edits all feed ONE counter (one row, never split),
   * with the mortgage counted once even though it also bumps the account counters.
   *
   * No-propagation-on-load rule (same as DTI_USER_EDITS_ONLY / Credit
   * Utilization): the counter is computed only from features the USER has edited,
   * so the coach's suggested values never fabricate a change at load. When the
   * gated hard-inquiry count is 0, the hover shows the definition line only.
   * Contributions are floored at 0 — FICO only ever falls.
   */
  const buildFicoBreakdown = (baseline, state) => {
    // Gate each FICO-source feature: use the live value only if the user edited
    // it (a Home Ownership → Mortgage edit marks mort_acc/open_acc modified via
    // propagation), otherwise fall back to the profile so nothing is counted.
    const gated = (name) =>
      modifiedFeatures.has(name) ? (state[name] || 0) : (baseline[name] || 0);
    const inqIncrease = Math.max(0, gated('inq_last_6mths') - (baseline.inq_last_6mths || 0));
    const mortIncrease = Math.max(0, gated('mort_acc') - (baseline.mort_acc || 0));
    const openIncrease = Math.max(0, gated('open_acc') - (baseline.open_acc || 0));
    // Mortgage single-count: exclude the mortgage-driven open bump from the open
    // term so a mortgage adds exactly one inquiry.
    const openExMort = Math.max(0, openIncrease - mortIncrease);
    const hardInquiries = inqIncrease + openExMort + mortIncrease;

    // The user's own manual FICO edit is a SIGNED contribution, gated to when the
    // user actually edited FICO (so a suggested value never fabricates a change).
    const ficoManualDelta = modifiedFeatures.has('fico_score') ? Math.round(userFicoDelta) : 0;

    // Definition-only when nothing applies (no penalty AND no manual edit).
    if (hardInquiries === 0 && ficoManualDelta === 0) return { type: 'fico', engaged: false };

    const profileFICO = Math.round(baseline.fico_score || 0);
    const rawPenalty = hardInquiries * 4;
    const raw = profileFICO + ficoManualDelta - rawPenalty;
    // 662 is the lowest FICO the model bins; the score can never go below it.
    // When the raw value would push below the floor, we clamp and switch the
    // hover to the floor explanation (never show a deduction that doesn't
    // reconcile with the displayed score).
    const isClamped = raw < FICO_FLOOR;
    const newFICO = Math.max(FICO_FLOOR, raw);

    // Assembled arithmetic for the not-clamped final line, e.g.
    // "677 + 34 − 20 = 691". The manual term appears only when non-zero (signed)
    // and the penalty term only when there is a penalty; the pieces sum exactly
    // to newFICO.
    let newScoreExpr = String(profileFICO);
    if (ficoManualDelta !== 0)
      newScoreExpr += (ficoManualDelta < 0 ? ' − ' : ' + ') + Math.abs(ficoManualDelta);
    if (rawPenalty > 0) newScoreExpr += ' − ' + rawPenalty;
    newScoreExpr += ' = ' + newFICO;

    return {
      type: 'fico',
      engaged: true,
      isClamped,
      profileFICO: String(profileFICO),
      showManualRow: ficoManualDelta !== 0,
      ficoManualDelta: (ficoManualDelta < 0 ? '−' : '+') + Math.abs(ficoManualDelta),
      showPenaltyRow: hardInquiries > 0,
      hardInquiries: String(hardInquiries),
      rawPenalty: String(rawPenalty),
      newFICO: String(newFICO),
      newScoreExpr
    };
  };

  /**
   * Build the Credit Utilization hover breakdown. `state` carries the live
   * revolving balance / utilization; the credit limit is recovered from the
   * profile (baseline) balance ÷ utilization. Zero-guard: when the limit can't
   * be recovered (baseline balance or utilization is 0), hasLimit is false and
   * the recovery rows are hidden.
   */
  const buildRevolUtilBreakdown = (baseline, state) => {
    // No-propagation-on-load rule (consistent with DTI_USER_EDITS_ONLY): the
    // breakdown may only compute from live values the user has ENGAGED. Until the
    // user edits Credit Utilization or Revolving Balance, `state` still holds the
    // (unreconciled) suggested balance, so computing a "new utilization" from it
    // would be inconsistent with the profile utilization the card shows. Show the
    // definition line only in that case.
    const engaged =
      modifiedFeatures.has('revol_util') || modifiedFeatures.has('revol_bal');
    if (!engaged) return { type: 'revol_util', engaged: false };

    const money = (n) => '$' + Math.round(n).toLocaleString();
    const pct = (n) => Number(n).toFixed(2);
    const creditLimit = creditLimitFromBaseline(baseline); // null when indeterminate
    const currentUtil = Number(baseline.revol_util) || 0;
    const newUtil = Number(state.revol_util) || 0;
    let changeVerb = 'stayed at';
    if (newUtil > currentUtil + 1e-9) changeVerb = 'increased';
    else if (newUtil < currentUtil - 1e-9) changeVerb = 'decreased';
    return {
      type: 'revol_util',
      engaged: true,
      hasLimit: creditLimit !== null,
      creditLimit: creditLimit !== null ? money(creditLimit) : null,
      currentBalance: money(baseline.revol_bal || 0),
      currentUtilization: pct(currentUtil),
      newBalance: money(state.revol_bal || 0),
      newUtilization: pct(newUtil),
      changeVerb
    };
  };

  /**
   * Build the Revolving Balance hover breakdown as a sum of contributions:
   *   newBalance = profile balance + your manual edit + utilization-driven delta
   * Each row is shown only when its delta ≠ 0, and the rows always sum to the
   * displayed balance. The utilization-driven part is attributed only when Credit
   * Utilization is the current INPUT (revolUtilIsInput) — otherwise the whole
   * change is the user's own manual edit. Definition-only until the user edits
   * Revolving Balance or Credit Utilization (no-propagation-on-load rule).
   */
  const buildRevolBalBreakdown = (baseline, state) => {
    const engaged =
      modifiedFeatures.has('revol_bal') || modifiedFeatures.has('revol_util');
    if (!engaged) return { type: 'revol_bal', engaged: false };

    const money = (n) => '$' + Math.round(n).toLocaleString();
    const signedMoney = (n) =>
      (n < 0 ? '−$' : '+$') + Math.round(Math.abs(n)).toLocaleString();
    const profileBal = baseline.revol_bal || 0;
    const creditLimit = creditLimitFromBaseline(baseline); // null when indeterminate
    const manualDelta = userRevolDelta; // signed direct balance edit
    // Utilization-driven part: only when Credit Utilization is the input (balance
    // is derived from it) and the limit is recoverable.
    const utilDriven =
      revolUtilIsInput && creditLimit !== null
        ? ((Number(state.revol_util) || 0) / 100) * creditLimit - profileBal
        : 0;
    const newBalance = profileBal + manualDelta + utilDriven;
    const showManualRow = Math.abs(manualDelta) > 0.5;
    const showUtilRow = Math.abs(utilDriven) > 0.5;

    // Assemble the total as an addition of the shown contributions, e.g.
    // "$5,000 + $3,733" (or "$5,000 − $200" for a paydown), summing to newBalance.
    const pieces = [money(profileBal)];
    if (showManualRow) pieces.push((manualDelta < 0 ? '− ' : '+ ') + money(Math.abs(manualDelta)));
    if (showUtilRow) pieces.push((utilDriven < 0 ? '− ' : '+ ') + money(Math.abs(utilDriven)));

    return {
      type: 'revol_bal',
      engaged: true,
      profileBalance: money(profileBal),
      showManualRow,
      manualDelta: signedMoney(manualDelta),
      showUtilRow,
      utilDrivenDelta: signedMoney(utilDriven),
      hasContributors: showManualRow || showUtilRow,
      balanceSumExpr: pieces.join(' '),
      newBalance: money(newBalance)
    };
  };

  /**
   * Build the Number of Mortgages hover extra. Explains the CURRENT STATE, not
   * the last event: show the Home Ownership note whenever Home Ownership is
   * currently set to "Mortgage" (that mortgage persists regardless of later
   * manual edits to the count). '7+' cap: if the profile bucket is already
   * capped at '7+', the home mortgage isn't a distinguishable addition, so show
   * only the plain definition. Otherwise returns null (plain definition only).
   */
  const buildMortAccBreakdown = (baseline, state) => {
    if (state.home_ownership !== MORTGAGE_HOME_VALUE) return null;
    if (displayToInternal('mort_acc', baseline.mort_acc) === '7+') return null;
    return { type: 'mort_acc' };
  };

  // Mortgage delta for the account hovers, honoring the '7+' cap (a profile
  // already at '7+' can't increase, so it contributes no mortgage row).
  const hoverMortgageDelta = (baseline, state) => {
    if (displayToInternal('mort_acc', baseline.mort_acc) === '7+') return 0;
    return Math.max(0, Math.round((state.mort_acc || 0) - (baseline.mort_acc || 0)));
  };

  /**
   * Build the Number of Open Accounts itemized breakdown. Uses the SAME live
   * deltas the counter uses (userOpenDelta + mortgage delta), so the rows always
   * sum to the value on the card. Rows shown only when their delta ≠ 0.
   */
  const buildOpenAccBreakdown = (baseline, state) => {
    const profileOpen = Math.round(baseline.open_acc || 0);
    const mortDelta = hoverMortgageDelta(baseline, state);
    const openDelta = Math.round(userOpenDelta); // signed: closures are negative
    if (openDelta === 0 && mortDelta === 0) return null; // definition only
    return {
      type: 'open_acc',
      profileOpen: String(profileOpen),
      showOpenRow: openDelta !== 0,
      openManualDelta: (openDelta < 0 ? '−' : '+') + Math.abs(openDelta),
      showMortgageRow: mortDelta > 0,
      mortgageDelta: String(mortDelta),
      mortgagePlural: mortDelta !== 1,
      newOpenAccounts: String(profileOpen + openDelta + mortDelta)
    };
  };

  /**
   * Build the Number of Accounts itemized breakdown. Uses the SAME live deltas
   * the counter uses — the manual open delta (userOpenDelta, SIGNED), the
   * mortgage delta (floored: a source contribution), and the user's OWN direct
   * Number-of-Accounts edit (userTotalDelta, SIGNED, shown last as "Adjusted by
   * you") — so the rows always sum to the value on the card. Manual deltas may be
   * negative; a downward edit shows a "−" row and lowers the total. Rows shown
   * only when their delta ≠ 0.
   */
  const buildTotalAccBreakdown = (baseline, state) => {
    const profileTotal = Math.round(baseline.total_acc || 0);
    const mortDelta = hoverMortgageDelta(baseline, state);
    const accountsDelta = Math.round(userTotalDelta); // direct edit (signed)
    const openDelta = Math.round(userOpenDelta);      // manual open delta (signed)
    if (accountsDelta === 0 && openDelta === 0 && mortDelta === 0) return null; // definition only
    return {
      type: 'total_acc',
      profileAccounts: String(profileTotal),
      showOpenRow: openDelta !== 0,
      openAccountsDelta: (openDelta < 0 ? '−' : '+') + Math.abs(openDelta),
      openPlural: Math.abs(openDelta) !== 1,
      showMortgageRow: mortDelta > 0,
      mortgageDelta: String(mortDelta),
      mortgagePlural: mortDelta !== 1,
      showAccountsRow: accountsDelta !== 0,
      accountsManualDelta: (accountsDelta < 0 ? '−' : '+') + Math.abs(accountsDelta),
      newTotalAccounts: String(profileTotal + openDelta + mortDelta + accountsDelta)
    };
  };

  /**
   * Refresh the DTI, Credit-Utilization, Revolving-Balance, Number-of-Mortgages
   * and Number-of-Open-Accounts breakdowns from the authoritative current model
   * state (used at load and after a reset, when ebmLocal holds settled values).
   */
  const refreshDtiBreakdown = () => {
    if (!plan || !applicantBaselineState) return;
    const current = buildCurrentEngineState();
    const params = computeParams(
      applicantBaselineState, current, modifiedFeatures, userFicoDelta, userDtiDelta, userRevolDelta
    );
    dtiLinkCalculation = formatDtiBreakdown(computeDtiParts(current, params));
    ficoLinkCalculation = buildFicoBreakdown(applicantBaselineState, current);
    revolUtilLinkCalculation = buildRevolUtilBreakdown(applicantBaselineState, current);
    revolBalLinkCalculation = buildRevolBalBreakdown(applicantBaselineState, current);
    mortAccLinkCalculation = buildMortAccBreakdown(applicantBaselineState, current);
    openAccLinkCalculation = buildOpenAccBreakdown(applicantBaselineState, current);
    totalAccLinkCalculation = buildTotalAccBreakdown(applicantBaselineState, current);
  };

  /**
   * Populate the FICO / DTI / revolving link-popup calculation blocks from the
   * engine's own parameters so the explanation matches the applied values.
   */
  const populateLinkCalculations = (editedFeature, baseline, current, next, changedSet) => {
    const params = computeParams(
      baseline, current, modifiedFeatures, userFicoDelta, userDtiDelta, userRevolDelta
    );

    // FICO breakdown — the single hard-inquiry channel, gated to user edits.
    // Built from the post-propagation state (`next`), which carries the
    // reconciled account/mortgage counts driving the counter.
    ficoLinkCalculation = buildFicoBreakdown(baseline, next);

    // DTI breakdown — always refreshed from the engine's post-propagation state
    // (base row + whichever contributor rows are engaged).
    dtiLinkCalculation = formatDtiBreakdown(computeDtiParts(next, params));

    // Credit Utilization + Revolving Balance breakdowns — always refreshed from
    // the live post-propagation state (`next`); credit limit from the profile.
    revolUtilLinkCalculation = buildRevolUtilBreakdown(baseline, next);
    revolBalLinkCalculation = buildRevolBalBreakdown(baseline, next);
    // Number of Mortgages extra (shown when Home Ownership is currently Mortgage).
    mortAccLinkCalculation = buildMortAccBreakdown(baseline, next);
    // Number of Open Accounts extra (shown when mortgages exceed the profile).
    openAccLinkCalculation = buildOpenAccBreakdown(baseline, next);
    // Number of Accounts itemized breakdown.
    totalAccLinkCalculation = buildTotalAccBreakdown(baseline, next);
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

    // ── Step 4: dismiss button close to the SOURCE (arrow origin) ─────────
    // Anchor the × at the bundle origin — the point on the SOURCE card's edge
    // where the arrows start — so it stays next to the feature the arrows
    // originate from, not the arrowheads. Because recomputeArrows re-runs on
    // every card expand/collapse and scroll, the × tracks the source whether
    // any cards (source or dependent) are expanded or not.
    const btnR = 14;
    const cardRects = Array.from(
      document.querySelectorAll('[data-feature-name]')
    ).map(el => el.getBoundingClientRect());

    const overlapsCard = (bx, by) => cardRects.some(r =>
      bx + btnR > r.left && bx - btnR < r.right &&
      by + btnR > r.top  && by - btnR < r.bottom
    );

    // Perpendicular to the dominant outward (source→targets) direction.
    const pUx = domUy, pUy = -domUx;
    // Start just outside the source-card edge at the bundle origin.
    const baseX = bundleX + domUx * 16;
    const baseY = bundleY + domUy * 16;

    // Try positions near the origin (perpendicular to both sides, then a little
    // further out along the arrows) until one clears every feature card.
    const candidates = [
      [ pUx,  pUy, 22], [ -pUx, -pUy, 22],
      [ pUx,  pUy, 36], [ -pUx, -pUy, 36],
      [ domUx, domUy, 10 ], [ domUx, domUy, 26 ],
      [ pUx,  pUy, 52], [ -pUx, -pUy, 52],
    ];

    let btnX = baseX + pUx * 22;
    let btnY = baseY + pUy * 22;

    for (const [ux, uy, dist] of candidates) {
      const cx = baseX + ux * dist;
      const cy = baseY + uy * dist;
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

  // ── "Effects of your changes" (right panel) ─────────────────────────────────
  // Display-only: builds source-edit events from the engine's EXISTING
  // propagation output (before/after dependent values) and the SAME per-feature
  // EBM contribution that "What's driving this score" uses. No propagation logic
  // is added or changed here.

  // Features displayed as currency (prefixed with $).
  const MONEY_FEATURES = new Set(['loan_amnt', 'annual_inc', 'revol_bal']);

  /** Pretty display value for a feature value in engine display units. */
  const formatEffectValue = (name, val) => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') {
      // Categorical label — humanize (Title Case, underscores → spaces).
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
   * Source-value label for a row. Categorical sources show a transition
   * (e.g. "Rent → Mortgage") from the applicant's profile value to the current
   * value; numeric sources show the single current (formatted) value.
   */
  const formatSourceValue = (sourceName, rawAfter) => {
    const feat = plan.features.find((f) => f.data.name === sourceName);
    if (feat && feat.data.type === 'categorical') {
      const before = formatEffectValue(sourceName, applicantBaselineState?.[sourceName]);
      const after = formatEffectValue(sourceName, rawAfter);
      return before && before !== after ? `${before} → ${after}` : after;
    }
    return formatEffectValue(sourceName, rawAfter);
  };

  /**
   * EBM main-effect contribution (log-odds) of `depName` set to `internalValue`,
   * holding every other feature at the current sample. This is exactly the
   * per-feature score "What's driving this score" reads
   * (plan.ebmLocal.countedScores[name] / countScore).
   */
  const featureContribution = (depName, internalValue) => {
    const f = plan.features.find((ff) => ff.data.name === depName);
    if (!f) return 0;
    const sampleCopy = plan.ebmLocal.sample.slice();
    sampleCopy[f.featureID] = internalValue;
    const scores = plan.ebmLocal.countScore(sampleCopy);
    return scores[depName] ?? 0;
  };

  /**
   * Build one effect entry: dependent `depName` changed from `before` to `after`
   * (engine display units) because the user edited `sourceName`. The thumb
   * direction is the sign of the contribution DELTA (after − before), not the
   * value/count direction (per the thumb rule).
   */
  const buildEffectEntry = (sourceName, depName, before, after) => {
    const beforeInternal = displayToInternal(depName, before);
    const afterInternal = displayToInternal(depName, after);
    const contribBefore = featureContribution(depName, beforeInternal);
    const contribAfter = featureContribution(depName, afterInternal);
    const delta = contribAfter - contribBefore; // >0 helped approval, <0 hurt it
    const helps = delta >= 0;

    const sourceDisplay = DISPLAY_NAMES[sourceName] || sourceName;
    const depDisplay = DISPLAY_NAMES[depName] || depName;
    const beforeDisplay = formatEffectValue(depName, before);
    const afterDisplay = formatEffectValue(depName, after);

    const numeric = typeof before === 'number' && typeof after === 'number';
    const valueVerb = numeric
      ? after > before
        ? 'raised'
        : after < before
        ? 'lowered'
        : 'changed'
      : 'changed';
    const approvalVerb = helps ? 'raised' : 'lowered';
    const tooltip =
      `${sourceDisplay} ${valueVerb} your ${depDisplay.toLowerCase()} ` +
      `from ${beforeDisplay} to ${afterDisplay}, which ${approvalVerb} your approval.`;

    return {
      depName,
      depDisplayName: depDisplay,
      beforeDisplay,
      afterDisplay,
      helps,
      contributionDelta: delta,
      tooltip
    };
  };

  /**
   * Record (or refresh) the "Effects of your changes" row for one source edit.
   * Collapses by source: the newest edit of a source replaces its prior row and
   * moves to the top (newest first).
   */
  const recordChangeEffects = (sourceName, sourceValueRaw, effects) => {
    if (effects.length === 0) return;
    const event = {
      sourceName,
      sourceDisplayName: DISPLAY_NAMES[sourceName] || sourceName,
      sourceValueDisplay: formatSourceValue(sourceName, sourceValueRaw),
      effects
    };
    changeEffectsStore.update((list) => [
      event,
      ...list.filter((ev) => ev.sourceName !== sourceName)
    ]);
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
    // appliedHomeMortgage / userOpenDelta / userTotalDelta let the account
    // counters sum ALL sources (profile + each manual delta + mortgage delta).
    const { state: next, log } = propagate(
      featureName, baseline, current, baseline,
      modifiedFeatures, appliedHomeMortgage, userOpenDelta, userTotalDelta, userFicoDelta,
      userDtiDelta, userRevolDelta
    );

    // Record the home's now-applied contribution so the NEXT Home Ownership
    // change removes exactly this +1 (rather than resetting the counters).
    appliedHomeMortgage = homeMortgageContribution(current.home_ownership);

    // Dependents that actually changed vs. the current state.
    const computedUpdates = {}; // internal feature name → internal value
    const activeTargets = [];
    const changedSet = new Set();
    // Effect entries for the "Effects of your changes" section. `current[dep]` is
    // the dependent's value immediately BEFORE this edit's ripple (the engine has
    // not applied the dependent updates yet — that happens in step 4 below), so
    // it is exactly the "before" value the task requires.
    const effectEntries = [];
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
      effectEntries.push(buildEffectEntry(featureName, dep, before, after));
    });

    // Publish which features changed via propagation so ScorePanel can label
    // them PROPAGATED (vs DIRECT) in the score-change breakdown popup.
    propagatedFeaturesStore.set(changedSet);
    // Populate the link-popup calculation blocks from the engine's parameters.
    populateLinkCalculations(featureName, baseline, current, next, changedSet);

    // Nothing actually propagated (e.g. a home-ownership change that is not a
    // mortgage transition) — stop.
    if (activeTargets.length === 0) {
      return;
    }

    // Record this source edit + its ripple for the "Effects of your changes"
    // section. `current[featureName]` is the source's just-edited value.
    recordChangeEffects(featureName, current[featureName], effectEntries);

    // Keep lastKnownValues in sync so re-expanding a card doesn't refire.
    Object.entries(computedUpdates).forEach(([name, internalValue]) => {
      lastKnownValues[name] = internalValue;
    });

    // (The propagation status message and connector arrows were removed; the
    // value propagation below is unchanged.)

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

  /**
   * (Re)attach the ResizeObserver to every card column. Columns reflow whenever
   * a card inside them expands/collapses (or the window resizes), so observing
   * them recomputes the arrows from the settled layout — regardless of which
   * card type toggled or which section it lives in.
   */
  const observePanels = () => {
    if (!arrowResizeObserver || !component) return;
    arrowResizeObserver.disconnect();
    component.querySelectorAll('.card-column').forEach(el => arrowResizeObserver.observe(el));
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

    // The history sidebar squeezes the main content with an animated
    // padding-right — the cards MOVE without resizing, so the column
    // ResizeObserver never fires. The arrows overlay is viewport-fixed, so we
    // must re-read positions throughout that slide: reuse the same
    // recompute-per-frame loop the card animations use. (Also covers the X
    // dismiss button, which recomputeArrows positions.)
    let sidebarInit = true;
    const unsubSidebar = historySidebarOpenStore.subscribe(() => {
      if (sidebarInit) { sidebarInit = false; return; }
      onCardToggle();
    });
    unsubscribes.push(unsubSidebar);

    // Window resizes shift the viewport-fixed overlay's frame too.
    window.addEventListener('resize', onCardToggle);

    // Recompute arrows on ANY panel geometry change — expand/collapse, content
    // reflow, or window resize. The panel is a fixed-height scroll container, so
    // its own size never changes; instead we observe the card columns, which
    // reflow when a card inside them changes height. The rAF wrapper lets the
    // layout settle before reading positions.
    if (typeof ResizeObserver !== 'undefined') {
      arrowResizeObserver = new ResizeObserver(() => {
        if (resizeRafId) cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = null;
          recomputeArrows();
        });
      });
      observePanels();
    }
  });

  onDestroy(() => {
    unsubscribes.forEach(unsub => unsub());
    if (propagationDebounceTimer) clearTimeout(propagationDebounceTimer);
    window.removeEventListener('scroll', onScroll, { capture: true });
    window.removeEventListener('resize', onCardToggle);
    if (scrollRafId) cancelAnimationFrame(scrollRafId);
    if (cardAnimRafId) cancelAnimationFrame(cardAnimRafId);
    if (resizeRafId) cancelAnimationFrame(resizeRafId);
    if (arrowResizeObserver) arrowResizeObserver.disconnect();
  });

  // Re-attach the observer when the feature grid (re)renders new columns/cards.
  $: featureGrid && arrowResizeObserver && observePanels();

  $: windowLoaded && planStore && !initialized && initFeatureCards();

</script>

<style lang='scss'>
  @import './FeaturePanel.scss';
</style>

<div class='feature-panel' bind:this={component}>

  <div class='card-block'>
    <div class='row-header'>
      <span class='label'>Suggested Changes</span>
    </div>

    <div class='card-row'>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.changed.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in FEATURE_DEPS}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
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

</div>