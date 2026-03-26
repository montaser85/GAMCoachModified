<script>
  // @ts-check
  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG, round } from '../../utils/utils';
  import '../../typedef';
  import { onMount, tick, createEventDispatcher } from 'svelte';
  import { tooltipConfigStore, diffPickerConfigStore, featureValueOverrideStore } from '../../store';

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

  /** Explanatory text shown in the link popup (empty = default placeholder) */
  export let linkPopupText = '';

  /** Optional calculation to display: { before: number, after: number }
   *  Renders as "before − delta = after" beneath the popup text */
  export let linkCalculation = null;

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

    // Change the current value to coach value or original value
    moveThumb(component, state, middleThumbID, state.feature.coachValue);

    syncRangeTrack(component, state);

    // Change difficulty to default
    feature.difficulty = 'neutral';
    feature.isConstrained = false;

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

<div class="feature-card" bind:this={component} class:collapsed={isCollapsed} data-feature-name={feature?.data?.name}>
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
          </svg>
          <div class="link-popup">
            {#if linkPopupText}
              <p class="link-popup-text">{linkPopupText}</p>
              {#if linkCalculation?.type === 'fico'}
                <div class="link-calculation">
                  {linkCalculation.before} &minus; 4 = {linkCalculation.after}
                </div>
              {:else if linkCalculation?.type === 'dti'}
                <div class="link-calculation dti-calc">
                  <div class="dti-line">Current monthly debt: {linkCalculation.currentDebt}</div>
                  <div class="dti-line">New loan payment: {linkCalculation.newLoanPayment}</div>
                  <div class="dti-line">New monthly debt: {linkCalculation.currentDebt} + {linkCalculation.newLoanPayment} = {linkCalculation.newMonthlyDebt}</div>
                  <div class="dti-line final">As monthly debt rises from {linkCalculation.currentDebt} to {linkCalculation.newMonthlyDebt}, DTI increases from {linkCalculation.originalDTI} to {linkCalculation.newDTI}</div>
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
        class:hidden={state.feature.originalValue === state.feature.curValue}
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

      <span
        class="value-new"
        class:hidden={state.feature.originalValue === state.feature.curValue}
      >
        {state.feature.transform === null
          ? formatter(state.feature.curValue)
          : formatter(
              state.feature.requiresInt
                ? round(state.feature.transformFunc(state.feature.curValue), 0)
                : state.feature.transformFunc(state.feature.curValue)
            )}
      </span>
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
