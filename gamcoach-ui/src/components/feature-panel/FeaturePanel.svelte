<script>
  // @ts-check
  import FeatureCard from '../feature-card/FeatureCard.svelte';
  import FeatureCardCat from '../feature-card-cat/FeatureCardCat.svelte';
  import { FeatureGrid } from './FeaturePanel';

  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG } from '../../utils/utils';
  import { LINK_POPUP_TEXT } from '../../utils/featureDefinitions';
  import '../../typedef';
  import { EBMLocal } from '../../ebm/ebmLocal';
  import { Plan, Constraints } from '../coach/Coach';

  import { onMount, onDestroy, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { tooltipConfigStore, featureValueOverrideStore, cardToggleStore, propagatedFeaturesStore, historySidebarOpenStore, changeEffectsStore, ideasStore, ideaDismissStore, ideaApplyStore, derogFloorHintStore } from '../../store';
  import { sigmoid } from '../../ebm/ebm';
  import { isApproved } from '../../utils/score';
  import {
    STRUCTURAL_EXCLUSIONS,
    POLICY_OVERRIDES,
    IMPOSSIBLE_TO_CHANGE,
    SMALL_STEP_FRACTION,
    LARGE_STEP_FRACTION,
    MIN_GAIN,
    ideaVerb,
    isBaselineActionable
  } from '../ideas/ideasConfig';
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
    EDGES,
    derogRank,
    derogSubtract,
    loanMonthlyPayment,
    aprForPurpose,
    appliedLoanDtiContribution,
    loanCostFromExample
  } from '../../engine/index.mjs';

  export let windowLoaded = false;
  export let planStore = null;
  export let constraintsStore = null;

  // First-time setup (Change 2): when true, this panel is the pre-generation
  // "setup plan". Card edits are captured as raw baseline values but do NOT
  // propagate to dependents, and no score is involved.
  export let setupMode = false;

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

  // Hide/unhide each of the three feature groups (the group name stays visible;
  // only its cards are hidden). Hidden via CSS display:none so the card columns
  // stay in the DOM (bindings / observers unaffected).
  let collapsedGroups = { changed: false, configured: false, other: false };
  const toggleGroup = (g) => {
    collapsedGroups[g] = !collapsedGroups[g];
    collapsedGroups = collapsedGroups;
  };

  // ── Link-popup explanatory text for indirectly-affected features ────────────
  // Add an entry here whenever a feature gets real calculation mechanics so the
  // popup shows an informative message instead of the default placeholder.
  // Plain-language definition shown on the "i"-icon hover for EVERY feature card.
  // All 20 features have an entry, so the icon (gated on membership here) appears
  // on every card. Features that also have propagation edges add their dependency
  // lines from FEATURE_DEPS below. Sourced from the shared module so the input-form
  // hover uses the exact same definitions.

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
    'revol_util':     { changedBy: 'Unpaid Credit Card Balance',
                        canChange: 'Unpaid Credit Card Balance, Debt to Income Ratio' },
    'open_acc':       { changedBy: 'Number of Mortgages, Home Ownership',
                        canChange: 'Number of Accounts, FICO Score' },
    'mort_acc':       { changedBy: 'Home Ownership',
                        canChange: 'Number of Open Accounts, Number of Accounts, FICO Score' },
    'dti':            { changedBy: 'Loan Amount, Payment Period, Loan Purpose, Annual Income, Unpaid Credit Card Balance, Credit Utilization' },
    'fico_score':     { changedBy: 'Number of Open Accounts, Number of Mortgages, Home Ownership, Number of Credit Inquiries' },
    'total_acc':      { changedBy: 'Number of Open Accounts, Number of Mortgages, Home Ownership' },
    // One-way edge: Number of Bankruptcies -> Number of Derogatory Records
    // (a bankruptcy is a subset of derogatory records). Not reversed.
    'pub_rec_bankruptcies': { canChange: 'Number of Derogatory Records' },
    'pub_rec':              { changedBy: 'Number of Bankruptcies' }
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
  // Features whose values came from LOAD-TIME propagation of the coach's
  // suggestions. They are put in modifiedFeatures
  // so the DTI/FICO gate keeps their contributions engaged on later user edits,
  // but they are NOT user-caused — this set excludes them from the blue "you
  // modified" outline and keeps their provenance "suggested". A real user edit of
  // such a feature removes it from here (it then becomes a genuine user change).
  // Always empty when the flag is off, so every gate below is a no-op then.
  let suggestedAtLoad = new Set();
  // Frozen record of the load-time propagation state, captured once per plan when
  // the flag is on (null otherwise). A reset uses it to return to the PROPAGATED
  // load snapshot — re-establishing the suggested inputs' gate engagement, their
  // seeded deltas, and their "suggested" provenance — instead of falling back to
  // the profile baseline. Null when the flag is off, so the reset re-establishment
  // is entirely skipped and reset behaves byte-identically to today.
  let loadSnapshot = null;
  // Display names for all features — used in arrow labels
  const DISPLAY_NAMES = {
    'loan_amnt': 'Loan Amount', 'dti': 'Debt to Income Ratio',
    'annual_inc': 'Annual Income', 'revol_bal': 'Unpaid Credit Card Balance',
    'open_acc': 'Number of Open Accounts', 'fico_score': 'FICO Score',
    'term': 'Payment Period', 'home_ownership': 'Home Ownership',
    'purpose': 'Loan Purpose', 'inq_last_6mths': 'Number of Credit Inquiries',
    'pub_rec_bankruptcies': 'Number of Bankruptcies', 'revol_util': 'Credit Utilization',
    'total_acc': 'Number of Accounts', 'mort_acc': 'Number of Mortgages',
    'earliest_cr_line': 'Credit History Length', 'emp_length': 'Employment Length',
    'verification_status': 'Income Verification Status', 'delinq_2yrs': 'Number of Past Due',
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
  // The COACH's suggested FICO delta (immutable, seeded at load). userFicoDelta
  // holds the TOTAL (coach + any later user edit); subtracting this recovers the
  // user's OWN part, so a coach suggestion is never mislabeled as the user's change.
  let coachFicoDelta = 0;
  // Same pattern for the two other editable-and-derived features: a SIGNED manual
  // delta vs. the profile value, folded onto the computed result so a later
  // source change never discards it. Cleared only on that feature's own reset.
  let userDtiDelta = 0;    // DTI: newDTI = computedDTI + userDtiDelta
  let userRevolDelta = 0;  // Revolving Balance: newBal = profile + userRevolDelta + util-driven
  // Revolving-Balance anchor, captured at load from the coach's suggested state.
  // `revolAnchorBal`/`revolAnchorUtil` are the
  // DISPLAYED (post-fold) suggested balance and utilization the user is looking at;
  // `coachRevolDelta` is that balance's offset from the balance its OWN displayed
  // utilization implies. Folding it into userRevolDelta makes a later Credit
  // Utilization edit anchor the recompute to the suggested balance, and measuring
  // the utilization change from `revolAnchorUtil` (not the profile) keeps the hover
  // consistent with what the user sees in BOTH flag states (flag-on folds util at
  // load; flag-off leaves it at the profile). Tracked separately so the user's OWN
  // direct balance edits compose on top without double-counting.
  let coachRevolDelta = 0;
  let revolAnchorBal = 0;
  let revolAnchorUtil = 0;
  // SINGLE SOURCE OF TRUTH for the revolving pair. The two independent inputs the
  // user controls are (revolInputUtil, userRevolDelta), and BOTH the engine and the
  // Revolving-Balance breakdown derive the balance from the ONE invariant:
  //     revol_bal = (revolInputUtil / 100) · L  +  userRevolDelta
  // `revolInputUtil` is the utilization the user has committed as an INPUT (the
  // "util-driven" free variable) — it is updated ONLY on a Credit Utilization edit,
  // and it is NOT the same as the live `revol_util` the card shows after a direct
  // balance edit (which the engine recomputes to the balance's full implied util).
  // `userRevolDelta` is the direct balance offset on top, captured against
  // revolInputUtil. Keeping the util-driven part and the direct edit as these two
  // persistent, independently-anchored quantities is what stops one from clobbering
  // the other when both are present (util-then-balance / balance-then-util).
  let revolInputUtil = 0;
  // Provenance for Number of Derogatory Records: the "independent part" — the
  // user's OWN (non-bankruptcy) derogatory marks, tracked as a bin label
  // ('0'..'2+'). Number of Derogatory Records = min(2+, independentPart +
  // current_bankruptcy). Initialized at baseline to max(0, base_derog −
  // base_bankruptcy); recomputed after a direct edit to Derogatory Records
  // (backing out the current bankruptcy contribution). Cleared to the baseline
  // value on a reset of either feature.
  let derogIndependentPart = '0';

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

  /** The current Number of Bankruptcies as a bin label ('0'..'2+'). */
  const currentBankruptcyLabel = () => {
    const f = plan?.features.find((ff) => ff.data.name === 'pub_rec_bankruptcies');
    const v = f ? plan.ebmLocal.sample[f.featureID] : '0';
    return v == null ? '0' : v;
  };

  /** Flash the transient floor-guard hint on the Derogatory Records card. */
  const flashDerogFloorHint = () => {
    derogFloorHintStore.set({
      feature: 'pub_rec',
      message: "Can't be lower than your number of bankruptcies.",
      token: Date.now()
    });
    setTimeout(() => {
      derogFloorHintStore.update((h) => (h.feature === 'pub_rec' ? {} : h));
    }, 2600);
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
    // Two-source model: the manual delta is the offset from the PROPAGATED DTI (the
    // value the current inputs produce, manual delta = 0) — NOT from the profile
    // baseline. So displayed = propagated + delta == the typed value, and the delta
    // stays a FIXED constant when inputs later change (income/loan move the
    // propagated part; the manual offset persists). For a drag this captures
    // (dragged DTI − propagated DTI) at drag-end.
    const propagated = computeDtiParts(
      cur,
      computeParams(applicantBaselineState, cur, modifiedFeatures, userFicoDelta, 0, userRevolDelta)
    ).computedDti;
    userDtiDelta = (cur.dti || 0) - (propagated || 0);
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
    const L = creditLimitFromBaseline(applicantBaselineState);
    // userRevolDelta is the balance's offset from the balance its CURRENT utilization
    // implies — the invariant the ENGINE adds to (newUtil/100·L) in revolBalFromUtil.
    // Left EXACTLY as-is: this drives the scored balance, and the bug is purely in the
    // breakdown DISPLAY, not the scored value. The breakdown no longer reads this
    // delta — it derives the direct-edit contribution as a residual from the card's
    // own value (see buildRevolBalBreakdown), so the two paths can no longer diverge.
    const utilImplied =
      L !== null ? ((Number(cur.revol_util) || 0) / 100) * L : (applicantBaselineState.revol_bal || 0);
    userRevolDelta = (cur.revol_bal || 0) - utilImplied;
  };

  /**
   * Seed the coach's suggested Revolving-Balance offset so that a later Credit
   * Utilization edit anchors the recompute to the SUGGESTED balance, not the
   * profile. Editing
   * utilization is the user's own action, whose propagation is always on, so the
   * balance it derives must chain from the plan the user is viewing. Idempotent —
   * re-runnable on plan (re)mount and on a revol-pair reset.
   */
  const seedRevolCoachOffset = () => {
    if (!applicantBaselineState || !plan) return;
    const baseline = applicantBaselineState;
    const profileBal = baseline.revol_bal || 0;
    // Read the coach's DIRECT balance suggestion from the IMMUTABLE raw CF, NOT the
    // post-fold util-derived balance. When the coach suggested UTILIZATION instead,
    // the balance is a dependent whose raw-CF value is still the profile, so this
    // offset is 0. Reading one immutable source keeps the suggested-driven and
    // user-driven breakdowns from diverging (and never depends on fold timing, which
    // is what produced the $0 base).
    // RE-BASELINE: no coach suggestion is applied, so the revolving anchor is the
    // user's OWN profile balance and the coach offset is always zero. The anchor
    // (profile balance + profile utilization) is still needed so the revolving /
    // utilization breakdowns decompose the user's own edits honestly.
    coachRevolDelta = 0;
    revolAnchorBal = profileBal;
    revolAnchorUtil = Number(baseline.revol_util) || 0;
    userRevolDelta = 0;
    // Committed utilization input starts at the anchor (profile) utilization — no
    // util edit has happened yet, so the whole balance is the anchor's util-implied.
    revolInputUtil = revolAnchorUtil;
  };

  // Set up the GAM Coach feature cards
  const initFeatureCards = () => {
    initialized = true;

    // Subscribe to the plan store and initialize features
    unsubscribes.push(
      planStore.subscribe(value => {
        plan = value;
        // Ideas are the plan's fixed suggested changes (set once per plan in
        // initIdeas); they no longer recompute on every edit. The live status
        // line in IdeasToTry tracks the score instead.
      })
    );

    unsubscribes.push(
      constraintsStore.subscribe(value => {
        constraints = value;
      })
    );

    // Dismiss channel: IdeasToTry writes the dismissed idea's feature name here;
    // remove it and add a directional "what helps next" replacement.
    unsubscribes.push(
      ideaDismissStore.subscribe((name) => {
        if (name) {
          handleIdeaDismiss(name);
          ideaDismissStore.set(null);
        }
      })
    );

    // Apply channel: clicking an initial (amount) idea applies its suggested value.
    // A request may be TAGGED with a `planIndex` (from Compare Plans, where a chip
    // belongs to a specific plan's column). Only the FeaturePanel whose plan matches
    // consumes such a request — so the change lands on the clicked plan (after it is
    // activated), not on whatever plan happened to be active. A request WITHOUT a
    // planIndex (the right-panel "Ideas to try") targets the active plan as before.
    // Leaving a non-matching tagged request in place lets the matching panel pick it
    // up when it mounts.
    unsubscribes.push(
      ideaApplyStore.subscribe((req) => {
        if (req && req.name !== undefined) {
          if (req.planIndex !== undefined && plan && req.planIndex !== plan.planIndex) {
            return;
          }
          applyIdea(req.name, req.value);
          ideaApplyStore.set(null);
        }
      })
    );

    // Seed lastKnownValues with the initial coach-suggested values so that
    // the propagation helpers have baseline data even before the user moves any slider.
    initLastKnownValues();

    // Run causal propagation on this plan's suggested changes so dependents display
    // their propagated values immediately. Runs
    // per-plan (this whole init re-runs on each plan switch via Coach.svelte's
    // {#key} remount). No-op when the flag is off.
    propagateSuggestedChangesAtLoad();

    // Seed the Revolving-Balance anchor — FLAG-INDEPENDENT — from the raw CF + profile
    // utilization, so the revolving/utilization breakdowns decompose from a stable
    // base. Runs AFTER the fold (so revolUtilIsInput reflects it), but the anchor
    // itself is derived from immutable sources, not the folded state.
    seedRevolCoachOffset();

    // Rebuild the DTI / revolving / utilization breakdowns AFTER the anchor is seeded.
    // The fold builds them once (with the anchor still at its initial 0); this second
    // pass uses the seeded anchor, so the suggested-driven revolving breakdown shows
    // the correct base instead of $0 — matching the user-driven path exactly.
    refreshDtiBreakdown();

    // Organize the features into corresponding sections. Runs AFTER the fold so a
    // propagated dependent (its isChanged set to 1 by the fold) is grouped with its
    // suggested sources under "Suggested Changes" — identically on initial load and
    // on every plan-switch remount (the fold is now idempotent), so group placement
    // is deterministic from the plan and never depends on navigation history.
    featureGrid.loadFeatures(plan.features, constraints);
    featureGrid = featureGrid;

    // Start the affected-features section empty on (re)init. RE-BASELINE: nothing
    // is suggested-and-applied at load, so there are no suggested-change ripples
    // to seed — the panel fills only from the user's own edits.
    changeEffectsStore.set([]);
    // Show the one baseline shift — the applied loan folded into DTI — as an
    // affected-features row (only after setup, when the fold has been applied).
    if (!setupMode) recordLoanFoldEffect();

    // Build "Ideas to try" for this plan: the plan's suggested changes, with
    // amounts. Fixed per plan; dismissals swap in directional replacements.
    initIdeas();

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
      // A reset settles synchronously — recompute directional ideas against the
      // restored state (covers all of handleFeatureReset's internal return paths).
      try { rebuildIdeas(); } catch (err) { /* ideas must never break the UI */ }
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

    // Floor guard: a direct edit to Number of Derogatory Records can never be set
    // below the current Number of Bankruptcies (bankruptcies are a subset). Reject
    // such a click entirely — the value must NOT change wherever the user clicks
    // below the bankruptcy bin. Keep the current value, snap the card back to it,
    // flash the hint, and stop (no model write, no propagation).
    if (
      feature.data.name === 'pub_rec' &&
      derogRank(newValue) < derogRank(currentBankruptcyLabel())
    ) {
      const currentDerog = plan.ebmLocal.sample[feature.featureID];
      feature.hypotheticalValue = currentDerog;
      flashDerogFloorHint();
      // Revert the card's selection (it moved to the clicked level on interaction)
      // back to the unchanged current value.
      featureValueOverrideStore.set({ pub_rec: currentDerog });
      setTimeout(() => featureValueOverrideStore.set({}), 400);
      return;
    }

    // Update the local EBM
    plan.ebmLocal.updateFeature(feature.data.name, newValue);

    // Persist the user's chosen value on the feature object so that when the
    // plan tab is revisited (causing FeatureCard to remount), the slider
    // re-initialises to this value instead of falling back to coachValue.
    feature.hypotheticalValue = newValue;

    // Update the store
    planStore.set(plan);

    // SETUP: capture the raw entered value only — no propagation to dependents,
    // no delta tracking, no breakdowns. The user enters every value themselves
    // (including the computed ones); Done then locks this sample as the baseline.
    if (setupMode) {
      lastKnownValues[feature.data.name] = newValue;
      return;
    }

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
      // A real user edit reclaims a load-time suggested feature: it is now a
      // genuine user change (gets the outline; reads "you changed").
      if (suggestedAtLoad.delete(featureName)) suggestedAtLoad = suggestedAtLoad;

      // Track which side of the two-way pair is the input (last edited), so the
      // Revolving Balance hover knows whether its value was derived from a
      // Credit Utilization edit.
      if (featureName === 'revol_util') {
        revolUtilIsInput = true;
        // Commit this utilization as the util-driven free variable. The model has
        // already been updated (line above), so the live sample carries the new
        // value; userRevolDelta (the direct offset) is left untouched, so the two
        // contributors compose via the invariant instead of overwriting each other.
        revolInputUtil = Number(buildCurrentEngineState().revol_util) || 0;
      } else if (featureName === 'revol_bal') revolUtilIsInput = false;

      // Number of Derogatory Records is a propagation SINK (no outgoing edge) —
      // recompute its provenance split from the just-applied (clamped) value so a
      // later Bankruptcies change backs out the right contribution. Runs only on a
      // real edit (this block), never on the expand-replay, so a capped propagated
      // value can't corrupt the independent part.
      if (featureName === 'pub_rec') {
        derogIndependentPart = derogSubtract(newValue, currentBankruptcyLabel());
      }

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

      // Revolving Balance is NOT a leaf — just capture its signed manual delta so
      // a LATER Credit Utilization change sums with it. triggerPropagation below
      // derives utilization + DTI and refreshes the hovers.
      if (featureName === 'revol_bal') {
        captureManualRevolDelta();
      }

      // Debounce — only fire after user stops dragging (350ms of silence)
      if (propagationDebounceTimer) clearTimeout(propagationDebounceTimer);
      propagationDebounceTimer = setTimeout(async () => {
        propagationDebounceTimer = null;
        // DTI is a leaf: capture the manual delta and re-settle HERE (debounced),
        // never per drag increment. Running applyManualDtiEdit synchronously on each
        // increment re-settled DTI and pushed a featureValueOverrideStore update that
        // repositioned the slider thumb mid-drag — the jitter / lost grab cursor.
        // Deferring it to drag-end (350ms of silence) makes the DTI drag as smooth as
        // the other continuous features; the delta is captured at drag-end.
        if (featureName === 'dti') {
          applyManualDtiEdit();
        } else {
          // Await so the ideas recompute below always reads the SETTLED state, even
          // if propagation becomes truly async later.
          await triggerPropagation(featureName);
        }
        // Dynamic "Ideas to try": recompute the directional ideas against the now-
        // SETTLED state. This runs AFTER propagation completes (and is already
        // debounced with it at 350ms), so ideas evaluate the final values — never a
        // half-propagated transition — and never trigger the MILP solver.
        try { rebuildIdeas(); } catch (e) { /* ideas must never break the UI */ }
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
      // A FICO that was the coach's SUGGESTED input
      // returns to its load-snapshot value + seeded delta (re-engaged, "suggested",
      // no outline) instead of clearing to the profile penalty.
      const suggestedFico = !!(loadSnapshot && loadSnapshot.suggestedInputs.has('fico_score'));
      const ficoFeat = plan.features.find(ff => ff.data.name === 'fico_score');
      if (suggestedFico) {
        userFicoDelta = loadSnapshot.userFicoDelta;
        const loadVal = loadTimeSample[ficoFeat.featureID];
        plan.ebmLocal.updateFeature('fico_score', loadVal);
        if (ficoFeat) ficoFeat.hypotheticalValue = loadVal;
        lastKnownValues['fico_score'] = loadVal;
        modifiedFeatures.add('fico_score');
        suggestedAtLoad.add('fico_score');
        modifiedFeatures = modifiedFeatures;
        suggestedAtLoad = suggestedAtLoad;
        planStore.set(plan);
        featureValueOverrideStore.set({ fico_score: loadVal });
        setTimeout(() => featureValueOverrideStore.set({}), 400);
        ficoLinkCalculation = buildFicoBreakdown(applicantBaselineState, buildCurrentEngineState());
        dismissArrows();
        return;
      }
      userFicoDelta = 0;
      const settled = settleFico(0); // profile − active penalty, clamped
      const profileFico = applicantBaselineState.fico_score || 0;
      plan.ebmLocal.updateFeature('fico_score', settled);
      if (ficoFeat) ficoFeat.hypotheticalValue = settled;
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

    // Clear the two-way-pair input flag when the pair itself is reset. (The flag-on
    // suggested input side is re-established from loadSnapshot below.)
    if (unmodify.has('revol_util') || unmodify.has('revol_bal')) {
      revolUtilIsInput = false;
      // Restore the committed utilization input to the anchor — the pair is back at
      // its load-time (profile) values, so no util edit contributes any more. Keeps
      // the invariant revol_bal = (revolInputUtil/100·L) + userRevolDelta honest as
      // userRevolDelta is simultaneously restored to the coach offset below.
      revolInputUtil = revolAnchorUtil;
    }
    // Reset each counter's manual delta when that counter is restored.
    if (unmodify.has('open_acc')) userOpenDelta = 0;
    if (unmodify.has('total_acc')) userTotalDelta = 0;
    // Restore the Revolving Balance total delta to the coach's suggested offset
    // when the balance (or its two-way sibling) is restored — so the derivation
    // re-anchors to the suggested value, not the profile.
    if (unmodify.has('revol_bal')) userRevolDelta = coachRevolDelta;
    // Clear the DTI manual delta when DTI is restored (its sources are restored
    // to load-time alongside it, so no contribution should linger).
    if (unmodify.has('dti')) userDtiDelta = 0;
    // Restore the derogatory provenance split to its baseline ONLY when Number of
    // Derogatory Records itself is reset (its own edit is being undone). Resetting
    // Bankruptcies alone must NOT erase the user's independent (non-bankruptcy)
    // marks — the recompute below just backs the bankruptcy contribution out.
    if (unmodify.has('pub_rec')) {
      derogIndependentPart = derogSubtract(
        applicantBaselineState.pub_rec,
        applicantBaselineState.pub_rec_bankruptcies
      );
    }

    // ── 1b. Re-establish the LOAD SNAPSHOT ────────────────────────────────────
    // The steps above cleared the restored features' gate engagement and deltas
    // (which is correct for USER edits). But with the flag on, a restored feature
    // that was part of the coach's load-time suggestions must return to its
    // SUGGESTED state: re-engaged in the gate, its seeded delta restored, and its
    // "suggested" provenance re-marked — so the recompute below rebuilds the
    // propagated dependents rather than dropping them to the profile. No-op (and
    // therefore byte-identical to today) when loadSnapshot is null (flag off).
    if (loadSnapshot) {
      unmodify.forEach((name) => {
        if (loadSnapshot.suggestedInputs.has(name)) {
          modifiedFeatures.add(name);   // undo restoreToLoadTime's delete
          suggestedAtLoad.add(name);    // suggested, not user-caused
          // Restore this input's seeded delta (undo the clears above).
          if (name === 'revol_bal') { userRevolDelta = coachRevolDelta; revolUtilIsInput = loadSnapshot.revolUtilIsInput; }
          if (name === 'revol_util') revolUtilIsInput = loadSnapshot.revolUtilIsInput;
          if (name === 'open_acc') userOpenDelta = loadSnapshot.userOpenDelta;
          if (name === 'total_acc') userTotalDelta = loadSnapshot.userTotalDelta;
          if (name === 'dti') userDtiDelta = loadSnapshot.userDtiDelta;
        }
        // Folded dependents keep their "suggested" provenance (outline suppressed).
        if (loadSnapshot.suggestedAll.has(name)) suggestedAtLoad.add(name);
      });
      suggestedAtLoad = suggestedAtLoad;
    }

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
        userDtiDelta, userRevolDelta, derogIndependentPart
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

      // A recomputed dependent stays modified (outline stays) while at least one of
      // its sources is still modified — OR while it carries its OWN manual delta. A
      // manually-edited DTI persists its offset through the reset of any input
      // (mirroring how a manual FICO delta survives resetting a source), so it must
      // NOT un-modify just because its sources were reverted. Otherwise it un-modifies.
      const depHasOwnManual = dep === 'dti' && Math.abs(userDtiDelta) >= 0.005;
      if (depHasOwnManual || sourcesOf(dep).some(s => modifiedFeatures.has(s))) {
        modifiedFeatures.add(dep);
      } else {
        modifiedFeatures.delete(dep);
      }
    });
    modifiedFeatures = modifiedFeatures;

    // ── 2b. Snap fully-suggested dependents ───────────────────────────────────
    // A folded dependent whose sources are ALL still suggested (none user-edited)
    // belongs exactly at its load-snapshot value. Restore it directly from
    // loadTimeSample — overriding any small recompute drift (e.g. the two-way
    // revol_bal/util inverse re-applying the seeded delta) — and re-mark it
    // "suggested" (no user outline). Dependents that still have a user-edited
    // source keep their recomputed value. No-op when the flag is off.
    if (loadSnapshot) {
      plan.features.forEach((f) => {
        const dep = f.data.name;
        if (!loadSnapshot.suggestedAll.has(dep)) return;
        if (loadSnapshot.suggestedInputs.has(dep)) return; // inputs handled above
        // A manually-edited DTI keeps its OWN persistent delta through the reset of
        // any INPUT — it is not a fully-suggested dependent to snap back to load
        // time. Skip the snap so it retains its recomputed (propagated + manual)
        // value, mirroring a manual FICO delta surviving a source reset. Cleared
        // only when DTI ITSELF is reset (dti ∈ unmodify → userDtiDelta already 0).
        if (dep === 'dti' && Math.abs(userDtiDelta) >= 0.005) return;
        const anyUserSource = sourcesOf(dep).some(
          (s) => modifiedFeatures.has(s) && !suggestedAtLoad.has(s)
        );
        if (anyUserSource) return; // a user edit still affects it — keep recomputed
        const loadVal = loadTimeSample[f.featureID];
        if (loadVal === undefined) return;
        plan.ebmLocal.updateFeature(dep, loadVal);
        f.hypotheticalValue = loadVal;
        lastKnownValues[dep] = loadVal;
        overrides[dep] = loadVal;
        suggestedAtLoad.add(dep);
        modifiedFeatures.delete(dep);
      });
      modifiedFeatures = modifiedFeatures;
      suggestedAtLoad = suggestedAtLoad;
    }

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

  /**
   * Preview which OTHER features a reset of `featureName` will actually change,
   * for the reset-button hover warning. Mirrors handleFeatureReset's revert scope
   * EXACTLY — restore the feature + its direct sources to load-time, then recompute
   * their dependents — but WITHOUT mutating any state. Returns the DISPLAY names of
   * every feature whose value would visibly change, so the warning lists precisely
   * what clicking reset reverts (never more, never less). Empty when the reset
   * affects only the hovered feature.
   *
   * FICO's reset is special-cased in handleFeatureReset (it re-settles the persistent
   * penalty on the profile and never touches source/dependent cards), so a FICO reset
   * changes only its own value — we return [] to match that.
   */
  const resetRevertNames = (featureName) => {
    if (!plan || !loadTimeSample || !applicantBaselineState) return [];
    if (featureName === 'fico_score') return [];

    const dispName = (name) => {
      const f = plan.features.find((ff) => ff.data.name === name);
      return f ? f.data.description?.displayName || f.data.name : name;
    };

    // 1. The reset restores the feature + its direct sources to load-time.
    const unmodify = new Set([featureName, ...sourcesOf(featureName)]);

    // Simulated modified-set + deltas AFTER the restore — mirror the handler's clears
    // and the loadSnapshot re-establishment so the dependent recompute matches what
    // the reset actually produces.
    const simModified = new Set(modifiedFeatures);
    unmodify.forEach((n) => simModified.delete(n));
    let sOpen = userOpenDelta;
    let sTotal = userTotalDelta;
    let sRevol = userRevolDelta;
    let sDti = userDtiDelta;
    let sDerog = derogIndependentPart;
    const sFico = userFicoDelta; // the general path never touches the FICO delta
    if (unmodify.has('open_acc')) sOpen = 0;
    if (unmodify.has('total_acc')) sTotal = 0;
    if (unmodify.has('revol_bal')) sRevol = coachRevolDelta;
    if (unmodify.has('dti')) sDti = 0;
    if (unmodify.has('pub_rec'))
      sDerog = derogSubtract(
        applicantBaselineState.pub_rec,
        applicantBaselineState.pub_rec_bankruptcies
      );
    if (loadSnapshot) {
      unmodify.forEach((n) => {
        if (!loadSnapshot.suggestedInputs.has(n)) return;
        simModified.add(n); // a suggested input stays engaged after reset
        if (n === 'open_acc') sOpen = loadSnapshot.userOpenDelta;
        if (n === 'total_acc') sTotal = loadSnapshot.userTotalDelta;
        if (n === 'dti') sDti = loadSnapshot.userDtiDelta;
        if (n === 'revol_bal') sRevol = coachRevolDelta;
      });
    }

    const baseline = applicantBaselineState;
    // Post-restore engine state: current values, with the restored set at load-time.
    const post = buildEngineState((f) =>
      unmodify.has(f.data.name)
        ? loadTimeSample[f.featureID]
        : plan.ebmLocal.sample[f.featureID]
    );
    const cur = buildCurrentEngineState();
    const appliedMort = homeMortgageContribution(post.home_ownership);

    const changed = new Set();

    // Restored sources that actually move off their current value.
    unmodify.forEach((name) => {
      if (!engineValuesEqual(post[name], cur[name])) changed.add(name);
    });

    // Recompute the dependents of each restored source; any that land on a different
    // value than now are changed by the reset.
    unmodify.forEach((src) => {
      if (!featureHasOutgoingEdges(src)) return;
      const { state: next, log } = propagate(
        src, baseline, post, baseline,
        simModified, appliedMort, sOpen, sTotal, sFico, sDti, sRevol, sDerog
      );
      log
        .filter((l) => !l.note)
        .forEach((l) => {
          const dep = l.dependent;
          if (unmodify.has(dep)) return;
          if (!engineValuesEqual(next[dep], cur[dep])) changed.add(dep);
        });
    });

    changed.delete(featureName);
    return [...changed].map(dispName);
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

    // Provenance init (Reading A — subset): the applicant's baseline derogatory
    // count already includes their baseline bankruptcies, so the user's OWN
    // (non-bankruptcy) marks are the remainder. For applicant #126 both are 0 →
    // independent part = 0.
    derogIndependentPart = derogSubtract(
      applicantBaselineState.pub_rec,
      applicantBaselineState.pub_rec_bankruptcies
    );

    // RESET_TO_LOAD_STATE: capture the load-time snapshot once (the sample here
    // holds exactly what the cards display on first load, before any edit).
    if (!loadTimeSample) {
      loadTimeSample = plan.ebmLocal.sample.slice();
    }

    // Make the DTI breakdown available on hover before any edit (base row only).
    refreshDtiBreakdown();
  };

  /** Categorical CODE for a level LABEL (inverse of labelEncoder). */
  const codeFromLabel = (label, labelEncoder) => {
    if (!labelEncoder) return label;
    const entry = Object.entries(labelEncoder).find(([, lbl]) => lbl === label);
    return entry ? +entry[0] : label;
  };

  /**
   * Run the causal-propagation engine on the coach's suggested changes at load, so
   * dependent features show their propagated values immediately (as if the user had
   * manually entered the suggestions). Reuses the SAME engine + panel helpers — no
   * second propagation path.
   *
   * Provenance handling (folded, per design): each propagated dependent is written
   * into BOTH ebmLocal.sample AND coachSample, so it reads as "suggested" (never
   * "you changed") and isChangedByUser stays false. The coach's own INPUT
   * suggestions are left byte-exact. The suggested inputs are engaged in the
   * DTI/FICO gate (added to modifiedFeatures, so later edits keep their
   * contributions) but recorded in suggestedAtLoad so they carry NO user-modified
   * outline and never enter "Which features your changes affected" (that section
   * is left untouched here).
   */
  const propagateSuggestedChangesAtLoad = () => {
    // RE-BASELINE: the coach's suggestions are no longer applied to the cards or
    // the score — they surface only as text hints in "Ideas to try". So this
    // load-time fold is intentionally a no-op: nothing is applied, no provenance
    // deltas are seeded, and suggestedAtLoad stays empty (every card shows the
    // user's own baseline). The one baseline shift, loan->DTI, is folded into
    // curExample earlier (Coach.svelte / foldAppliedLoanIntoDti) and so is
    // already in ebmLocal; nothing else propagates at load.
    return;

    /* eslint-disable no-unreachable */
    if (!plan || !applicantBaselineState) return;

    const baseline = applicantBaselineState;
    // Derive the coach-suggested state from the IMMUTABLE raw CF, not the live
    // ebmLocal.sample. The fold mutates the sample/coachSample, so reading the live
    // sample on a re-mount would treat already-folded dependents (e.g. DTI) as
    // coach inputs and diverge from the initial load. Reading cfDataRaw makes this
    // pass deterministic and idempotent: same changed-inputs and same fold every
    // time, so switching away and back reproduces the initial-load result exactly.
    const suggested = plan.cfDataRaw
      ? buildEngineState((f) => plan.cfDataRaw[f.featureID])
      : buildCurrentEngineState(); // defensive fallback (older plan objects)

    // The coach's suggested INPUT changes (values differing from the profile).
    // From the raw CF, these are ONLY the features the coach changed directly —
    // propagated dependents are excluded and handled by the fold below.
    const changedInputs = plan.features
      .map((f) => f.data.name)
      .filter((name) => !engineValuesEqual(suggested[name], baseline[name]));
    if (changedInputs.length === 0) return;
    const changedSet = new Set(changedInputs);

    // Seed the panel's delta trackers from the suggested state, exactly as they
    // would be had the user entered those values — so later user edits keep the
    // suggested contributions engaged (consistent with the folded results).
    const mortDelta = Math.max(0, (suggested.mort_acc || 0) - (baseline.mort_acc || 0));
    userFicoDelta = changedSet.has('fico_score') ? (suggested.fico_score - baseline.fico_score) : 0;
    // The coach's suggested FICO delta is the whole of userFicoDelta at load (no
    // user edit yet); kept immutable so the hover can split coach vs. user later.
    coachFicoDelta = userFicoDelta;
    userDtiDelta = changedSet.has('dti') ? (suggested.dti - baseline.dti) : 0;
    userRevolDelta = changedSet.has('revol_bal') ? (suggested.revol_bal - baseline.revol_bal) : 0;
    userOpenDelta = changedSet.has('open_acc')
      ? ((suggested.open_acc || 0) - (baseline.open_acc || 0) - mortDelta) : 0;
    userTotalDelta = changedSet.has('total_acc')
      ? ((suggested.total_acc || 0) - (baseline.total_acc || 0) - userOpenDelta - mortDelta) : 0;
    appliedHomeMortgage = homeMortgageContribution(suggested.home_ownership);
    if (changedSet.has('revol_util')) revolUtilIsInput = true;
    else if (changedSet.has('revol_bal')) revolUtilIsInput = false;

    // Engage the suggested inputs in the gate, but flag them as suggested (not
    // user-caused): keeps their "suggested" provenance and suppresses the outline.
    changedInputs.forEach((name) => { modifiedFeatures.add(name); suggestedAtLoad.add(name); });

    // Run the engine for each suggested input with outgoing edges, accumulating so
    // dependents fed by multiple inputs (e.g. DTI) settle from the full state.
    let working = { ...suggested };
    changedInputs.forEach((name) => {
      if (!featureHasOutgoingEdges(name)) return;
      const { state } = propagate(
        name, baseline, working, baseline,
        modifiedFeatures, appliedHomeMortgage, userOpenDelta, userTotalDelta, userFicoDelta,
        userDtiDelta, userRevolDelta, derogIndependentPart
      );
      working = state;
    });

    // Fold the propagated DEPENDENTS (features the coach did not change directly,
    // whose value moved) into ebmLocal.sample AND coachSample → "suggested".
    const overrides = {};
    let foldedAny = false;
    plan.features.forEach((f) => {
      const name = f.data.name;
      if (changedSet.has(name)) return;                          // never touch inputs
      if (engineValuesEqual(working[name], suggested[name])) return; // no propagation
      const internal = displayToInternal(name, working[name]);
      plan.ebmLocal.updateFeature(name, internal);               // current value
      plan.coachSample[f.featureID] = internal;                  // → suggested provenance
      f.coachValue = f.isCont ? internal : codeFromLabel(internal, f.labelEncoder);
      f.myValue = f.coachValue;
      f.isChanged = engineValuesEqual(working[name], baseline[name]) ? 0 : 1;
      f.hypotheticalValue = internal;
      lastKnownValues[name] = internal;
      suggestedAtLoad.add(name);   // a propagated dependent is also not user-caused
      overrides[name] = internal;
      foldedAny = true;
    });

    modifiedFeatures = modifiedFeatures;
    suggestedAtLoad = suggestedAtLoad;

    // Freeze the load snapshot so a later reset can return to THIS state (values +
    // engagement + seeded deltas), not the profile baseline. suggestedInputs is
    // the coach's changed inputs (frozen); suggestedAll adds the folded dependents.
    loadSnapshot = {
      suggestedInputs: new Set(changedInputs),
      suggestedAll: new Set(suggestedAtLoad),
      userFicoDelta, userDtiDelta, userRevolDelta, userOpenDelta, userTotalDelta,
      appliedHomeMortgage, derogIndependentPart, revolUtilIsInput
    };

    if (foldedAny) {
      // Reset now restores to the propagated suggested state, not the raw cfData.
      loadTimeSample = plan.ebmLocal.sample.slice();
      planStore.set(plan);
      featureValueOverrideStore.set(overrides);
      setTimeout(() => featureValueOverrideStore.set({}), 400);
      refreshDtiBreakdown();
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
   * Build the DTI hover breakdown. The hover MIRRORS the engine's DTI value
   * (parts.newDti) — it never re-derives DTI with its own formula. In particular
   * it does NOT invent a monthly payment for the applied-for loan: a loan line
   * appears ONLY when the loan was actually changed (parts.loanEngaged), because
   * the model scores DTI as a value and the engine (via the DTI_USER_EDITS_ONLY
   * gate) only folds a loan payment into DTI when the loan itself changed. Same
   * for the revolving-balance line. The displayed final DTI equals the engine's
   * DTI for the plan, by construction — one source of truth, no divergence.
   *
   * @param {object} parts     computeDtiParts() output (the engine's own values)
   * @param {object} baseline  frozen applicant profile (annual_inc, dti)
   * @param {number} scoredDti the ACTUAL DTI the engine wrote to the sample and
   *   scored (the DTI card's value). The hover's final DTI IS this value — the one
   *   source of truth — so it always equals the displayed/scored DTI, even for the
   *   two-way revolving pair where a fresh computeDtiParts recompute would drift.
   */
  const formatDtiBreakdown = (parts, baseline, scoredDti) => {
    const money = (n) => '$' + Math.round(n).toLocaleString();
    const pct = (n) => Number(n).toFixed(2);
    const signedMoney = (n) =>
      (n < 0 ? '−$' : '+$') + Math.abs(Math.round(n)).toLocaleString();
    // The engine's scored DTI is authoritative; fall back to parts.newDti only if a
    // caller omits it.
    const finalDti = scoredDti != null ? scoredDti : parts.newDti;

    // ── Two-source DTI model (mirrors FICO) ──────────────────────────────────────
    // Source 1 — propagated DTI: what the current inputs actually produce
    // (debt ÷ income, all suggested/propagated changes applied). A real, recomputable
    // number, NEVER back-justified from the displayed value.
    // Source 2 — manual delta: the user's manual DTI override, a FIXED offset held
    // constant as inputs change (engine: newDti = computedDti + dtiManualDelta).
    // Displayed DTI = propagated + manual == the scored value (display == score).
    // The delta shown is derived from the ROUNDED propagated/displayed values so the
    // equation "propagated + delta = displayed" always adds up exactly.
    const propagatedDtiRaw = parts.computedDti || 0;
    const propShown = Number(propagatedDtiRaw.toFixed(2));
    const dispShown = Number(finalDti.toFixed(2));
    const manShown = Number((dispShown - propShown).toFixed(2));
    const hasManualDti = Math.abs(parts.dtiManualDelta || 0) >= 0.005;

    const origMonthlyIncomeRaw = (baseline?.annual_inc || 0) / 12; // profile income
    const currentDti = baseline?.dti || 0;                         // profile DTI %
    // Current monthly debt is the engine's baseDebt (profile income × profile DTI).
    const currentMonthlyDebtRaw = parts.baseDebt || 0;

    // Income the engine used (reflects an Annual Income edit via the gate).
    const newMonthlyIncomeRaw = parts.monthlyIncome || 0;

    const origMonthlyIncome = Math.round(origMonthlyIncomeRaw);
    const newMonthlyIncome = Math.round(newMonthlyIncomeRaw);
    const incomeChanged = newMonthlyIncome !== origMonthlyIncome;
    const currentMonthlyDebt = Math.round(currentMonthlyDebtRaw);

    // Loan / revolving contributions to monthly debt — shown ONLY when the engine
    // actually applied them (the loan/revolving was changed). This is the fix:
    // for a plan that leaves the loan unchanged, no loan payment is added.
    // Model B: the loan contributes the CHANGE in its monthly payment vs. the
    // original loan (parts.loanPaymentDelta), which is negative when the loan is
    // lowered. Show the loan row only when that change is non-trivial, so setting
    // the loan back to its original value shows nothing and leaves DTI unmoved.
    const loanChanged =
      !!parts.loanEngaged && Math.abs(parts.loanPaymentDelta || 0) >= 0.5;
    const loanIncreased = (parts.loanPaymentDelta || 0) > 0;
    const revolChanged = !!parts.revolEngaged && Math.abs(parts.revolDelta || 0) >= 0.5;
    const revolDeltaRaw = revolChanged ? (parts.revolDelta || 0) : 0;
    const debtChanged = loanChanged || revolChanged;
    const denomIncome = incomeChanged ? newMonthlyIncome : origMonthlyIncome;

    // The "New total monthly debt" line is shown as a full equation:
    //   current debt  ±  loan-payment change  ±  revolving change  =  new total
    // built from integer-dollar components so the shown amounts add up EXACTLY to
    // the total. The loan/revolving terms are the SIGNED deltas the engine applied
    // (Model B); a manual DTI edit (rare) is folded in as its dollar equivalent so
    // the total still ties to the scored DTI.
    const loanDeltaInt = loanChanged ? Math.round(parts.loanPaymentDelta || 0) : 0;
    const revolDeltaInt = revolChanged ? Math.round(revolDeltaRaw) : 0;
    // The manual DTI edit is NEVER folded into the debt equation as an invented
    // dollar figure — it is a separate percentage-point delta shown on its own line
    // (two-source model). The debt equation reflects ONLY the propagated inputs.
    const debtTerms = [currentMonthlyDebt];
    if (loanChanged) debtTerms.push(loanDeltaInt);
    if (revolChanged) debtTerms.push(revolDeltaInt);
    // When the loan/revolving changed, the total is the exact component sum (so the
    // equation reconciles); otherwise the debt implied by the PROPAGATED DTI (never
    // the displayed value), so the "debt ÷ income = DTI" line chains to the
    // propagated part and the manual delta is added separately below.
    const totalDebt = debtChanged
      ? debtTerms.reduce((s, t) => s + t, 0)
      : Math.round((propagatedDtiRaw / 100) * denomIncome);
    // The addition expression, e.g. "$1,041 − $231 + $40" (first term unsigned).
    const debtEquation = debtTerms
      .map((t, i) =>
        i === 0
          ? '$' + Math.abs(t).toLocaleString()
          : (t < 0 ? ' − $' : ' + $') + Math.abs(t).toLocaleString()
      )
      .join('');

    const aprFraction = aprForPurpose(parts.loanPurpose);

    // ── Two-phase, all-contributors layout ─────────────────────────────────────
    // Phase 1 builds the loan-inclusive current DTI transparently (pre-loan debt +
    // the applied-for loan's payment); Phase 2 shows every contributor that actually
    // changed. Provenance-neutral. Composes with Model B: the loan-payment line in
    // Phase 2 shows the CURRENT amortized payment (from the changed loan/term/purpose),
    // and the final debt rebuilds from components — no double-count. Requires the
    // applied-for loan to be present; when there is no loan payment to fold (a
    // degenerate case that does not occur for real applications, where loan_amnt > 0)
    // the template falls back to the plain equation layout.
    const foldedLayout = (parts.originalLoanPayment || 0) > 0.5;
    // Integer components chosen so Phase 1 chains EXACTLY: existing + loan = current.
    const appliedLoanInt = Math.round(parts.originalLoanPayment || 0);
    const existingDebtInt = currentMonthlyDebt - appliedLoanInt; // pre-loan debt
    const baseDtiExcl =
      origMonthlyIncomeRaw > 0 ? (existingDebtInt / origMonthlyIncomeRaw) * 100 : 0;
    // Final debt = existing (constant) + CURRENT loan payment (new if the loan/term/
    // purpose changed, else the applied-for payment) + revolving change [+ manual].
    const currentLoanPaymentInt = loanChanged
      ? Math.round(parts.newLoanPayment || 0)
      : appliedLoanInt;
    const foldRevolInt = revolChanged ? Math.round(revolDeltaRaw) : 0;
    // The manual DTI edit is NOT folded into the debt (no invented dollar figure) —
    // the propagated debt reflects inputs only; the manual delta is a separate line.
    const foldTerms = [existingDebtInt, currentLoanPaymentInt];
    if (revolChanged) foldTerms.push(foldRevolInt);
    const foldNewTotalDebt = foldTerms.reduce((s, t) => s + t, 0);
    let foldDebtExpr = money(existingDebtInt) + ' + ' + money(currentLoanPaymentInt);
    if (revolChanged)
      foldDebtExpr += (foldRevolInt < 0 ? ' − ' : ' + ') + money(Math.abs(foldRevolInt));
    const loanTermsShort =
      `${parts.paymentPeriod || 0} months payment period, ${pct(aprFraction * 100)}% APR, ` +
      `loan purpose: ${String(parts.loanPurpose || '').replace(/_/g, ' ')}`;

    // Card value display (fold-on only): the LEFT of the arrow shows the RAW profile
    // DTI the applicant entered (pre-fold), not the loan-folded baseline — recovered
    // by subtracting the applied-for loan's DTI contribution from the folded value.
    // The RIGHT stays the last updated DTI (curValue). Display-only; the feature's
    // originalValue stays folded for propagation/scoring.
    const loanDtiContribution =
      origMonthlyIncomeRaw > 0 ? ((parts.originalLoanPayment || 0) / origMonthlyIncomeRaw) * 100 : 0;
    const rawProfileDti = currentDti - loanDtiContribution;
    // Delta on the arrow = updated (scored) DTI − raw profile DTI.
    const rawProfileDelta = finalDti - rawProfileDti;

    return {
      type: 'dti',
      // Two-phase folded layout (fold-on) vs. the equation layout (fold-off).
      foldedLayout,
      // DTI card value display (fold-on): raw profile DTI on the left, updated DTI on
      // the right, and the change between them on the arrow.
      overrideOriginalDisplay: foldedLayout,
      originalDisplayValue: pct(rawProfileDti),
      originalDisplayDelta: (rawProfileDelta >= 0 ? '+' : '−') + pct(Math.abs(rawProfileDelta)),
      p1ExistingDebt: money(existingDebtInt),
      p1BaseDtiExcl: pct(baseDtiExcl),
      p1LoanAmount: money(baseline?.loan_amnt || 0),     // applied-for loan amount
      p1LoanPayment: money(appliedLoanInt),
      p1CurrentDebt: money(currentMonthlyDebt),
      p1CurrentDti: pct(currentDti),
      loanTermsShort,
      p2LoanAmount: money(parts.loanAmount || 0),         // the new loan amount
      p2NewLoanPayment: money(Math.round(parts.newLoanPayment || 0)),
      p2OldLoanPayment: money(appliedLoanInt),
      p2RevolToDebt: signedMoney(foldRevolInt),
      foldDebtExpr,
      foldNewTotalDebt: money(foldNewTotalDebt),
      annualIncome: money(baseline?.annual_inc || 0),
      monthlyIncome: '$' + origMonthlyIncome.toLocaleString(),
      currentDti: pct(currentDti),
      currentMonthlyDebt: '$' + currentMonthlyDebt.toLocaleString(),
      // The baseline debt above already includes the applied-for loan's payment —
      // surface it so the higher starting DTI is explained rather than appearing
      // unattributed.
      appliedLoanFolded: (parts.originalLoanPayment || 0) > 0.5,
      appliedLoanPayment: money(parts.originalLoanPayment || 0),
      incomeChanged,
      newAnnualIncome: money(newMonthlyIncomeRaw * 12),
      newMonthlyIncome: '$' + newMonthlyIncome.toLocaleString(),
      loanChanged,
      loanIncreased,
      loanAmount: money(parts.loanAmount || 0),
      originalLoanPayment: money(parts.originalLoanPayment || 0),
      newLoanPayment: money(parts.newLoanPayment || 0),
      loanPaymentDelta: signedMoney(parts.loanPaymentDelta || 0),
      paymentPeriod: parts.paymentPeriod || 0,
      aprPercent: pct(aprFraction * 100),
      loanPurpose: String(parts.loanPurpose || '').replace(/_/g, ' '),
      revolChanged,
      revolDelta: signedMoney(revolDeltaRaw),
      debtChanged,
      debtEquation,
      totalDebt: '$' + totalDebt.toLocaleString(),
      finalIncome: '$' + denomIncome.toLocaleString(),
      // Two-source manual-edit model (mirrors FICO). When the user manually edited
      // DTI, the build-up chains to the PROPAGATED DTI, then a "Your manual change"
      // line adds the fixed delta, then "New DTI: propagated + delta = displayed".
      // No manual edit → hasManualDti false → normal build-up only.
      hasManualDti,
      propagatedDtiPct: propShown.toFixed(2),
      manualDtiDelta: (manShown >= 0 ? '+' : '−') + Math.abs(manShown).toFixed(2),
      manualDtiSign: manShown >= 0 ? '+' : '−',
      manualDtiDeltaMag: Math.abs(manShown).toFixed(2),
      displayedDtiPct: dispShown.toFixed(2),
      // The final DTI is the ENGINE's scored value — the single source of truth. The
      // hover reflects it; it does not compute its own.
      newDTI: pct(finalDti)
    };
  };

  /**
   * Provenance of a directly-set (non-dependent) feature — used to decide whether
   * its value-breakdown box appears and how its change is labeled:
   *   suggestedOnly: the coach suggested a value and the user has NOT edited it
   *                  (still marked suggested at load) → box hidden for such features.
   *   userEdited:    the user directly edited it (a real edit reclaims it out of
   *                  suggestedAtLoad) → box shown, labeled "Your change".
   * A feature that is BOTH (coach-suggested then user-edited) is userEdited here; the
   * coach's part is recovered from the feature's own coach-delta tracker.
   */
  const featureProvenance = (name) => ({
    suggestedOnly: suggestedAtLoad.has(name),
    userEdited: modifiedFeatures.has(name) && !suggestedAtLoad.has(name)
  });

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

    // Provenance split (FICO is a directly-set / non-dependent feature). userFicoDelta
    // is the TOTAL delta vs. profile (coach suggestion + any later user edit);
    // coachFicoDelta is the coach's part; the remainder is the user's own change.
    const { userEdited: ficoUserEdited } = featureProvenance('fico_score');
    const ficoDeltaTotal = modifiedFeatures.has('fico_score') ? Math.round(userFicoDelta) : 0;
    const ficoCoachDelta = Math.round(coachFicoDelta || 0);
    const ficoUserOwnDelta = ficoDeltaTotal - ficoCoachDelta;

    // Non-dependent rule: the breakdown box appears for a PENALTY (propagated from
    // account/inquiry edits) or a USER edit — NEVER for a coach suggestion alone.
    // A coach-suggested-only FICO with no penalty shows no box (the card still shows
    // the suggested value). This is the fix for "Adjusted by you: +8" on a suggestion.
    if (hardInquiries === 0 && !ficoUserEdited) return { type: 'fico', engaged: false };

    const profileFICO = Math.round(baseline.fico_score || 0);
    const rawPenalty = hardInquiries * 4;
    const raw = profileFICO + ficoDeltaTotal - rawPenalty;
    // 662 is the lowest FICO the model bins; the score can never go below it.
    const isClamped = raw < FICO_FLOOR;
    const newFICO = Math.max(FICO_FLOOR, raw);

    // Distinct rows for the coach's suggested change and the user's own change, so a
    // coach suggestion is never labeled as "your change". Shown only when nonzero, so
    // the common penalty-only case reduces to exactly "profile − totalDrop".
    const showSuggestedRow = ficoCoachDelta !== 0;
    const showYourRow = ficoUserEdited && ficoUserOwnDelta !== 0;

    // Chaining arithmetic for the final line, reconciling EXACTLY to the raw
    // (pre-floor) score: profile [± suggested] [± your] − totalDrop. In the common
    // penalty-only case this is simply "profile − totalDrop". `raw` equals masterFico
    // pre-clamp, so this chains to the true scored value (display == score); when it
    // dips below the floor the template appends the "capped at 662" note and the
    // scored value is FICO_FLOOR.
    let ficoChainExpr = String(profileFICO);
    if (showSuggestedRow)
      ficoChainExpr += (ficoCoachDelta < 0 ? ' − ' : ' + ') + Math.abs(ficoCoachDelta);
    if (showYourRow)
      ficoChainExpr += (ficoUserOwnDelta < 0 ? ' − ' : ' + ') + Math.abs(ficoUserOwnDelta);
    if (rawPenalty > 0) ficoChainExpr += ' − ' + rawPenalty;

    return {
      type: 'fico',
      engaged: true,
      profileFICO: String(profileFICO),
      showSuggestedRow,
      suggestedDelta: (ficoCoachDelta < 0 ? '−' : '+') + Math.abs(ficoCoachDelta),
      showYourRow,
      yourDelta: (ficoUserOwnDelta < 0 ? '−' : '+') + Math.abs(ficoUserOwnDelta),
      showPenaltyRow: hardInquiries > 0,
      // count = penalty-item count: new credit inquiries + new open accounts (beyond
      // the mortgage's own +1) + new mortgages. Identical to the model's
      // params.hardInquiries, so 4 × count is EXACTLY the penalty masterFico applied.
      count: String(hardInquiries),
      totalDrop: String(rawPenalty),
      ficoChainExpr,
      // Raw (pre-floor) score shown in the equation. The cap note (isCapped) fires
      // strictly when it is below the model's 662 floor; the scored value is then 662.
      rawNewScore: String(raw),
      isCapped: isClamped,
      scoredFICO: String(newFICO)
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
    // Provenance rule for the two-way pair: when Utilization is the INPUT it is a
    // directly-set (non-dependent) feature → show only on a USER edit (a coach
    // suggestion alone shows nothing). When it is the DERIVED side (Balance is the
    // input) it is a dependent → always show, so the propagation is explained.
    const pairEngaged =
      modifiedFeatures.has('revol_util') || modifiedFeatures.has('revol_bal');
    const engaged = revolUtilIsInput
      ? featureProvenance('revol_util').userEdited
      : pairEngaged;
    if (!engaged) return { type: 'revol_util', engaged: false };

    const money = (n) => '$' + Math.round(n).toLocaleString();
    const pct = (n) => Number(n).toFixed(2);
    const creditLimit = creditLimitFromBaseline(baseline); // null when indeterminate
    const currentUtil = Number(baseline.revol_util) || 0;
    const newUtil = Number(state.revol_util) || 0;
    // True (uncapped) utilization the new balance implies against the recovered
    // limit. The model clamps revol_util to [0, 100] (MODEL_BOUNDS), so `newUtil`
    // can sit at the 100% cap while balance ÷ limit is actually higher. Surface the
    // real figure in the equation line, flagged so the template can note the cap.
    const rawUtil =
      creditLimit ? (Number(state.revol_bal || 0) / creditLimit) * 100 : newUtil;
    const utilCapped = rawUtil > 100 + 1e-9;
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
      // Equation-line figure: the true ratio (rounded) when it exceeds the cap,
      // otherwise the normal capped value. `utilCapped` drives the "capped at 100%"
      // note. Everything else keeps using the capped `newUtilization`.
      newUtilizationRaw: utilCapped ? String(Math.round(rawUtil)) : pct(newUtil),
      utilCapped,
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
    // Provenance rule: when Balance is the INPUT (revolUtilIsInput === false) it is a
    // directly-set (non-dependent) feature → show only on a USER edit. When it is the
    // DERIVED side (Utilization is the input) it is a dependent → always show.
    const pairEngaged =
      modifiedFeatures.has('revol_bal') || modifiedFeatures.has('revol_util');
    const engaged = revolUtilIsInput
      ? pairEngaged
      : featureProvenance('revol_bal').userEdited;
    if (!engaged) return { type: 'revol_bal', engaged: false };

    const money = (n) => '$' + Math.round(n).toLocaleString();
    const signedMoney = (n) =>
      (n < 0 ? '−$' : '+$') + Math.round(Math.abs(n)).toLocaleString();
    const profileBal = baseline.revol_bal || 0;
    const creditLimit = creditLimitFromBaseline(baseline); // null when indeterminate
    // Anchor the base to the SUGGESTED (displayed) balance, so a utilization edit
    // chains from the plan the user is viewing, not the profile.
    const suggestedBal = revolAnchorBal;
    const hasSuggestedBase = Math.abs(revolAnchorBal - profileBal) > 0.5;
    // SINGLE SOURCE OF TRUTH for the breakdown. The three lines are derived so they
    // ALWAYS sum to the card's scored balance (`state.revol_bal`), in every edit
    // order and even when the engine clamps the balance:
    //   • base        = revolAnchorBal (the load/profile balance)
    //   • utilDriven  = the balance moved by the COMMITTED utilization input
    //                   (revolInputUtil), NOT the live `state.revol_util` (which the
    //                   engine recomputes to the balance's full implied util after a
    //                   direct balance edit) and NOT gated on `revolUtilIsInput`.
    //   • direct      = the RESIDUAL, card − base − utilDriven — whatever the user's
    //                   direct balance edits account for beyond the util-driven part.
    // Deriving `direct` from the card's own value (instead of the separately-captured
    // userRevolDelta) is the durable fix: the util-driven contribution can never be
    // dropped, and the two contributions can never clobber each other or disagree with
    // the card — they are two views of the same ground-truth balance. This is the same
    // single-anchor derivation that fixed the plan-switch idempotency bug.
    const utilDriven =
      creditLimit !== null
        ? ((revolInputUtil - revolAnchorUtil) / 100) * creditLimit
        : 0;
    const newBalance = state.revol_bal || 0;              // card / ground truth
    const manualDelta = newBalance - suggestedBal - utilDriven; // direct edit (residual)
    const showManualRow = Math.abs(manualDelta) > 0.5;
    const showUtilRow = Math.abs(utilDriven) > 0.5;

    // Assemble the total as an addition of the shown contributions, in causal order
    // base → utilization-driven → your direct edit, e.g. "$11,001 − $5,281 − $3,720",
    // summing to newBalance (the card's scored balance).
    const pieces = [money(suggestedBal)];
    if (showUtilRow) pieces.push((utilDriven < 0 ? '− ' : '+ ') + money(Math.abs(utilDriven)));
    if (showManualRow) pieces.push((manualDelta < 0 ? '− ' : '+ ') + money(Math.abs(manualDelta)));

    return {
      type: 'revol_bal',
      engaged: true,
      baseIsSuggested: hasSuggestedBase,
      baseBalance: money(suggestedBal),
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
    // SETUP: no propagation or loan→DTI fold is shown during first-time entry, so
    // leave the breakdown blocks null — the DTI card shows a plain value with no
    // fold arrow until the user presses "Done with Setup".
    if (setupMode) return;
    const current = buildCurrentEngineState();
    const params = computeParams(
      applicantBaselineState, current, modifiedFeatures, userFicoDelta, userDtiDelta, userRevolDelta
    );
    dtiLinkCalculation = formatDtiBreakdown(computeDtiParts(current, params), applicantBaselineState, current.dti);
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

    // DTI breakdown — the loan-centric narrative (profile debt + applied loan).
    dtiLinkCalculation = formatDtiBreakdown(computeDtiParts(next, params), baseline, next.dti);

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
   * Source-value label for a row: the transition from the applicant's profile value
   * to the current value (e.g. "$61,000 → $90,000" or "Rent → Mortgage"), for both
   * continuous and categorical sources. Falls back to the single current value when
   * there is no distinct "before".
   */
  const formatSourceValue = (sourceName, rawAfter) => {
    const before = formatEffectValue(sourceName, applicantBaselineState?.[sourceName]);
    const after = formatEffectValue(sourceName, rawAfter);
    return before && before !== after ? `${before} → ${after}` : after;
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

    return {
      depName,
      depDisplayName: depDisplay,
      beforeDisplay,
      afterDisplay,
      // How this dependent moved ("raised" / "lowered" / "changed"), for the
      // combined per-row hover sentence built in recordChangeEffects.
      depVerb: valueVerb,
      helps,
      contributionDelta: delta
    };
  };

  /**
   * Record (or refresh) the affected-features row for one source change.
   * Collapses by source: the newest change of a source replaces its prior row and
   * moves to the top (newest first). An empty `effects` array records a
   * "no effect" row (the user changed this feature but it propagated to nothing).
   */
  const recordChangeEffects = (sourceName, sourceValueRaw, effects, tooltipPrefixOverride = null, showApprovalChange = true) => {
    const sourceDisplay = DISPLAY_NAMES[sourceName] || sourceName;

    // Source-change direction + amounts for the hover sentence.
    const srcBefore = applicantBaselineState?.[sourceName];
    const srcBeforeDisplay = formatEffectValue(sourceName, srcBefore);
    const srcAfterDisplay = formatEffectValue(sourceName, sourceValueRaw);
    const srcNumeric =
      typeof srcBefore === 'number' && typeof sourceValueRaw === 'number';
    const sourceVerb = srcNumeric
      ? sourceValueRaw > srcBefore
        ? 'Increasing'
        : sourceValueRaw < srcBefore
        ? 'Lowering'
        : 'Changing'
      : 'Changing';
    const srcChanged = srcBeforeDisplay !== srcAfterDisplay;
    const sourcePart = srcChanged
      ? `${sourceVerb} the ${sourceDisplay.toLowerCase()} from ${srcBeforeDisplay} to ${srcAfterDisplay}`
      : `${sourceVerb} the ${sourceDisplay.toLowerCase()}`;

    // Store only the CAUSAL body of the sentence (source change + every dependent it
    // moved, inline) — a caller may override just this body (e.g. the applied-loan
    // baseline fold). The approval-score clause is NOT baked here: ChangeEffects.svelte
    // appends it at render time from the LIVE current score, so every row's "new"
    // score always equals the score readout (they read the same plan store). Baking it
    // here froze each row's score at edit time, so after a later edit the readout moved
    // on while older rows kept a stale score — the mismatch this fixes.
    // `showApprovalChange` is false when there is no score clause (the loan fold and
    // the no-effect rows).
    let tooltipBody;
    let showApproval = showApprovalChange;
    if (!effects || effects.length === 0) {
      tooltipBody = `Changing the ${sourceDisplay.toLowerCase()} didn't change any other feature`;
      showApproval = false;
    } else {
      const depsPart = effects
        .map(
          (e) =>
            `${e.depVerb} the ${e.depDisplayName.toLowerCase()} from ${e.beforeDisplay} to ${e.afterDisplay}`
        )
        .join(', ');
      tooltipBody = tooltipPrefixOverride || `${sourcePart}, ${depsPart}`;
    }

    const event = {
      sourceName,
      sourceDisplayName: sourceDisplay,
      sourceValueDisplay: formatSourceValue(sourceName, sourceValueRaw),
      effects,
      tooltipBody,
      showApproval
    };
    changeEffectsStore.update((list) => [
      event,
      ...list.filter((ev) => ev.sourceName !== sourceName)
    ]);
  };

  /**
   * Record the one baseline shift — the applied-for loan folded into DTI — as an
   * affected-features row at load (after "Done with Setup"). The applied loan
   * raised the borrower's DTI from their raw profile value to the loan-included
   * value; this shows that as "Loan Amount → DTI" in the panel.
   */
  const recordLoanFoldEffect = () => {
    if (!plan || !applicantBaselineState) return;
    const featureNames = [];
    plan.features.forEach((f) => {
      featureNames[f.featureID] = f.data.name;
    });
    // DTI points contributed by the applied-for loan (from loan/income/purpose/term).
    const contribution = appliedLoanDtiContribution(plan.ebmLocal.sample, featureNames);
    if (!contribution || contribution <= 0.05) return; // negligible / no loan
    const foldedDti = applicantBaselineState.dti;
    const rawDti = foldedDti - contribution;
    const effect = buildEffectEntry('loan_amnt', 'dti', rawDti, foldedDti);
    // Custom sentence PREFIX for the applied-loan baseline fold: the loan itself
    // didn't change, it ADDED new debt, so phrase it that way rather than
    // "Changing …". The approval-score clause is suppressed for this fold row
    // (showApprovalChange = false) — it describes the baseline, not a user edit.
    const foldPrefix =
      `The loan amount added new debt and raised the debt to income ratio ` +
      `from ${effect.beforeDisplay} to ${effect.afterDisplay}`;
    recordChangeEffects(
      'loan_amnt',
      applicantBaselineState.loan_amnt,
      [effect],
      foldPrefix,
      false
    );
  };

  /**
   * Populate the affected-features section at LOAD with the coach's suggested-change
   * ripples — one source→effect row per suggested INPUT that actually propagates to a
   * dependent. Applies the suggested inputs sequentially from the folded baseline
   * (as if the user had entered the suggestions one by one), running the SAME engine
   * + seeded deltas the load-fold used, so the ripple values match the displayed /
   * scored values (and the DTI hover's propagated result). A suggested input that
   * propagates to nothing gets NO row (no invented effects). Provenance is tagged
   * "suggested" via recordChangeEffects's shared derivation.
   */
  const recordSuggestedChangeEffects = () => {
    if (!plan || !applicantBaselineState) return;
    const baseline = applicantBaselineState;
    const suggested = plan.cfDataRaw
      ? buildEngineState((f) => plan.cfDataRaw[f.featureID])
      : buildCurrentEngineState();
    const changedInputs = plan.features
      .map((f) => f.data.name)
      .filter((name) => !engineValuesEqual(suggested[name], baseline[name]));
    if (changedInputs.length === 0) return;

    let working = { ...baseline };
    changedInputs.forEach((name) => {
      working = { ...working, [name]: suggested[name] };
      if (!featureHasOutgoingEdges(name)) return; // leaf suggestion → no ripple, no row
      const { state: next, log } = propagate(
        name, baseline, working, baseline,
        modifiedFeatures, appliedHomeMortgage, userOpenDelta, userTotalDelta, userFicoDelta,
        userDtiDelta, userRevolDelta, derogIndependentPart
      );
      const effectEntries = [];
      const deps = [...new Set(log.filter((l) => !l.note).map((l) => l.dependent))];
      deps.forEach((dep) => {
        const before = working[dep];
        const after = next[dep];
        const changed =
          typeof after === 'number' && typeof before === 'number'
            ? Math.abs(after - before) > 1e-6
            : after !== before;
        if (!changed) return;
        effectEntries.push(buildEffectEntry(name, dep, before, after));
      });
      working = next; // accumulate propagated dependents for the next input
      // Only record a row when this suggested input actually rippled somewhere.
      if (effectEntries.length > 0) {
        recordChangeEffects(name, working[name], effectEntries);
      }
    });
  };

  // ── "Ideas to try" — isolated speculative what-if evaluation (Part 1) ────────
  // Side-effect-free: perturbs a COPY of the current state, runs the SAME DC1
  // propagation used for real edits, scores a CLONED sample, and returns only the
  // propagated approval-score delta. It never mutates the plan, feature values,
  // current score, the "What's driving this score" panel, or the "Effects of your
  // changes" band — nothing about a test step appears in the UI or user state.

  let ideasDebounceTimer = null;

  /** Display-unit [min, max] range for a numeric feature (for step sizing). */
  const displayRange = (name) => {
    if (MODEL_BOUNDS[name]) return MODEL_BOUNDS[name];
    const f = plan.features.find((ff) => ff.data.name === name);
    const bins = (f?.data?.binEdge || []).filter(Number.isFinite);
    if (bins.length >= 2) {
      let lo = bins[0];
      let hi = bins[bins.length - 1];
      if (f.transform === 'log10') { lo = Math.pow(10, lo); hi = Math.pow(10, hi); }
      return [lo, hi];
    }
    return null;
  };

  const engineValuesEqual = (a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
    return a === b;
  };

  /**
   * Propagated approval-score effect (Δprobability) of a hypothetical step on
   * `candidateName`. `isCont` picks the perturbation kind:
   *   - continuous: `perturb` is the perturbed DISPLAY value.
   *   - categorical: `perturb` is an alternative level LABEL.
   * Fully isolated — see the section comment above.
   */
  const speculativeApprovalDelta = (candidateName, isCont, perturb) => {
    const baseline = applicantBaselineState;
    const current = buildCurrentEngineState();

    // Engine-display value of the perturbation (term → months number).
    const engineVal = isCont
      ? perturb
      : candidateName === 'term'
      ? parseTermMonths(perturb)
      : perturb;

    const perturbed = { ...current };
    perturbed[candidateName] = engineVal;

    const specModified = new Set(modifiedFeatures);
    specModified.add(candidateName);

    // Same single DC1 propagation call used for real edits (pure — clones input).
    let next = perturbed;
    if (featureHasOutgoingEdges(candidateName)) {
      const res = propagate(
        candidateName, baseline, perturbed, baseline,
        specModified, appliedHomeMortgage, userOpenDelta, userTotalDelta,
        userFicoDelta, userDtiDelta, userRevolDelta, derogIndependentPart
      );
      next = res.state;
    }

    // Score a CLONED sample — never touch the real ebmLocal / store.
    const sample = plan.ebmLocal.sample.slice();
    const cf = plan.features.find((f) => f.data.name === candidateName);
    sample[cf.featureID] = isCont ? toInternalValue(perturb, candidateName) : perturb;
    plan.features.forEach((f) => {
      const name = f.data.name;
      if (name === candidateName) return;
      if (next[name] !== undefined && !engineValuesEqual(next[name], current[name])) {
        sample[f.featureID] = displayToInternal(name, next[name]);
      }
    });

    const scores = plan.ebmLocal.countScore(sample);
    const logOdds =
      Object.values(scores).reduce((a, b) => a + b, 0) + plan.ebmLocal.intercept;
    return sigmoid(logOdds) - sigmoid(plan.ebmLocal.predScore);
  };

  /**
   * Evaluate one candidate through Gates 2–4. Returns { direction, gain } for a
   * surviving feature, or null if suppressed.
   */
  const evaluateIdea = (feature) => {
    const name = feature.data.name;

    if (feature.isCont) {
      const range = displayRange(name);
      if (!range) return null;
      const [lo, hi] = range;
      const cur = buildCurrentEngineState()[name];
      const clamp = (v) => Math.max(lo, Math.min(hi, v));
      // Step magnitude: a fraction of the current value (scale-invariant), with a
      // range-fraction fallback for values sitting at ~0.
      const stepMag = (frac) => {
        const byValue = frac * Math.abs(cur);
        return byValue > 1e-9 ? byValue : frac * (hi - lo);
      };

      const evalStep = (frac) => {
        const mag = stepMag(frac);
        if (!(mag > 0)) return { dir: 'raise', gain: 0 };
        const up = speculativeApprovalDelta(name, true, clamp(cur + mag));
        const down = speculativeApprovalDelta(name, true, clamp(cur - mag));
        // Gate 2 — suggested direction from the PROPAGATED effect (not the direct
        // feature→score sign): whichever direction yields the better approval.
        return { dir: up >= down ? 'raise' : 'lower', gain: Math.max(up, down) };
      };

      const small = evalStep(SMALL_STEP_FRACTION);
      const large = evalStep(LARGE_STEP_FRACTION);

      // Gate 3 — the suggested direction must hold under BOTH step sizes.
      if (small.dir !== large.dir) return null;
      // Gate 4 gain — achievable propagated gain (larger step).
      if (large.gain <= MIN_GAIN) return null;
      return { direction: small.dir, gain: large.gain };
    }

    // Categorical: best alternative level. "Change" is the only direction, so
    // Gate 3's step-size direction check does not apply.
    const curLabel = buildCurrentEngineState()[name];
    const levels = feature.labelEncoder ? Object.values(feature.labelEncoder) : [];
    let best = 0;
    levels.forEach((lvl) => {
      const asEngine = name === 'term' ? parseTermMonths(lvl) : lvl;
      if (engineValuesEqual(asEngine, curLabel)) return;
      const eff = speculativeApprovalDelta(name, false, lvl);
      if (eff > best) best = eff;
    });
    if (best <= MIN_GAIN) return null;
    return { direction: 'change', gain: best };
  };

  // ── "Ideas to try" ──────────────────────────────────────────────────────────
  // FIRST TIME (fresh plan, before any interaction): show ONLY the plan's
  // suggested changes WITH amounts — any number of them (the coach's diff).
  // AFTER the first edit/dismiss: always show exactly THREE ideas — the remaining
  // (non-dismissed) suggestions, topped up with DIRECTIONAL "what helps next"
  // ideas recomputed against the user's current (settled) state on every edit.
  const TARGET_IDEA_COUNT = 3;

  /** @type {Array} The plan's initial amount ideas (fixed per plan). */
  let amountIdeas = [];
  /** @type {Set<string>} Feature names the user dismissed (amount or directional). */
  let dismissedNames = new Set();
  /** @type {Array} The ideas currently displayed (remaining amount + directional). */
  let visibleIdeas = [];

  /**
   * The raw counterfactual value for a CATEGORICAL feature, decoded to the level
   * LABEL that `feature.labelEncoder` uses (the same string the card and the EBM
   * sample store). cfDataRaw normally holds the label string already, but if a
   * source ever stores the numeric code we decode it here. This is the value the
   * "apply" path needs: FeatureCardCat's override and curValueUpdatedHandler both
   * run it through `codeFromLabel`, which only resolves a real level label.
   */
  const rawCategoricalLabel = (feature) => {
    const raw = plan.cfDataRaw[feature.featureID];
    return typeof raw === 'number' && feature.labelEncoder
      ? feature.labelEncoder[raw]
      : raw;
  };

  /**
   * The plan's suggested changes as initial ideas WITH amounts: diff the coach's
   * raw counterfactual (cfDataRaw) against the applicant baseline; each changed,
   * actionable feature becomes "Raise/Lower/Change X to <amount>".
   */
  const buildInitialIdeas = () => {
    if (!plan || !plan.cfDataRaw || !applicantBaselineState) return [];
    const baseline = applicantBaselineState;
    const suggested = buildEngineState((f) => plan.cfDataRaw[f.featureID]);
    const out = [];
    plan.features.forEach((feature) => {
      const name = feature.data.name;
      if (engineValuesEqual(suggested[name], baseline[name])) return; // coach didn't change it
      if (constraints?.difficulties?.get(name) === IMPOSSIBLE_TO_CHANGE) return;
      if (!isBaselineActionable(name)) return;
      const direction = feature.isCont
        ? Number(suggested[name]) > Number(baseline[name])
          ? 'raise'
          : 'lower'
        : 'change';
      out.push({
        name,
        displayName:
          DISPLAY_NAMES[name] || feature.data.description?.displayName || name,
        verb: ideaVerb(feature.isCont, direction),
        direction,
        mode: 'amount',
        targetDisplay: formatEffectValue(name, suggested[name]),
        // Value to APPLY on click: internal for continuous (what the card + model
        // use), the raw level LABEL for categorical. NOTE: we must NOT use
        // `suggested[name]` for categoricals — buildEngineState rewrites some
        // categorical features to a NUMBER (e.g. `term` → parseTermMonths → 36/60,
        // `mort_acc`/`inq_last_6mths` → counts), which `codeFromLabel` can't map
        // back to a level. Decode the raw counterfactual to the labelEncoder label
        // directly so the card override + model update both resolve correctly.
        applyValue: feature.isCont
          ? displayToInternal(name, suggested[name])
          : rawCategoricalLabel(feature)
      });
    });
    return out;
  };

  /**
   * Up to `count` DIRECTIONAL ideas from the CURRENT state — the existing
   * speculative "what helps next" mechanism (evaluateIdea → strongest propagated
   * approval gain), excluding `exclude`. Rendered with direction only (no amount).
   * Because it is evaluated against the live (settled) state, a feature the user
   * has already moved in the helpful direction stops surfacing on its own, and a
   * different helpful feature takes its place.
   */
  const buildDirectionalIdeas = (count, exclude) => {
    if (!plan || !applicantBaselineState || count <= 0) return [];
    const candidates = [];
    plan.features.forEach((feature) => {
      const name = feature.data.name;
      if (exclude.has(name)) return;
      if (constraints?.difficulties?.get(name) === IMPOSSIBLE_TO_CHANGE) return;
      if (!isBaselineActionable(name)) return;
      let res = null;
      try { res = evaluateIdea(feature); } catch (e) { res = null; }
      if (!res) return;
      candidates.push({
        name,
        displayName:
          DISPLAY_NAMES[name] || feature.data.description?.displayName || name,
        verb: ideaVerb(feature.isCont, res.direction),
        direction: res.direction,
        mode: 'direction',
        gain: res.gain
      });
    });
    candidates.sort((a, b) => b.gain - a.gain);
    return candidates.slice(0, count);
  };

  /**
   * Rebuild the visible ideas to a fixed count of THREE (used after the first
   * interaction): keep up to three remaining (non-dismissed) suggestions, then
   * top up with DIRECTIONAL ideas recomputed against the CURRENT state. Called on
   * every dismiss and after each edit settles, so the ideas stay relevant to where
   * the user is now. The directional recompute is cheap (~2–4 ms) and is debounced
   * with propagation (fires post-settle), so it never lags editing and never
   * triggers the MILP solver.
   */
  const rebuildIdeas = () => {
    const remainingAmount = amountIdeas.filter((i) => !dismissedNames.has(i.name));
    const shownAmount = remainingAmount.slice(0, TARGET_IDEA_COUNT);
    const needed = Math.max(0, TARGET_IDEA_COUNT - shownAmount.length);
    const exclude = new Set([
      ...shownAmount.map((i) => i.name),
      ...dismissedNames
    ]);
    const directional = buildDirectionalIdeas(needed, exclude);
    visibleIdeas = [...shownAmount, ...directional].slice(0, TARGET_IDEA_COUNT);
    ideasStore.set(visibleIdeas);
    // Persist THIS plan's dismissed/applied set on the plan object, so switching away
    // and back restores its Ideas-to-try state (the panel remounts per plan), and so
    // Compare Plans can filter each column by its OWN plan's set — never another's.
    if (plan) plan.dismissedIdeaNames = dismissedNames;
  };

  /**
   * Initialize the idea list for the current plan (mount / plan switch). FIRST
   * TIME: show only the plan's suggested changes, however many there are. The
   * switch to the fixed three-idea view happens on the first edit/dismiss.
   */
  const initIdeas = () => {
    amountIdeas = buildInitialIdeas();
    // Restore this plan's own dismissed/applied set (persisted on the plan object) so
    // switching back to a plan keeps its Ideas-to-try state. A fresh plan — and every
    // plan after a regenerate, which makes new plan objects — starts empty.
    dismissedNames = plan?.dismissedIdeaNames instanceof Set ? plan.dismissedIdeaNames : new Set();
    if (plan) plan.dismissedIdeaNames = dismissedNames;
    if (dismissedNames.size === 0 && amountIdeas.length > 0) {
      // First time on this plan AND it has exact-amount suggested changes: show ALL
      // of them (however many).
      visibleIdeas = [...amountIdeas];
      ideasStore.set(visibleIdeas);
    } else {
      // Either (a) first time on a plan with NO exact-amount suggestions — the
      // coach reached this plan by changing only non-suggestable features — or
      // (b) returning to a plan already acted on. In both cases fall back to the
      // steady-state view: any remaining amount ideas topped up with DIRECTIONAL
      // ideas, so a plan without exact amounts still shows ideas to try from the
      // start instead of a blank panel.
      rebuildIdeas();
    }
  };

  /** Dismiss an idea (amount or directional); recompute the directional ideas. */
  const handleIdeaDismiss = (name) => {
    if (!name) return;
    if (!visibleIdeas.some((i) => i.name === name)) return;
    dismissedNames.add(name); // a dismissed feature is not re-suggested
    rebuildIdeas();
    // Re-emit the plan so Compare Plans (which rebuilds on the plan-store version)
    // reflects the dismissal immediately if it is open. Apply goes through the edit
    // handler, which already re-emits; a bare dismiss does not, so nudge it here.
    if (plan) planStore.set(plan);
  };

  /**
   * Apply an initial (amount) idea: set the feature to the suggested value,
   * updating the card display AND running the same propagation / score / provenance
   * path as a manual edit. `value` is internal for continuous, the level label for
   * categorical (as produced in buildInitialIdeas).
   */
  const applyIdea = (name, value) => {
    if (!plan || value === undefined || value === null) return;
    const feature = plan.features.find((f) => f.data.name === name);
    if (!feature) return;
    // Push the value into the card's displayed value (same channel propagation
    // uses): continuous cards read the internal value, categorical cards read the
    // level LABEL — `value` already matches (internal for cont, label for cat).
    featureValueOverrideStore.set({ [name]: value });
    setTimeout(() => featureValueOverrideStore.set({}), 400);
    // The edit handler wants the internal value for continuous, but the level CODE
    // for categorical (it re-encodes code → label itself); `value` is a label for
    // categorical, so convert it to a code first.
    const handlerValue = feature.isCont
      ? value
      : codeFromLabel(value, feature.labelEncoder);
    curValueUpdatedHandler({ detail: { newValue: handlerValue } }, feature);
    // The suggestion has been enacted — remove it from the panel (and top up the
    // three ideas with a directional one). The edit's own debounced recompute
    // then refreshes the directional set against the settled state.
    dismissedNames.add(name);
    rebuildIdeas();
  };

  /**
   * Run the causal propagation engine for a directly-edited feature, then show
   * the message / outlines / arrows and push the engine's computed dependent
   * values into the EBM and the affected slider cards. The engine (src/engine)
   * is the single source of truth for which features change and by how much.
   */
  const triggerPropagation = async (featureName) => {
    if (!applicantBaselineState || !plan) return;

    const current = buildCurrentEngineState();

    // Leaf feature (no outgoing edges): a direct edit ripples to nothing — still
    // record a row so the user sees the change registered ("Nothing else
    // changed"). Only user-directly-edited features reach triggerPropagation, so
    // this never fires for a feature that changed via propagation.
    if (!featureHasOutgoingEdges(featureName)) {
      recordChangeEffects(featureName, current[featureName], []);
      return;
    }

    // ── 1. Run the engine against the frozen applicant baseline ──────────────
    const baseline = applicantBaselineState;

    // DTI_USER_EDITS_ONLY: pass the set of user-edited features so DTI counts
    // only touched inputs (unedited suggested values fall back to profile).
    // appliedHomeMortgage / userOpenDelta / userTotalDelta let the account
    // counters sum ALL sources (profile + each manual delta + mortgage delta).
    const { state: next, log } = propagate(
      featureName, baseline, current, baseline,
      modifiedFeatures, appliedHomeMortgage, userOpenDelta, userTotalDelta, userFicoDelta,
      userDtiDelta, userRevolDelta, derogIndependentPart
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

    // Has outgoing edges but nothing actually propagated (e.g. a Home Ownership
    // change that is not a mortgage transition) — record a "no effect" row so the
    // change still registers, then stop.
    if (activeTargets.length === 0) {
      recordChangeEffects(featureName, current[featureName], []);
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
    // A user edit that (re)computes these dependents makes them user-affected —
    // drop them from the load-time suggested set so the outline/provenance now
    // reflect the user's action.
    let reclaimed = suggestedAtLoad.delete(featureName);
    activeTargets.forEach(name => { reclaimed = suggestedAtLoad.delete(name) || reclaimed; });
    if (reclaimed) suggestedAtLoad = suggestedAtLoad;

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
    if (ideasDebounceTimer) clearTimeout(ideasDebounceTimer);
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

  // ── Loan-cost summary (repayment breakdown) ─────────────────────────────────
  // The same "Total you'll repay" box the bookmarks panel shows for SAVED plans,
  // but rendered live at the top of the panel for the CURRENT plan whenever it has
  // reached approval — no need to save first. Keys off the TRUE probability (≥ 0.5),
  // not rounded points, so a plan at e.g. 0.497 (which reads "Not approved" / 49
  // points) does NOT show the box. Computed from the live sample via the engine's
  // amortization helper; display-only.
  const money = (x) => Math.round(x).toLocaleString('en-US');
  const moneyApprox = (x) => (Math.round(x / 100) * 100).toLocaleString('en-US');
  $: loanCost =
    !setupMode && plan && plan.ebmLocal &&
    isApproved(sigmoid(plan.ebmLocal.predScore))
      ? (() => {
          const names = [];
          plan.features.forEach((f) => { names[f.featureID] = f.data.name; });
          const cost = loanCostFromExample(plan.ebmLocal.sample, names);
          if (!cost) return null;
          // The Payment Period is a categorical: its raw sample value can be a label
          // ("36 months"), and in some states a form that parseInt reads as 0 —
          // yielding "$0 total, −interest, $0/month". Re-derive the term the SAME way
          // the Payment Period card does (buildCurrentEngineState → parseTermMonths),
          // so the box always matches the displayed term instead of breaking.
          const cur = buildCurrentEngineState();
          const termMonths = Math.round(Number(cur.term) || 0);
          const loanAmount = cost.loanAmount;
          const apr = cost.apr;
          // Guard: only surface a well-defined amortization.
          if (!(termMonths > 0) || !(loanAmount > 0) || !Number.isFinite(apr)) {
            return null;
          }
          const monthly = loanMonthlyPayment(loanAmount, apr / 12, termMonths);
          if (!Number.isFinite(monthly) || !(monthly > 0)) return null;
          const total = monthly * termMonths;
          return { loanAmount, termMonths, apr, monthly, total, interest: total - loanAmount };
        })()
      : null;

</script>

<style lang='scss'>
  @import './FeaturePanel.scss';
</style>

<div class='feature-panel' bind:this={component}>

  <!-- Repayment breakdown — shown between the plan name and the actionable features
       for any plan that has reached approval (score ≥ 50), saved or not. -->
  {#if loanCost}
    <div class="loan-cost-box">
      <div class="lc-total">
        <span class="lc-total-label">Total you'll repay</span>
        <span class="lc-total-amt">~${moneyApprox(loanCost.total)}</span>
      </div>
      <div class="lc-split">
        Your ${money(loanCost.loanAmount)} loan
        + ~${moneyApprox(loanCost.interest)} interest
      </div>
      <div class="lc-monthly">
        ${money(loanCost.monthly)}/month for {loanCost.termMonths} months
        ({(loanCost.apr * 100).toFixed(2)}% APR)
      </div>
    </div>
  {/if}

  <div class='card-block'>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class='row-header' on:click={() => toggleGroup('changed')}>
      <span class='label'>Actionable Features</span>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <span class='header-info' on:click|stopPropagation>
        <span class='hi-badge'>i</span>
        <span class='hi-popup'>Features you can directly act on to change your application.</span>
      </span>
      <svg class='group-chev' class:collapsed={collapsedGroups.changed} viewBox='0 0 24 24' width='16' height='16'
           fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'>
        <path d='M6 9l6 6l6 -6'/>
      </svg>
    </div>

    <div class='card-row' class:collapsed-body={collapsedGroups.changed}>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.changed.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class='row-header' on:click={() => toggleGroup('configured')}>
      <span class='label'>Computed Features</span>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <span class='header-info' on:click|stopPropagation>
        <span class='hi-badge'>i</span>
        <!-- Phase-aware: during first-time setup no propagation runs yet (the user
             is entering values), so the copy tells them to enter these now; once
             setup is done and editing/propagation is live, it describes the
             automatic updates. Keys off the existing `setupMode` prop. -->
        <span class='hi-popup'>{setupMode
          ? "These values depend on your other features. Enter them now; after setup, they'll update automatically when you change the features they depend on."
          : "These values depend on your other features. They update automatically when you change the features they depend on."}</span>
      </span>
      <svg class='group-chev' class:collapsed={collapsedGroups.configured} viewBox='0 0 24 24' width='16' height='16'
           fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'>
        <path d='M6 9l6 6l6 -6'/>
      </svg>
    </div>

    <div class='card-row' class:collapsed-body={collapsedGroups.configured}>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.configured.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class='row-header' on:click={() => toggleGroup('other')}>
      <span class='label'>Profile Features</span>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <span class='header-info' on:click|stopPropagation>
        <span class='hi-badge'>i</span>
        <span class='hi-popup'>Your background details.</span>
      </span>
      <svg class='group-chev' class:collapsed={collapsedGroups.other} viewBox='0 0 24 24' width='16' height='16'
           fill='none' stroke='currentColor' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'>
        <path d='M6 9l6 6l6 -6'/>
      </svg>
    </div>

    <div class='card-row' class:collapsed-body={collapsedGroups.other}>

      <div class='card-column left-column' bind:this={leftColumn}>

        {#each featureGrid.other.left as feature}
          {#if feature.isCont}
            <FeatureCard
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={feature.data.name in LINK_POPUP_TEXT}
              linkDeps={FEATURE_DEPS[feature.data.name] || null}
              modified={modifiedFeatures.has(feature.data.name) && !suggestedAtLoad.has(feature.data.name)}
              linkPopupText={LINK_POPUP_TEXT[feature.data.name] || ''}
              linkCalculation={feature.data.name === 'fico_score' ? ficoLinkCalculation
                             : feature.data.name === 'dti'        ? dtiLinkCalculation
                             : feature.data.name === 'revol_bal'  ? revolBalLinkCalculation
                             : feature.data.name === 'revol_util' ? revolUtilLinkCalculation
                             : feature.data.name === 'mort_acc'   ? mortAccLinkCalculation
                             : feature.data.name === 'open_acc'   ? openAccLinkCalculation
                             : feature.data.name === 'total_acc'  ? totalAccLinkCalculation
                             : null}
              getResetPreview={resetRevertNames}
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