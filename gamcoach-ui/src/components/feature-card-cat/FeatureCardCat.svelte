<script>
  // @ts-check
  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG } from '../../utils/utils';
  import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
  import { fade } from 'svelte/transition';
  import { tooltipConfigStore, diffPickerConfigStore, featureValueOverrideStore, derogFloorHintStore } from '../../store';

  // The categorical card now renders its values as a native HTML 3-column grid
  // (value / single-select radio / multi-select checkbox) instead of the old
  // SVG bar chart, so the SVG drawing helpers (initHist/initHistSize/syncBars)
  // are no longer imported.

  import rightArrowIcon from '../../img/icon-right-arrow.svg';
  import levelThumbIcon from '../../img/icon-level-thumb.svg';
  import easyIcon from '../../img/icon-easy.svg';
  import veryEasyIcon from '../../img/icon-very-easy.svg';
  import neutralIcon from '../../img/icon-neutral.svg';
  import hardIcon from '../../img/icon-hard.svg';
  import veryHardIcon from '../../img/icon-very-hard.svg';
  import lockIcon from '../../img/icon-lock.svg';
  import infoIcon from '../../img/icon-info.svg';
  import closeIcon from '../../img/icon-close.svg';
  import refreshIcon from '../../img/icon-refresh.svg';

  /** @type {Feature}*/
  export let feature = null;

  /** @type {Logger} */
  export let logger = null;

  /** Whether this feature can be indirectly changed by another feature */
  export let isLinked = false;

  /** Whether the user has modified this feature (and not reset it). Drives the
   *  blue outline. */
  export let modified = false;

  /** Explanatory text shown in the link popup (empty = default placeholder) */
  export let linkPopupText = '';

  /** Optional calculation to display: { before: number, after: number }
   *  Renders as "before − delta = after" beneath the popup text */
  export let linkCalculation = null;

  /** Static dependency lists for the info tooltip: {changedBy?, canChange?}. */
  export let linkDeps = null;

  /** (featureName) => string[]: display names of the OTHER features a reset of this
   *  card will also revert (the coupled group, computed live from current state).
   *  Drives the reset-button hover warning. */
  export let getResetPreview = null;

  // Reset-hover warning: names of connected features this reset will also revert.
  // Recomputed on each hover so it always matches what clicking reset reverts.
  let resetTipNames = [];
  let resetTipOpen = false;
  const openResetTip = () => {
    resetTipNames = getResetPreview
      ? getResetPreview(state.feature.featureName) || []
      : [];
    resetTipOpen = true;
  };
  const closeResetTip = () => {
    resetTipOpen = false;
  };

  // Flip the popup upward when near the bottom of the viewport.
  // Uses direct DOM manipulation (not Svelte state) to avoid triggering
  // a re-render, which would disrupt the CSS :hover state and cause flickering.
  const linkIconMouseEnter = () => {
    if (!component) return;
    const icon = component.querySelector('.link-icon');
    if (!icon) return;
    const popup = icon.querySelector('.link-popup');
    if (!popup) return;
    const rect = icon.getBoundingClientRect();
    popup.classList.toggle('flip-up', (window.innerHeight - rect.bottom) < 220);
  };

  let mounted = false;
  let initialized = false;
  let histDrawn = false;
  let isCollapsed = true;
  let isExpanded = false;
  const unsubscribes = [];
  let state = {};

  // Constants
  state.tickHeights = {
    default: 6,
    original: 6 * 1.8,
    user: 6 * 1.8,
    coach: 6 * 1.8
  };

  // Binding variables, which will be initialized after window is loaded
  /** @type {HTMLElement} */
  let component = null;

  const dispatch = createEventDispatcher();

  state.tickXScale = null;
  state.histSVG = null;
  state.showingAnnotation = null;
  state.xCenters = [];
  state.tickOpacityTimeout = null;
  state.helperMessageDefault = 'Value Distribution of All Users';
  state.helperMessage = state.helperMessageDefault;

  /** @type {Feature}*/
  state.featurePtr = feature;

  /** @type {Logger}*/
  state.logger = logger;

  state.feature = {
    name: '',
    featureName: '',
    descriptionString: '',
    /** @type {string | number}*/
    originalValue: 0,
    /** @type {string | number}*/
    curValue: 0,
    /** @type {string | number}*/
    coachValue: 0,
    histEdge: [0],
    histCount: null,
    id: 0,
    labelEncoder: {},
    description: {},
    searchValues: new Set()
  };

  const difficultyIconMap = {
    neutral: neutralIcon,
    easy: easyIcon,
    'very-easy': veryEasyIcon,
    hard: hardIcon,
    'very-hard': veryHardIcon,
    lock: lockIcon
  };

  const difficultyTextMap = {
    neutral: 'Default difficulty',
    easy: 'Easy to change',
    'very-easy': 'Very easy to change',
    hard: 'Hard to change',
    'very-hard': 'Very hard to change',
    lock: "New plans won't change it"
  };

  let diffPickerConfig = null;
  let unsub = diffPickerConfigStore.subscribe((value) => {
    // Listen to the picked event
    if (
      value.action === 'picked' &&
      value.feature === state.feature.featureName
    ) {
      // Log the interaction
      logger?.addLog({
        eventName: `[${feature.data.name}] diff changed`,
        elementName: 'diff picker',
        valueName: 'diff',
        oldValue: feature.difficulty,
        newValue: value.difficulty
      });

      // Update the icon
      feature.difficulty = value.difficulty;

      // Change `isConstrained` if necessary
      if (
        feature.difficulty === 'neutral' &&
        feature.acceptableRange === null
      ) {
        feature.isConstrained = false;
      } else {
        feature.isConstrained = true;
      }

      // Propagate the change to FeaturePanel
      dispatch('constraintUpdated', {
        difficulty: feature.difficulty,
        acceptableRange: encodeAcceptableRange(feature.acceptableRange)
      });
    }

    diffPickerConfig = value;
  });
  unsubscribes.push(unsub);

  let tooltipConfig = null;
  unsub = tooltipConfigStore.subscribe((value) => {
    tooltipConfig = value;
  });
  unsubscribes.push(unsub);

  /**
   * A workaround to listen to changes made in the js functions.
   * @param {string | null} [key] Type of the update, can be one of ['value',
   *  null]. It triggers corresponding callbacks to update the stores.
   */
  const stateUpdated = (key = null) => {
    // Trigger svelte interactivity
    state = state;

    if (key === 'value') {
      // Propagate the change to FeaturePanel
      dispatch('curValueUpdated', {
        newValue: state.feature.curValue
      });
    }
  };
  state.stateUpdated = stateUpdated;

  /**
   * A workaround to listen to change of feature in the js functions.
   * @param {string | null} [key] If key is 'constraint', then it triggers an
   * event to the feature panel to update the global constraints.
   */
  const featureUpdated = (key = null) => {
    feature = state.featurePtr;
    state = state;

    if (key === 'constraint') {
      // Propagate the change to FeaturePanel
      dispatch('constraintUpdated', {
        difficulty: feature.difficulty,
        acceptableRange: encodeAcceptableRange(feature.acceptableRange)
      });
    }
  };
  state.featureUpdated = featureUpdated;

  /**
   * Init the states of different elements. Some functions require bbox,
   * which is only accurate after content is loaded
   */
  const initFeatureCard = async () => {
    initialized = true;

    const featureInfo = feature.data;

    // Initialize the feature data from the prop
    state.feature = {
      name: featureInfo.description.displayName,
      featureName: featureInfo.name,
      descriptionString: featureInfo.description.description,
      originalValue: feature.originalValue,
      // Re-initialise to the propagated/edited level (stored as a label on the
      // feature object) when present, so the card keeps its value across remounts.
      curValue:
        feature.hypotheticalValue !== undefined
          ? codeFromLabel(feature.hypotheticalValue, feature.labelEncoder) ?? feature.coachValue
          : feature.coachValue,
      coachValue: feature.coachValue,
      histEdge: featureInfo.histEdge,
      histCount: featureInfo.histCount,
      id: feature.featureID,
      description: featureInfo.description,
      labelEncoder: feature.labelEncoder,
      searchValues:
        feature.acceptableRange === null
          ? new Set(featureInfo.histEdge)
          : new Set(feature.acceptableRange)
    };

    state.logger = logger;

    // The value grid is plain reactive HTML (no SVG to size/draw here).
    // Wait for the view to update, then fit the feature name to the header.
    await tick();
    fitFeatureName();

    initialized = true;
  };

  /**
   * Handler for clicking the difficulty picker
   */
  const diffClickedHandler = () => {
    // If the diff picker is shown for the current feature, we stop showing
    if (
      diffPickerConfig.feature === state.feature.featureName &&
      Date.now() - diffPickerConfig.focusOutTime < 200
    ) {
      diffPickerConfig.x = 0;
      diffPickerConfig.y = 0;
      diffPickerConfig.action = 'to-hide';
      diffPickerConfig.feature = null;

      diffPickerConfigStore.set(diffPickerConfig);
      return;
    }

    // Trigger the difficulty picker
    // Figure out the location to put the picker
    const bbox = d3
      .select(component)
      .select('.feature-difficulty')
      .node()
      .getBoundingClientRect();

    const newX = bbox.x + bbox.width / 2 - diffPickerConfig.width / 4 - 2;
    const newY = bbox.y - diffPickerConfig.height - 8;

    diffPickerConfig.x = newX;
    diffPickerConfig.y = newY;
    diffPickerConfig.action = 'to-show';
    diffPickerConfig.feature = state.feature.featureName;

    diffPickerConfigStore.set(diffPickerConfig);
  };

  /**
   * Dynamically change the font size for the feature name to make it fit the
   * size of the header
   */
  const fitFeatureName = () => {
    const featureNameElem = d3.select(component).select('.feature-name');

    let fontSize = parseFloat(
      window.getComputedStyle(featureNameElem.node()).fontSize
    );
    const nameHeight = featureNameElem.node().clientHeight;
    const parentHeight = featureNameElem.node().parentNode.clientHeight;

    if (nameHeight > parentHeight) {
      fontSize -= 0.5;
      featureNameElem.style('font-size', `${fontSize}px`);
      fitFeatureName();
    }
  };

  /**
   * Handler when header is clicked
   * @param {MouseEvent} e Mouse event
   */
  export const headerClicked = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    logger?.addLog({
      eventName: `[${state.feature.featureName}] clicked`,
      elementName: 'feature card',
      valueName: 'isCollapsed',
      oldValue: isCollapsed ? 'collapsed' : 'extended',
      newValue: !isCollapsed ? 'collapsed' : 'extended'
    });

    // Register the initial size
    const initBBox = component.getBoundingClientRect();

    // Also animate the configuration bar if it is always shown
    /** @type {HTMLElement} */
    const configDIV = component.querySelector('.configuration');
    const initConfigBBox = configDIV.getBoundingClientRect();

    isCollapsed = !isCollapsed;
    await tick();

    // Register the final state
    const finalBBox = component.getBoundingClientRect();
    const finalConfigBBox = configDIV.getBoundingClientRect();

    const animation = component.animate(
      [{ height: `${initBBox.height}px` }, { height: `${finalBBox.height}px` }],
      {
        duration: 250,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'none'
      }
    );

    animation.onfinish = () => {
      // The value grid is reactive HTML, so there is nothing to draw here.
      isExpanded = !isExpanded;
    };

    // Use FLIP to animate the configuration bar
    if (feature.isConstrained) {
      configDIV.animate(
        [
          {
            transform: `translate(0, ${initConfigBBox.y - finalConfigBBox.y}px)`
          },
          { transform: 'none' }
        ],
        {
          duration: 250,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both'
        }
      );
    }
  };

  /**
   * Convert acceptable range to readable text
   * @param acceptableRange
   */
  const displayAcceptableRange = (acceptableRange) => {
    if (acceptableRange !== null && acceptableRange.length === 0) {
      return "New plans won't consider this feature";
    }

    let text = 'New plans consider ';
    const levelDescription = feature.description.levelDescription;

    let acceptableRangeAll = acceptableRange;
    if (acceptableRange === null) {
      acceptableRangeAll = Object.keys(feature.labelEncoder);
    }

    text = text.concat(
      `"${levelDescription[acceptableRangeAll[0]].displayName}"`
    );

    for (let i = 1; i < acceptableRangeAll.length - 1; i++) {
      text = text.concat(
        ', ',
        `"${levelDescription[acceptableRangeAll[i]].displayName}"`
      );
    }

    if (acceptableRangeAll.length == 2) {
      text = text.concat(
        ` and "${levelDescription[acceptableRangeAll[1]].displayName}"`
      );
    } else if (acceptableRangeAll.length > 2) {
      text = text.concat(
        `, and "${
          levelDescription[acceptableRangeAll[acceptableRangeAll.length - 1]]
            .displayName
        }"`
      );
    }

    return text;
  };

  const displayLevel = (state, value) => {
    if (state.feature.description.levelDescription === undefined) {
      return '';
    } else if (
      state.feature.description.levelDescription[value] === undefined
    ) {
      return '';
    } else {
      return state.feature.description.levelDescription[value].displayName;
    }
  };

  /**
   * gamcoach.js uses edge names for acceptable range, we need to translate
   * edge id to edge names
   * @param {number[]} acceptableRange Edge ids
   */
  const encodeAcceptableRange = (acceptableRange) => {
    // Need to encode the edge labels (numbers) to edge names (string)
    // gamcoach.js uses edge names for the acceptable range
    if (acceptableRange === null) return null;
    return acceptableRange.map((id) => state.feature.labelEncoder[id]);
  };

  /**
   * Handler for the reset button click event.
   * @param {MouseEvent} e Mouse event
   */
  const resetClicked = (e) => {
    e.preventDefault();
    e.stopPropagation();

    logger?.addLog({
      eventName: `[${state.feature.featureName}] reset clicked`,
      elementName: 'reset'
    });

    // Restore the clicked feature's own value visually (reactivity only — do
    // NOT call stateUpdated('value'), which dispatches curValueUpdated as an
    // edit and would trigger propagation).
    state.feature.curValue = state.feature.coachValue;

    // Make all values acceptable again (no constraint).
    state.feature.searchValues = new Set(state.feature.histEdge);
    feature.acceptableRange = null;

    // Re-render the value grid (single-select radio + acceptable checkboxes).
    state.stateUpdated();

    // Change difficulty to default
    feature.difficulty = 'neutral';
    feature.isConstrained = false;

    // RESET_TO_LOAD_STATE: dispatch a reset (not an edit) so FeaturePanel
    // restores this feature and its sources/dependents to their load-time
    // snapshot values without propagating.
    dispatch('curValueUpdated', {
      newValue: state.feature.coachValue,
      isReset: true
    });

    // Propagate the change to FeaturePanel
    dispatch('constraintUpdated', {
      difficulty: feature.difficulty,
      acceptableRange: encodeAcceptableRange(feature.acceptableRange)
    });
  };

  /**
   * Single-select (round radio button): pick ONE value to try as the
   * hypothetical value. This is the value shown to the right of the arrow on the
   * card. Mirrors the old text-click behavior.
   * @param {string|number} edge The selected value code
   */
  const selectSingleValue = (edge) => {
    if (edge === state.feature.curValue) return;

    logger?.addLog({
      eventName: `[${state.feature.featureName}] value changed`,
      elementName: 'radio',
      valueName: 'curValue',
      oldValue: state.feature.labelEncoder[state.feature.curValue],
      newValue: state.feature.labelEncoder[edge]
    });

    state.feature.curValue = edge;
    // Propagates the new hypothetical value to FeaturePanel and re-renders.
    state.stateUpdated('value');
  };

  /**
   * Multi-select (square checkbox): toggle a value in/out of the acceptable set.
   * This does the same job as the old acceptable-range selection. Mirrors the
   * old bar-click + syncFeature logic.
   * @param {string|number} edge The value code to toggle
   */
  const toggleAcceptableValue = (edge) => {
    const oldRange = Array.from(state.feature.searchValues);

    if (state.feature.searchValues.has(edge)) {
      state.feature.searchValues.delete(edge);
    } else {
      state.feature.searchValues.add(edge);
    }

    logger?.addLog({
      eventName: `[${state.feature.featureName}] range changed`,
      elementName: 'checkbox',
      valueName: 'range',
      oldValue: oldRange,
      newValue: Array.from(state.feature.searchValues)
    });

    // Mirror syncFeature(): acceptableRange is null when every value is accepted.
    if (state.feature.searchValues.size !== state.feature.histEdge.length) {
      state.featurePtr.acceptableRange = Array.from(state.feature.searchValues);
    } else {
      state.featurePtr.acceptableRange = null;
    }

    if (
      state.featurePtr.difficulty === 'neutral' &&
      state.featurePtr.acceptableRange === null
    ) {
      state.featurePtr.isConstrained = false;
    } else {
      state.featurePtr.isConstrained = true;
    }

    // Dispatches constraintUpdated to FeaturePanel and re-renders the checkboxes.
    state.featureUpdated('constraint');
  };

  onMount(() => {
    // Bind the SVG icons on mount
    const iconList = [
      { class: 'icon-right-arrow', svg: rightArrowIcon },
      { class: 'icon-level-thumb', svg: levelThumbIcon },
      { class: 'icon-info', svg: infoIcon },
      { class: 'icon-close', svg: closeIcon },
      { class: 'icon-refresh', svg: refreshIcon }
    ];
    bindInlineSVG(component, iconList);
    mounted = true;
  });

  onDestroy(() => {
    unsubscribes.forEach((unsub) => unsub());
  });

  /**
   * Map a level label (e.g. '1', '7+') back to its numeric level code using a
   * {code: label} encoder.
   * @param {string} label
   * @param {Record<string,string>} enc
   * @returns {number|null}
   */
  const codeFromLabel = (label, enc) => {
    if (!enc) return null;
    for (const [code, lbl] of Object.entries(enc)) {
      if (lbl === label) return parseInt(code, 10);
    }
    return null;
  };

  // When the propagation engine computes a new value for this categorical
  // feature (e.g. Number of Mortgages after a Home Ownership -> Mortgage
  // change), featureValueOverrideStore carries its new level LABEL. Update the
  // selected level and re-highlight the bars so the card reflects the change.
  $: {
    const featureName = feature?.data?.name;
    if (featureName && initialized) {
      const overrideLabel = $featureValueOverrideStore[featureName];
      if (overrideLabel !== undefined && overrideLabel !== null) {
        const newCode = codeFromLabel(overrideLabel, state.feature.labelEncoder);
        if (newCode !== null && newCode !== state.feature.curValue) {
          feature.hypotheticalValue = overrideLabel;
          state.feature.curValue = newCode;
          state = state; // trigger reactivity so the header value + grid update
        }
      }
    }
  }

  // Transient floor-guard hint (Derogatory Records only): shown when the user
  // tries to set the value below their current bankruptcy count and it clamps.
  $: floorHint =
    feature?.data?.name && $derogFloorHintStore.feature === feature.data.name
      ? $derogFloorHintStore.message
      : '';

  $: feature && mounted && !initialized && initFeatureCard();
