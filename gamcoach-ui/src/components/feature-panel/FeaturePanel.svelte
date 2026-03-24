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
  import { tooltipConfigStore, featureValueOverrideStore } from '../../store';

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

  // ── Loan Amount propagation: APR by internal purpose label ──────────────────
  // APRs are decimals (e.g. 0.061 = 6.1%).  Any purpose not listed defaults to
  // the personal-loan rate of 11.65%.
  const APR_BY_PURPOSE = {
    'house':            0.0610,
    'small_business':   0.0890,
    'car':              0.0622,
    'renewable_energy': 0.0849
  };

  // Tracks whether the one-time FICO drop from changing Loan Amount has fired.
  let ficoDropApplied = false;

  // Propagation map — which features indirectly change when a feature is directly changed
  // Keys are internal feature names; displayName is used for the message
  const PROPAGATION_MAP = {
    'loan_amnt': {
      displayName: 'Loan Amount',
      // revol_bal / revol_util only activate when purpose is credit_card or debt_consolidation;
      // fico_score only activates once (ficoDropApplied flag). Actual active set is computed at runtime.
      targets: ['fico_score', 'dti', 'revol_bal', 'revol_util']
    },
    'dti': {
      displayName: 'Debt to Income Ratio',
      targets: ['annual_inc']
    },
    'revol_bal': {
      displayName: 'Revolving Balance',
      targets: ['dti', 'revol_util']
    },
    'open_acc': {
      displayName: 'Number of Open Accounts',
      targets: ['fico_score', 'total_acc']
    },
    'fico_score': {
      displayName: 'FICO Score',
      targets: ['loan_amnt', 'revol_util']
    },
    'term': {
      displayName: 'Payment Period',
      targets: ['dti']
    },
    'home_ownership': {
      displayName: 'Home Ownership',
      targets: ['open_acc', 'revol_util', 'total_acc', 'mort_acc']
    },
    'purpose': {
      displayName: 'Loan Purpose',
      targets: ['revol_bal', 'fico_score', 'revol_util']
    },
    'inq_last_6mths': {
      displayName: 'Number of Credit Inquiries',
      targets: ['fico_score']
    },
    'pub_rec_bankruptcies': {
      displayName: 'Number of Bankruptcies',
      targets: ['fico_score']
    },
    'annual_inc': {
      displayName: 'Annual Income',
      targets: ['loan_amnt', 'dti', 'revol_bal']
    },
    'revol_util': {
      displayName: 'Credit Utilization',
      targets: ['dti', 'revol_bal', 'fico_score']
    }
  };

  // Flat set of every feature that can be indirectly changed — used to show the linked icon
  const ALL_TARGETS = new Set(
    Object.values(PROPAGATION_MAP).flatMap(p => p.targets)
  );
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
  let showArrows = false;
  let arrowPaths = [];
  let arrowLabels = [];
  let panelClipRect = null;
  let propagationTimer = null;
  let propagationDebounceTimer = null;
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
    let newValue = e.detail.newValue;

    // Encode the level if it is a categorical feature
    if (feature.data.type === 'categorical') {
      newValue = feature.labelEncoder[newValue];
    }

    // Update the local EBM
    plan.ebmLocal.updateFeature(feature.data.name, newValue);

    // Update the store
    planStore.set(plan);

    // Only trigger propagation if the value actually changed from what was last seen.
    // This prevents arrows firing when a card is expanded (which replays the current value).
    const featureName = feature.data.name;
    const previousValue = lastKnownValues[featureName];
    lastKnownValues[featureName] = newValue;

    if (previousValue !== undefined && previousValue !== newValue) {
      // Debounce — only fire after user stops dragging (350ms of silence)
      if (propagationDebounceTimer) clearTimeout(propagationDebounceTimer);
      propagationDebounceTimer = setTimeout(() => {
        propagationDebounceTimer = null;
        triggerPropagation(featureName);
      }, 350);
    }
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
  // Loan Amount propagation mechanics
  // ────────────────────────────────────────────────────────────────────────────

  /**
   * Compute the new values for features that change when Loan Amount is altered.
   * Returns a map of { featureName: internalValue } for every feature that changed.
   *
   * Rules:
   *  1. FICO Score   — one-time drop of 4 points (ficoDropApplied flag prevents repeat)
   *  2. DTI          — recalculated via loan amortization formula + existing debt
   *  3. Revol Balance  — only if purpose is credit_card or debt_consolidation
   *  4. Revol Util     — derived from new revol balance ÷ credit limit
   *
   * @param {number} loanAmount  Display value of the new loan amount (no transform)
   */
  const applyLoanAmountPropagation = (loanAmount) => {
    const updates = {};

    // ── Read ORIGINAL baseline values for dependent features ────────────────
    // Always use originalValues (coach suggestions at load time) so that
    // repeated changes to Loan Amount don't stack — each calculation is
    // computed fresh relative to the same starting point.
    const annualIncDisplay  = getOriginalDisplayValue('annual_inc') || 1;
    const monthlyIncome     = annualIncDisplay / 12;
    const dtiDisplay        = getOriginalDisplayValue('dti')        || 0;
    const revolBalDisplay   = getOriginalDisplayValue('revol_bal')  || 0;
    const revolUtilDisplay  = getOriginalDisplayValue('revol_util') || 0;
    // Purpose and term use current values — the user may have changed them intentionally
    const purposeLabel      = getCurrentValue('purpose')            || '';
    const termLabel         = getCurrentValue('term')               || '36 months';
    const termMonths        = parseTermMonths(termLabel);

    // ── 1. FICO Score — drop by 4 only on the first loan_amnt change ─────────
    if (!ficoDropApplied) {
      const currentFico  = getOriginalDisplayValue('fico_score') || 0;
      const newFico      = currentFico - 4;
      const newFicoInt   = toInternalValue(newFico, 'fico_score');
      updates['fico_score']   = newFicoInt;
      lastKnownValues['fico_score'] = newFicoInt;
      ficoDropApplied = true;
    }

    // ── 2. DTI — amortization formula ────────────────────────────────────────
    // APR defaults to 11.65 % for any purpose not in APR_BY_PURPOSE
    const apr              = APR_BY_PURPOSE[purposeLabel] ?? 0.1165;
    const monthlyRate      = apr / 12;
    // Monthly payment for the new loan (standard amortization formula)
    const newLoanPayment   = monthlyRate > 0
      ? (loanAmount * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths))
      : loanAmount / termMonths;
    // Current monthly debt derived from existing DTI
    const currentMonthlyDebt = (dtiDisplay * monthlyIncome) / 100;
    const newMonthlyDebt     = currentMonthlyDebt + newLoanPayment;
    const newDTI             = monthlyIncome > 0 ? (newMonthlyDebt / monthlyIncome) * 100 : 0;
    const newDTIInt          = toInternalValue(newDTI, 'dti');
    updates['dti']          = newDTIInt;
    lastKnownValues['dti']  = newDTIInt;

    // ── 3 & 4. Revolving Balance + Credit Utilization ────────────────────────
    // These only apply when the loan is used to pay down a revolving credit line
    if (['credit_card', 'debt_consolidation'].includes(purposeLabel)) {
      // New balance after paying down with loan proceeds
      const newRevolBal    = Math.max(0, revolBalDisplay - loanAmount);
      const newRevolBalInt = toInternalValue(newRevolBal, 'revol_bal');
      updates['revol_bal']          = newRevolBalInt;
      lastKnownValues['revol_bal']  = newRevolBalInt;

      // Credit limit is implicit: current balance ÷ (utilization / 100)
      if (revolUtilDisplay > 0 && revolBalDisplay > 0) {
        const creditLimit    = revolBalDisplay / (revolUtilDisplay / 100);
        const newRevolUtil   = (newRevolBal / creditLimit) * 100;
        const newRevolUtilInt = toInternalValue(newRevolUtil, 'revol_util');
        updates['revol_util']          = newRevolUtilInt;
        lastKnownValues['revol_util']  = newRevolUtilInt;
      }
    }

    return updates;
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
   * Show propagation message, blue outlines, and animated arrows when a feature
   * change cascades to other features.  For features that have defined calculation
   * mechanics (currently loan_amnt), also compute and apply the new derived values
   * to the EBM and to the affected slider cards.
   */
  const triggerPropagation = async (featureName) => {
    const propagation = PROPAGATION_MAP[featureName];
    if (!propagation) return;

    if (propagationTimer) clearTimeout(propagationTimer);

    // ── 1. Compute actual targets + derived values (feature-specific logic) ──
    let activeTargets = [...propagation.targets];
    let computedUpdates = {}; // featureName → internal value

    if (featureName === 'loan_amnt') {
      const loanAmount = getCurrentValue('loan_amnt'); // No transform; display = internal
      if (loanAmount !== null) {
        computedUpdates = applyLoanAmountPropagation(loanAmount);
        // Active targets = only the features that were actually computed this time
        activeTargets = Object.keys(computedUpdates);
      }
    }

    // ── 2. Build + show the sticky message ───────────────────────────────────
    const count = activeTargets.length;
    const featureWord = count === 1 ? 'feature' : 'features';
    const targetNames = activeTargets
      .map(name => DISPLAY_NAMES[name] || name)
      .join(', ');
    propagationMessage = `Changing ${propagation.displayName} changed ${count} other ${featureWord}: ${targetNames}`;
    showPropagationMessage = true;
    showArrows = false;
    arrowPaths = [];
    arrowLabels = [];

    await tick();

    // ── 3. Blue outlines on source + affected cards ───────────────────────────
    const allNames = [featureName, ...activeTargets];
    allNames.forEach(name => {
      const el = document.querySelector(`[data-feature-name="${name}"]`);
      if (el) el.classList.add('highlighted');
    });

    // ── 4. Push computed values into the EBM and move the sliders ───────────
    if (Object.keys(computedUpdates).length > 0) {
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
    }

    // ── 5. Draw SVG arrows ────────────────────────────────────────────────────
    if (component) {
      const rect = component.getBoundingClientRect();
      panelClipRect = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }

    const sourceEl = document.querySelector(`[data-feature-name="${featureName}"]`);
    if (sourceEl && activeTargets.length > 0) {
      const sourceRect = sourceEl.getBoundingClientRect();
      const sx = sourceRect.left + sourceRect.width / 2;
      const sy = sourceRect.top + sourceRect.height / 2;

      const targetData = activeTargets
        .map(name => ({ name, el: document.querySelector(`[data-feature-name="${name}"]`) }))
        .filter(({ el }) => el !== null)
        .map(({ name, el: targetEl }) => {
          const targetRect = targetEl.getBoundingClientRect();
          const tx = targetRect.left + targetRect.width / 2;
          const ty = targetRect.top + targetRect.height / 2;
          // Label at 20% along the line from the source
          const lx = sx + 0.2 * (tx - sx);
          const ly = sy + 0.2 * (ty - sy);
          return {
            path: `M${sx},${sy} L${tx},${ty}`,
            labelX: lx, labelY: ly,
            labelText: `${DISPLAY_NAMES[name] || name} changed`
          };
        });

      arrowPaths = targetData.map(d => d.path);
      arrowLabels = resolveOverlaps(targetData.map(d => ({
        x: d.labelX, y: d.labelY, text: d.labelText
      })));
      showArrows = true;
    }

    // Arrows disappear after 2 s; message + highlights are permanent
    propagationTimer = setTimeout(() => {
      showArrows = false;
      arrowPaths = [];
      arrowLabels = [];
      propagationTimer = null;
    }, 2000);
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
  });

  onDestroy(() => {
    unsubscribes.forEach(unsub => unsub());
    if (propagationTimer) clearTimeout(propagationTimer);
    if (propagationDebounceTimer) clearTimeout(propagationDebounceTimer);
  });

  $: windowLoaded && planStore && !initialized && initFeatureCards();
  $: mounted && maxFeatureNum && maxFeatureNumChanged();

</script>

<style lang='scss'>
  @import './FeaturePanel.scss';
</style>

<div class='feature-panel' bind:this={component}>

  {#if showPropagationMessage}
    <div class='propagation-message' transition:fade={{ duration: 300 }}>
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
              on:curValueUpdated={(e) => curValueUpdatedHandler(e, feature)}
              on:constraintUpdated={(e) => constraintUpdatedHandler(e, feature)}
            >
            </FeatureCard>
          {:else}
            <FeatureCardCat
              feature={feature}
              logger={logger}
              isLinked={ALL_TARGETS.has(feature.data.name)}
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
      </g>
    </svg>
  {/if}

</div>