<script>
  // @ts-check
  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG, round } from '../../utils/utils';
  import '../../typedef';
  import { onMount, tick, createEventDispatcher } from 'svelte';
  import { tooltipConfigStore, diffPickerConfigStore, featureValueOverrideStore, cardToggleStore } from '../../store';

  import {
    initSlider,
    initHist,
    initHistSize,
    moveThumb,
    syncRangeTrack
  } from './FeatureCard';
  import {
    titleMouseenterHandler,
    titleMouseleaveHandler
  } from '../feature-card-cat/FeatureCardCat';

  import rightArrowIcon from '../../img/icon-right-arrow.svg';
  import rangeThumbLeftIcon from '../../img/icon-range-thumb-left.svg';
  import rangeThumbRightIcon from '../../img/icon-range-thumb-right.svg';
  import rangeThumbMiddleIcon from '../../img/icon-range-thumb-middle.svg';
  import easyIcon from '../../img/icon-easy.svg';
  import veryEasyIcon from '../../img/icon-very-easy.svg';
  import neutralIcon from '../../img/icon-neutral.svg';
  import hardIcon from '../../img/icon-hard.svg';
  import veryHardIcon from '../../img/icon-very-hard.svg';
  import lockIcon from '../../img/icon-lock.svg';
  import infoIcon from '../../img/icon-info.svg';
  import closeIcon from '../../img/icon-close.svg';
  import refreshIcon from '../../img/icon-refresh.svg';

  /** @type {Feature} */
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
  const formatter = d3.format(',.2~f');

  state.tickXScale = null;
  state.histSVG = null;
  state.densityClip = null;
  state.showingAnnotation = null;
  state.logger = logger;

  /** @type {Feature}*/
  state.featurePtr = feature;

  state.feature = {
    name: '',
    featureName: '',
    description: '',
    valueMin: 0,
    valueMax: 0,
    requiresInt: false,
    transformFunc: null,
    transform: null,
    /** @type {string | number}*/
    originalValue: 0,
    /** @type {string | number}*/
    curValue: 0,
    /** @type {string | number}*/
    coachValue: 0,
    curMin: 0,
    curMax: 0,
    histEdge: null,
    histCount: null,
    id: 0
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
  diffPickerConfigStore.subscribe((value) => {
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
        acceptableRange: feature.acceptableRange
      });
    }

    diffPickerConfig = value;
  });

  let tooltipConfig = null;
  tooltipConfigStore.subscribe((value) => {
    tooltipConfig = value;
  });

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
        acceptableRange: feature.acceptableRange
      });
    }
  };
  state.featureUpdated = featureUpdated;

  // ── Direct value entry (continuous features) ────────────────────────────────
  // The displayed value doubles as an input: for an unchanged feature the single
  // value is editable; for a changed / suggested feature the value AFTER the
  // arrow is editable. Typed values are validated against the feature's ORIGINAL
  // full range (valueMin/valueMax, from the model bin edges) — not the draggable
  // acceptable range — so a value out of range is impossible.

  /** Internal curValue → display number (matches the value text rendering). */
  const dispNum = (val) =>
    state.feature.transform === null
      ? val
      : state.feature.requiresInt
      ? round(state.feature.transformFunc(val), 0)
      : state.feature.transformFunc(val);

  /** Display number → internal curValue (inverse of dispNum). */
  const toInternal = (disp) => {
    if (state.feature.transform === null) {
      return state.feature.requiresInt ? Math.round(disp) : disp;
    }
    // log10 features: internal is log10 of the display value.
    return disp > 0 ? Math.log10(disp) : state.feature.valueMin;
  };

  /** The string shown in the value input (formatted like the value text). Takes
   * the value as an argument so the template expression depends on
   * state.feature.curValue and Svelte re-evaluates it on every change. */
  const valueInputStr = (val) => formatter(dispNum(val));

  /**
   * Apply a typed value: strip formatting, clamp to the ORIGINAL feature range,
   * enforce integer features, convert to internal units, move the slider, and
   * dispatch the change (same path the slider uses).
   */
  const applyValueInput = (rawStr) => {
    const cleaned = String(rawStr).replace(/[^0-9.\-]/g, '');
    let typed = parseFloat(cleaned);

    // Original full range in display units (independent of the draggable range).
    const dA = dispNum(state.feature.valueMin);
    const dB = dispNum(state.feature.valueMax);
    const dLo = Math.min(dA, dB);
    const dHi = Math.max(dA, dB);

    if (isNaN(typed)) {
      state = state; // invalid → revert the input to the current value
      return;
    }
    typed = Math.max(dLo, Math.min(dHi, typed)); // clamp — no out-of-range value
    if (state.feature.requiresInt) typed = Math.round(typed);

    const internal = toInternal(typed);
    if (internal === state.feature.curValue) {
      state = state; // unchanged (e.g. clamped back) → just re-sync the display
      return;
    }
    state.feature.curValue = internal;
    // Keep the slider thumb in sync when visible (same guard as the override path).
    if (histDrawn && state.tickXScale && isExpanded) {
      moveThumb(component, state, 'slider-middle-thumb', internal);
    }
    state.stateUpdated('value'); // re-render + dispatch curValueUpdated → propagation
  };

  /** Keyboard: Enter commits (blur), Escape reverts. */
  const valueInputKeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.currentTarget.value = valueInputStr(state.feature.curValue);
      e.currentTarget.blur();
    }
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
      description: featureInfo.description.description,
      requiresInt: feature.requiresInt,
      transformFunc:
        feature.transform === 'log10'
          ? feature.requiresInt
            ? (d) => round(Math.pow(10, d), 0)
            : (d) => Math.pow(10, d)
          : (d) => d,
      transform: feature.transform,
      originalValue: feature.originalValue,
      curValue: feature.hypotheticalValue !== undefined ? feature.hypotheticalValue : feature.coachValue,
      coachValue: feature.coachValue,
      curMin:
        feature.acceptableRange === null
          ? featureInfo.binEdge[0]
          : feature.acceptableRange[0],
      curMax:
        feature.acceptableRange === null
          ? featureInfo.binEdge[featureInfo.binEdge.length - 1]
          : feature.acceptableRange[1],
      valueMin: featureInfo.binEdge[0],
      valueMax: featureInfo.binEdge[featureInfo.binEdge.length - 1],
      histEdge: featureInfo.histEdge,
      histCount: featureInfo.histCount,
      id: feature.featureID,
      densityClip: null,
      stateUpdated: stateUpdated
    };

    state.logger = logger;

    if (feature.requiresInt) {
      state.feature.valueMin = Math.floor(state.feature.valueMin);
      state.feature.curMin = Math.floor(state.feature.curMin);
      state.feature.valueMax = Math.ceil(state.feature.valueMax);
      state.feature.curMax = Math.ceil(state.feature.curMax);
    }

    // We only init the svg size here so we can animate the height when user
    // clicks the header
    initHistSize(component, state);

    // Wait until the view is updated then automatically resize the feature name
    await tick();
    fitFeatureName();
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
   * Handler for the header click event
   * @param {MouseEvent} e Mouse event
   */
  export const headerClicked = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Notify FeaturePanel that a card is about to animate so it can recompute
    // arrow positions throughout the 250 ms expand/collapse animation.
    cardToggleStore.update(n => n + 1);

    logger?.addLog({
      eventName: `[${feature.data.name}] clicked`,
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
      if (!histDrawn) {
        // Init the density plot and ticks
        initHist(component, state);

        // Init the slider
        initSlider(component, state);

        histDrawn = true;
      } else if (!isExpanded) {
        // Card was already drawn but is now becoming visible again.
        // Re-sync the slider thumb: moveThumb calls made while the card was
        // collapsed used getBoundingClientRect() = 0 (hidden element), so the
        // thumb ended up at xPos = 0. Now that the card is visible we can
        // compute the correct pixel position.
        moveThumb(component, state, 'slider-middle-thumb', state.feature.curValue);
      }

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
  const displayAcceptableRange = (acceptableRange, stateFeature) => {
    let text = 'New plans consider from ';
    let curMin = stateFeature.valueMin;
    let curMax = stateFeature.valueMax;

    if (acceptableRange !== null) {
      curMin = acceptableRange[0];
      curMax = acceptableRange[1];
    }

    if (state.feature.transform !== null) {
      if (state.feature.requiresInt) {
        curMin = round(state.feature.transformFunc(curMin), 0);
        curMax = round(state.feature.transformFunc(curMax), 0);
      } else {
        (curMin = state.feature.transformFunc(curMin)), 0;
        (curMax = state.feature.transformFunc(curMax)), 0;
      }
    }

    text = text.concat(`${formatter(curMin)} to ${formatter(curMax)}`);

    return text;
  };

  /**
   * Handler for the reseat button click event.
   * @param {MouseEvent} e Mouse event
   */
  const resetClicked = (e) => {
    e.preventDefault();
    e.stopPropagation();

    logger?.addLog({
      eventName: `[${state.feature.featureName}] reset clicked`,
      elementName: 'reset'
    });

    // Reset the configuration and current values
    const leftThumbID = 'slider-left-thumb';
    const rightThumbID = 'slider-right-thumb';
    const middleThumbID = 'slider-middle-thumb';

    // Move two range thumbs to the left and right ends
    moveThumb(component, state, leftThumbID, state.feature.valueMin);
    moveThumb(component, state, rightThumbID, state.feature.valueMax);
    feature.acceptableRange = null;

    syncRangeTrack(component, state);

    // Change difficulty to default
    feature.difficulty = 'neutral';
    feature.isConstrained = false;

    // RESET_TO_LOAD_STATE: do NOT move the middle thumb here (that would fire
    // curValueUpdated as an edit and trigger propagation). Dispatch a reset so
    // FeaturePanel restores this feature and its sources/dependents to their
    // load-time snapshot values; the restored value comes back via the override
    // store and repositions the middle thumb.
    dispatch('curValueUpdated', {
      newValue: state.feature.coachValue,
      isReset: true
    });

    // Propagate the change to FeaturePanel
    dispatch('constraintUpdated', {
      difficulty: feature.difficulty,
      acceptableRange: feature.acceptableRange
    });
  };

  onMount(() => {
    // Bind the SVG icons on mount
    const iconList = [
      { class: 'icon-right-arrow', svg: rightArrowIcon },
      { class: 'icon-range-thumb-left', svg: rangeThumbLeftIcon },
      { class: 'icon-range-thumb-right', svg: rangeThumbRightIcon },
      { class: 'icon-range-thumb-middle', svg: rangeThumbMiddleIcon },
      { class: 'icon-info', svg: infoIcon },
      { class: 'icon-close', svg: closeIcon },
      { class: 'icon-refresh', svg: refreshIcon }
    ];
    bindInlineSVG(component, iconList);
    mounted = true;
  });

  // When FeaturePanel computes a propagated value for this feature,
  // update the slider position (if expanded) and the internal state (if collapsed).
  $: {
    const featureName = feature?.data?.name;
    if (featureName && initialized) {
      const overrideVal = $featureValueOverrideStore[featureName];
      if (overrideVal !== undefined && overrideVal !== null) {
        // Store as hypothetical value — never overwrites coachValue so the
        // green "suggested change" mark on the histogram stays at the original
        // coach suggestion for features in the Suggested Changes panel, and
        // remains absent for features outside it.
        feature.hypotheticalValue = overrideVal;
        state.feature.curValue = overrideVal;
        // Only call moveThumb when the card is expanded and visible.
        // When collapsed, getBoundingClientRect() returns 0 for the slider
        // track, making xPos = 0 (thumb snaps to left) while the SVG
        // density-user-mark (which uses a pre-computed tickXScale) updates
        // correctly — causing a mismatch. We defer the visual sync to the
        // moment the card is re-expanded (see headerClicked below).
        if (histDrawn && state.tickXScale && isExpanded) {
          moveThumb(component, state, 'slider-middle-thumb', overrideVal);
        }
      }
    }
  }

  $: feature && mounted && !initialized && initFeatureCard();
</script>

<div class="feature-card" bind:this={component} class:collapsed={isCollapsed} class:highlighted={modified} data-feature-name={feature?.data?.name}>
  <div
    class="feature-header"
    class:collapsed={isCollapsed}
    on:click={headerClicked}
  >
    <div class="top-row">
      <div
        class="feature-info"
        on:mouseenter={(e) =>
          titleMouseenterHandler(
            e,
            tooltipConfig,
            tooltipConfigStore,
            state.feature.description
          )}
        on:mouseleave={(e) =>
          titleMouseleaveHandler(e, tooltipConfig, tooltipConfigStore)}
      >
        <span class="feature-name">
          {state.feature.name}
        </span>
      </div>

      {#if isLinked}
        <div class="link-icon" on:click|stopPropagation on:mouseenter={linkIconMouseEnter}>
          <span class="link-chain-wrap">
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
                {#if linkCalculation.engaged}
                  <div class="link-calculation dti-calc">
                    <div class="dti-subhead">Your score breakdown</div>
                    <div class="dti-row">Your profile score: <b>{linkCalculation.profileFICO}</b></div>
                    {#if linkCalculation.showManualRow}
                      <div class="dti-row">Adjusted by you: <b>{linkCalculation.ficoManualDelta}</b></div>
                    {/if}
                    {#if linkCalculation.isClamped}
                      {#if linkCalculation.showPenaltyRow}
                        <div class="dti-row">Credit checks from new accounts, mortgages, and inquiries: <b>{linkCalculation.hardInquiries} total</b> (4 points each) &mdash; enough to reach the minimum score</div>
                      {/if}
                      <div class="dti-line final">New score: <b>662</b> &mdash; the lowest score possible. More accounts or inquiries won&rsquo;t lower it further.</div>
                    {:else}
                      {#if linkCalculation.showPenaltyRow}
                        <div class="dti-row">Credit checks from new accounts, mortgages, and inquiries: <b>{linkCalculation.hardInquiries} total</b> (4 points each), accounts for <b>&minus;{linkCalculation.rawPenalty} points</b></div>
                      {/if}
                      <div class="dti-line final">New score: <b>{linkCalculation.newScoreExpr}</b></div>
                    {/if}
                  </div>
                {/if}
              {:else if linkCalculation?.type === 'dti'}
                <div class="link-calculation dti-calc">
                  <!-- <div class="dti-title">What makes up your DTI?</div> -->
                  <div class="dti-line">Your DTI is your total monthly debt divided by your monthly income of <b>{linkCalculation.monthlyIncome}</b>.</div>
                  <div class="dti-subhead">Your debt breakdown</div>
                  <div class="dti-row">Existing debt (from your profile): <b>{linkCalculation.baseDebt}/month</b></div>
                  {#if linkCalculation.showLoanRow}
                    <div class="dti-row">Loan you&rsquo;re applying for ({linkCalculation.loanAmount}): <b>+{linkCalculation.loanPayment}/month</b></div>
                  {/if}
                  {#if linkCalculation.showRevolRow}
                    <div class="dti-row">Revolving balance change:<br /><b>{linkCalculation.revolvingDelta}/month</b></div>
                  {/if}
                  <div class="dti-line final">Total monthly debt: {#if linkCalculation.hasContributors}{linkCalculation.debtSumExpr} = {/if}<b>{linkCalculation.totalDebt}</b> &rarr; DTI = {#if linkCalculation.showManualDti}{linkCalculation.computedDTI}% {linkCalculation.dtiManualDelta}% (you adjusted) = {/if}<b>{linkCalculation.newDTI}%</b>, i.e., {linkCalculation.newDTI}% of your income goes to debt payment.</div>
                  <div class="dti-footnote">Your loan&rsquo;s monthly payment also depends on its purpose (for the interest rate), payment period (loan length), and Credit utilization which rises and falls with your revolving balance.</div>
                </div>
              {:else if linkCalculation?.type === 'revol_bal'}
                {#if linkCalculation.engaged}
                  <div class="link-calculation dti-calc">
                    <div class="dti-subhead">Your revolving balance breakdown</div>
                    <div class="dti-row">Your profile balance: <b>{linkCalculation.profileBalance}</b></div>
                    {#if linkCalculation.showManualRow}
                      <div class="dti-row">Adjusted by you: <b>{linkCalculation.manualDelta}</b></div>
                    {/if}
                    {#if linkCalculation.showUtilRow}
                      <div class="dti-row">From your credit utilization change: <b>{linkCalculation.utilDrivenDelta}</b></div>
                    {/if}
                    <div class="dti-line final">Total: {#if linkCalculation.hasContributors}{linkCalculation.balanceSumExpr} = {/if}<b>{linkCalculation.newBalance}</b>, i.e., you owe {linkCalculation.newBalance} on revolving credit.</div>
                  </div>
                {/if}
              {:else if linkCalculation?.type === 'revol_util'}
                {#if linkCalculation.engaged}
                  <div class="link-calculation dti-calc">
                    {#if linkCalculation.hasLimit}
                      <div class="dti-subhead">Your utilization breakdown</div>
                      <div class="dti-row">Your credit limit: <b>{linkCalculation.creditLimit}</b> (estimated from your revolving balance {linkCalculation.currentBalance} &divide; current utilization {linkCalculation.currentUtilization}%)</div>
                      <div class="dti-row">New revolving balance: <b>{linkCalculation.newBalance}</b></div>
                      <div class="dti-row">New utilization: {linkCalculation.newBalance} &divide; {linkCalculation.creditLimit} &times; 100 = <b>{linkCalculation.newUtilization}%</b></div>
                    {/if}
                    {#if linkCalculation.changeVerb === 'stayed at'}
                      <div class="dti-line final">Your credit utilization stayed at <b>{linkCalculation.newUtilization}%</b>, i.e., you&rsquo;re using {linkCalculation.newUtilization}% of your available credit.</div>
                    {:else}
                      <div class="dti-line final">Your credit utilization {linkCalculation.changeVerb} from <b>{linkCalculation.currentUtilization}%</b> to <b>{linkCalculation.newUtilization}%</b>, i.e., you&rsquo;re using {linkCalculation.newUtilization}% of your available credit.</div>
                    {/if}
                  </div>
                {/if}
              {:else if linkCalculation?.type === 'open_acc'}
                <div class="link-calculation dti-calc">
                  <div class="dti-subhead">Your open accounts breakdown</div>
                  <div class="dti-row">Open accounts in your profile: <b>{linkCalculation.profileOpen}</b></div>
                  {#if linkCalculation.showOpenRow}
                    <div class="dti-row">Open accounts you added directly: <b>{linkCalculation.openManualDelta}</b></div>
                  {/if}
                  {#if linkCalculation.showMortgageRow}
                    <div class="dti-row">{linkCalculation.mortgagePlural ? 'Mortgages you added' : 'Mortgage you added'}: <b>+{linkCalculation.mortgageDelta}</b></div>
                  {/if}
                  <div class="dti-line final">Total open accounts: <b>{linkCalculation.newOpenAccounts}</b></div>
                </div>
              {:else if linkCalculation?.type === 'total_acc'}
                <div class="link-calculation dti-calc">
                  <div class="dti-subhead">Your account breakdown</div>
                  <div class="dti-row">Accounts in your profile: <b>{linkCalculation.profileAccounts}</b></div>
                  {#if linkCalculation.showOpenRow}
                    <div class="dti-row">{linkCalculation.openPlural ? 'Open accounts you added' : 'Open account you added'}: <b>{linkCalculation.openAccountsDelta}</b></div>
                  {/if}
                  {#if linkCalculation.showMortgageRow}
                    <div class="dti-row">{linkCalculation.mortgagePlural ? 'Mortgages you added' : 'Mortgage you added'}: <b>+{linkCalculation.mortgageDelta}</b></div>
                  {/if}
                  {#if linkCalculation.showAccountsRow}
                    <div class="dti-row">Adjusted by you: <b>{linkCalculation.accountsManualDelta}</b></div>
                  {/if}
                  <div class="dti-line final">Total accounts: <b>{linkCalculation.newTotalAccounts}</b></div>
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
        title="Reset"
      >
        <div class="svg-icon icon-refresh">
          <!-- <div class='local-tooltip'>
            <span class='content'>Reset</span>
          </div> -->
        </div>
      </div>
    </div>

    <div class="values">
      {#if state.feature.originalValue === state.feature.curValue}
        <!-- Unchanged: the single value doubles as an editable input. -->
        <input
          class="value-old value-input"
          type="text"
          inputmode="decimal"
          value={valueInputStr(state.feature.curValue)}
          title="Type a value within this feature's range"
          on:change={(e) => applyValueInput(e.currentTarget.value)}
          on:keydown|stopPropagation={valueInputKeydown}
          on:click|stopPropagation
          on:mousedown|stopPropagation
        />
      {:else}
        <span class="value-old">
          {state.feature.transform === null
            ? formatter(state.feature.originalValue)
            : formatter(
                state.feature.requiresInt
                  ? round(
                      state.feature.transformFunc(state.feature.originalValue),
                      0
                    )
                  : state.feature.transformFunc(state.feature.originalValue)
              )}
        </span>

        <div
          class="feature-arrow"
          class:user={state.feature.curValue !== state.feature.userValue &&
            state.feature.curValue !== state.feature.coachValue}
        >
          <span
            class="value-change"
            class:user={state.feature.curValue !== state.feature.userValue &&
              state.feature.curValue !== state.feature.coachValue}
          >
            {(() => {
              // Figure out the sign
              const sign =
                state.feature.curValue - state.feature.originalValue < 0
                  ? ''
                  : '+';

              if (state.feature.transform === null) {
                const diff = state.feature.curValue - state.feature.originalValue;
                return `${sign}${formatter(diff)}`;
              } else {
                let curDiff =
                  state.feature.transformFunc(state.feature.curValue) -
                  state.feature.transformFunc(state.feature.originalValue);
                if (state.feature.requiresInt) {
                  curDiff =
                    round(
                      state.feature.transformFunc(state.feature.curValue),
                      0
                    ) -
                    round(
                      state.feature.transformFunc(state.feature.originalValue),
                      0
                    );
                }
                return `${sign}${formatter(curDiff)}`;
              }
            })()}
          </span>

          <div class="arrow-right" />
        </div>

        <!-- Changed / suggested: the value AFTER the arrow is the editable input. -->
        <input
          class="value-new value-input"
          type="text"
          inputmode="decimal"
          value={valueInputStr(state.feature.curValue)}
          title="Type a value within this feature's range"
          on:change={(e) => applyValueInput(e.currentTarget.value)}
          on:keydown|stopPropagation={valueInputKeydown}
          on:click|stopPropagation
          on:mousedown|stopPropagation
        />
      {/if}
    </div>

    <div
      class="feature-slider"
      class:collapsed={isCollapsed}
      class:expanded={isExpanded}
      on:click={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div class="track">
        <div class="range-track" />

        <div
          id="slider-left-thumb"
          tabindex="-1"
          class="svg-icon icon-range-thumb-left thumb"
        >
          <div class="thumb-label thumb-label-left">
            <span class="thumb-label-span"
              >{formatter(state.feature.curMin)}</span
            >
          </div>
        </div>

        <div
          id="slider-right-thumb"
          tabindex="-1"
          class="svg-icon icon-range-thumb-right thumb"
        >
          <div class="thumb-label thumb-label-right">
            <span class="thumb-label-span"
              >{formatter(state.feature.curMax)}</span
            >
          </div>
        </div>

        <div
          id="slider-middle-thumb"
          tabindex="-1"
          class="svg-icon icon-range-thumb-middle thumb"
        >
          <div class="thumb-label thumb-label-middle">
            <span class="thumb-label-span"
              >{formatter(state.feature.curValue)}</span
            >
          </div>
        </div>
      </div>
    </div>
  </div>

  <div
    class="feature-hist"
    class:collapsed={isCollapsed}
    class:expanded={isExpanded}
  >
    <svg class="svg-hist" />

    <div class="feature-annotations">
      <div class="annotation annotation-name show">
        <div class="svg-icon icon-info" />
        <span>Value Distribution of All Users</span>
        <div class="feature-difficulty" on:click={() => diffClickedHandler()}>
          <div
            class={`icon icon-${feature.difficulty}`}
            title="Specify how easy for you to change this feature"
          >
            {@html difficultyIconMap[feature.difficulty]}
          </div>
        </div>
      </div>

      <div class="annotation annotation-user">Your Hypothetical Value</div>

      <div class="annotation annotation-original">Your Original Value</div>

      <div class="annotation annotation-coach">GAM Coach Suggestion</div>

      <div class="annotation annotation-range">Your Acceptable Range</div>
    </div>
  </div>

  <div
    class="configuration"
    class:constrained={feature === null ? false : feature.isConstrained}
    class:collapsed={isCollapsed}
    class:expanded={isExpanded}
    on:click={headerClicked}
  >
    <span
      class="tag acceptable-tag"
      class:shown={feature.acceptableRange !== null}
    >
      {displayAcceptableRange(feature.acceptableRange, state.feature)}
      <div class="local-tooltip">
        <span class="content"
          >New strategies will only consider options within this range</span
        >
      </div>
    </span>

    <span
      class="tag difficulty-tag"
      class:shown={feature.difficulty !== 'neutral'}
    >
      <div class={`icon icon-${feature.difficulty}`}>
        {@html difficultyIconMap[feature.difficulty]}
      </div>
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
  @import './FeatureCard.scss';
</style>