</script>

<div class="feature-card" bind:this={component} class:collapsed={isCollapsed} class:highlighted={modified} data-feature-name={feature?.data?.name}>
  <div
    class="feature-header"
    class:collapsed={isCollapsed}
    on:click={headerClicked}
  >
    <div class="top-row">
      <div class="feature-info">
        <span class="feature-name">
          {state.feature.name}
        </span>
      </div>

      {#if isLinked}
        <div class="link-icon" on:click|stopPropagation on:mouseenter={linkIconMouseEnter}>
          <span class="link-chain-wrap">
            <svg width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
            <span class="link-badge">i</span>
          </span>
          <div class="link-popup">
            {#if linkPopupText}
              <p class="link-popup-text">{linkPopupText}</p>
              {#if linkDeps}
                <div class="link-deps">
                  {#if linkDeps.changedBy}
                    <div class="dep-row">
                      <span class="dep-label">Can be changed by</span>
                      <span class="dep-list">{linkDeps.changedBy}</span>
                    </div>
                  {/if}
                  {#if linkDeps.canChange}
                    <div class="dep-row">
                      <span class="dep-label">Can change</span>
                      <span class="dep-list">{linkDeps.canChange}</span>
                    </div>
                  {/if}
                </div>
              {/if}
              {#if linkCalculation?.type === 'fico'}
                <div class="link-calculation">
                  {linkCalculation.before} &minus; 4 = {linkCalculation.after}
                </div>
              {:else if linkCalculation?.type === 'dti'}
                <div class="link-calculation dti-calc">
                  <div class="dti-line intro">Your DTI is {linkCalculation.newDTI}, so {linkCalculation.newDTI}% of your income would go toward debt payments.</div>
                  <div class="dti-subhead">Your DTI breakdown</div>
                  {#if linkCalculation.foldedLayout}
                    <div class="dti-row">Monthly income: {linkCalculation.annualIncome} &divide; 12 = <b>{linkCalculation.monthlyIncome}</b></div>
                    <div class="dti-row">Monthly debt payment before this loan: {linkCalculation.p1BaseDtiExcl}% of {linkCalculation.monthlyIncome} = <b>{linkCalculation.p1ExistingDebt}</b></div>
                    <div class="dti-row"><b>{linkCalculation.p1LoanAmount}</b> loan adds <b>{linkCalculation.p1LoanPayment}</b>/monthly debt payment({linkCalculation.loanTermsShort}).</div>
                    <div class="dti-row">Monthly debt payment with the loan: {linkCalculation.p1ExistingDebt} + {linkCalculation.p1LoanPayment} = <b>{linkCalculation.p1CurrentDebt}</b> &rarr; DTI = {linkCalculation.p1CurrentDebt} &divide; {linkCalculation.monthlyIncome} = <b>{linkCalculation.p1CurrentDti}%</b></div>
                    {#if linkCalculation.incomeChanged}
                      <div class="dti-row">New monthly income: {linkCalculation.newAnnualIncome} &divide; 12 = <b>{linkCalculation.newMonthlyIncome}</b></div>
                    {/if}
                    {#if linkCalculation.loanChanged}
                      <div class="dti-row">New loan of {linkCalculation.p2LoanAmount} {linkCalculation.loanIncreased ? 'raises' : 'drops'} the monthly payment from <b>{linkCalculation.p2OldLoanPayment}</b> to <b>{linkCalculation.p2NewLoanPayment}</b>.</div>
                    {/if}
                    {#if linkCalculation.revolChanged}
                      <div class="dti-row">New revolving balance adds: <b>{linkCalculation.p2RevolToDebt}</b> to debt.</div>
                    {/if}
                    <div class="dti-row">New total monthly debt payment: {linkCalculation.foldDebtExpr} = <b>{linkCalculation.foldNewTotalDebt}</b></div>
                    <div class="dti-row">{linkCalculation.hasManualDti ? 'DTI from your inputs' : 'New DTI'}: {linkCalculation.foldNewTotalDebt} &divide; {linkCalculation.finalIncome} = <b>{linkCalculation.propagatedDtiPct}%</b></div>
                    {#if linkCalculation.hasManualDti}
                      <div class="dti-row">Your manual change: <b>{linkCalculation.manualDtiDelta}%</b></div>
                      <div class="dti-line final">New DTI: {linkCalculation.propagatedDtiPct} {linkCalculation.manualDtiSign} {linkCalculation.manualDtiDeltaMag} = <b>{linkCalculation.displayedDtiPct}%</b></div>
                    {/if}
                  {:else}
                    <div class="dti-row">Your monthly income: {linkCalculation.annualIncome} &divide; 12 = <b>{linkCalculation.monthlyIncome}</b></div>
                    <div class="dti-row">Your current DTI is {linkCalculation.currentDti}%, so your current monthly debt is: {linkCalculation.monthlyIncome} &times; {linkCalculation.currentDti}% = <b>{linkCalculation.currentMonthlyDebt}</b></div>
                    {#if linkCalculation.incomeChanged}
                      <div class="dti-row">Your changed monthly income now: {linkCalculation.newAnnualIncome} &divide; 12 = <b>{linkCalculation.newMonthlyIncome}</b></div>
                    {/if}
                    {#if linkCalculation.loanChanged}
                      <div class="dti-row">Your changed loan of {linkCalculation.loanAmount} {linkCalculation.loanIncreased ? 'raises' : 'lowers'} its monthly payment from <b>{linkCalculation.originalLoanPayment}</b> to <b>{linkCalculation.newLoanPayment}</b>, a change of <b>{linkCalculation.loanPaymentDelta}</b> to your monthly debt (based on your <b>{linkCalculation.paymentPeriod}</b>-month payment period and the <b>{linkCalculation.aprPercent}%</b> interest rate for your loan purpose, <b>{linkCalculation.loanPurpose}</b>).</div>
                    {/if}
                    {#if linkCalculation.revolChanged}
                      <div class="dti-row">Your revolving-balance change adjusts monthly debt by <b>{linkCalculation.revolDelta}</b>.</div>
                    {/if}
                    {#if linkCalculation.debtChanged}
                      <div class="dti-row">New total monthly debt payment: {linkCalculation.debtEquation} = <b>{linkCalculation.totalDebt}</b></div>
                    {/if}
                    <div class="dti-row">{linkCalculation.hasManualDti ? 'DTI from your inputs' : 'New DTI'}: {linkCalculation.totalDebt} &divide; {linkCalculation.finalIncome} = <b>{linkCalculation.propagatedDtiPct}%</b></div>
                    {#if linkCalculation.hasManualDti}
                      <div class="dti-row">Your manual change: <b>{linkCalculation.manualDtiDelta}%</b></div>
                      <div class="dti-line final">New DTI: {linkCalculation.propagatedDtiPct} {linkCalculation.manualDtiSign} {linkCalculation.manualDtiDeltaMag} = <b>{linkCalculation.displayedDtiPct}%</b></div>
                    {/if}
                  {/if}
                </div>
              {:else if linkCalculation?.type === 'revol_bal'}
                <div class="link-calculation dti-calc">
                  <div class="dti-line">Current revolving balance: {linkCalculation.currentBalance}</div>
                  <div class="dti-line">Loan amount applied: {linkCalculation.loanApplied}</div>
                  <div class="dti-line">New revolving balance: {linkCalculation.currentBalance} &minus; {linkCalculation.loanApplied} = {linkCalculation.newBalance}</div>
                  <div class="dti-line final">Revolving balance decreases from {linkCalculation.currentBalance} to {linkCalculation.newBalance}</div>
                </div>
              {:else if linkCalculation?.type === 'revol_util'}
                <div class="link-calculation dti-calc">
                  <div class="dti-line">Credit limit: {linkCalculation.creditLimit} (= current revolving balance {linkCalculation.currentBalance} ÷ current credit utilization {linkCalculation.currentUtil})</div>
                  <div class="dti-line">New revolving balance: {linkCalculation.newBalance}</div>
                  <div class="dti-line">New credit utilization: {linkCalculation.newBalance} ÷ {linkCalculation.creditLimit} × 100 = {linkCalculation.newUtil}</div>
                  <div class="dti-line final">Credit utilization decreases from {linkCalculation.originalUtil} to {linkCalculation.newUtil}</div>
                </div>
              {:else if linkCalculation?.type === 'mort_acc'}
                <div class="link-calculation dti-calc">
                  <div class="dti-line">Your home ownership is set to &ldquo;Mortgage,&rdquo; which accounts for one mortgage.</div>
                </div>
              {/if}
            {:else}
              The mechanism behind the change will appear here
            {/if}
          </div>
        </div>
      {/if}

      <div
        class="card-icons"
        class:collapsed={isCollapsed}
        on:click={resetClicked}
        on:mouseenter={openResetTip}
        on:mouseleave={closeResetTip}
      >
        <div class="svg-icon icon-refresh" />
        {#if resetTipOpen}
          <div class="reset-tooltip">
            <div class="reset-tip-line">Reset</div>
            {#if resetTipNames.length > 0}
              <div class="reset-tip-warn">
                &#9888;&#65039; will also reset these connected features: {resetTipNames.join(', ')}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Card-level expand affordance: a chevron + "Click to edit" text that
           advertises the WHOLE card expands to reveal the value selectors. Kept
           visually distinct from the inner breakdown chevrons (those live inside the
           info "i" popup and carry no text). Display-only — the header's on:click
           already toggles expand/collapse; this is just the discoverability cue. -->
      <div class="expand-hint" class:expanded={!isCollapsed} aria-hidden="true">
        {#if isCollapsed}<span class="expand-hint-text">Click to edit</span>{/if}
        <span class="expand-hint-chevron">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6l-6 6"/></svg>
        </span>
      </div>
    </div>

    <div class="values">
      {#if state.feature.originalValue === state.feature.curValue}
        <span class="value-label">
          {displayLevel(state, state.feature.originalValue)}
        </span>
      {:else}
        <span class="value-label">
          {displayLevel(state, state.feature.originalValue)}
        </span>

        <div class="feature-arrow">
          <div class="arrow-right" />
        </div>

        <span class="value-label">
          {displayLevel(state, state.feature.curValue)}
        </span>
      {/if}
    </div>

    {#if floorHint}
      <div class="floor-hint" in:fade={{ duration: 150 }}>{floorHint}</div>
    {/if}
  </div>

  <div
    class="feature-hist"
    class:collapsed={isCollapsed}
    class:expanded={isExpanded}
  >
    <!-- Value grid: (1) value name, (2) round radio to pick ONE value to try,
         (3) square checkbox to mark one or more acceptable values. Replaces the
         old SVG bar chart / value-distribution view. -->
    <div class="cat-value-table">
      <div class="cat-row cat-head">
        <span class="cat-col-value">Value</span>
        <span
          class="cat-col-pick"
          title="Pick ONE value to try in this plan"
          >Try</span
        >
        <span
          class="cat-col-accept"
          title="Allow one or more values for regenerated plans"
          >Accept</span
        >
      </div>

      {#each state.feature.histEdge as edge (edge)}
        <div
          class="cat-row"
          class:is-current={edge === state.feature.curValue}
        >
          <span class="cat-col-value">
            {displayLevel(state, edge)}
            {#if edge === state.feature.originalValue}
              <span class="cat-badge orig">original</span>
            {/if}
            {#if edge === state.feature.coachValue && edge !== state.feature.originalValue}
              <span class="cat-badge coach">suggested</span>
            {/if}
          </span>

          <span class="cat-col-pick">
            <input
              type="radio"
              name={`cat-single-${state.feature.featureName}`}
              aria-label={`Try ${displayLevel(state, edge)}`}
              checked={edge === state.feature.curValue}
              on:change={() => selectSingleValue(edge)}
            />
          </span>

          <span class="cat-col-accept">
            <input
              type="checkbox"
              aria-label={`Accept ${displayLevel(state, edge)}`}
              checked={state.feature.searchValues.has(edge)}
              on:change={() => toggleAcceptableValue(edge)}
            />
          </span>
        </div>
      {/each}
    </div>
  </div>

  <div
    class="configuration"
    class:constrained={feature === null ? false : feature.isConstrained}
    class:collapsed={isCollapsed}
    class:expanded={isExpanded}
    on:click={headerClicked}
  >
    <!-- The "New plans consider .." acceptable-range tag was removed from
         categorical feature cards by request. -->

    <!-- Interactive difficulty selector (emoji): moved here from the top of the
         card, sitting to the LEFT of the difficulty name. stopPropagation keeps
         the config bar's headerClicked from toggling the card. -->
    <div
      class="feature-difficulty"
      title="Specify how easy for you to change this feature"
      on:click|stopPropagation={diffClickedHandler}
    >
      <div class={`icon icon-${feature.difficulty}`}>
        {@html difficultyIconMap[feature.difficulty]}
      </div>
    </div>

    <span
      class="tag difficulty-tag"
      class:shown={feature.difficulty !== 'neutral'}
    >
      {difficultyTextMap[feature.difficulty]}
      <div class="local-tooltip">
        <span class="content"
          >New strategies will prioritize features that are easy for you to
          change</span
        >
      </div>
    </span>
  </div>
</div>

<style lang="scss">
  @import '../feature-card/FeatureCard.scss';
  @import './FeatureCardCat.scss';
</style>
