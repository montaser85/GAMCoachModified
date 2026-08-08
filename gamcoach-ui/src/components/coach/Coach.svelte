<script>
  //@ts-check
  import FeaturePanel from '../feature-panel/FeaturePanel.svelte';
  import CoachPanel from '../coach-panel/CoachPanel.svelte';
  import HistorySidebar from '../history-sidebar/HistorySidebar.svelte';
  import ScoreReadout from '../score-readout/ScoreReadout.svelte';
  import ScoreDrivers from '../score-readout/ScoreDrivers.svelte';
  import IdeasToTry from '../ideas/IdeasToTry.svelte';
  import ChangeEffects from '../change-effects/ChangeEffects.svelte';

  import starIconSolid from '../../img/icon-star-solid.svg';
  import starIconOutline from '../../img/icon-star-outline.svg';

  import { EBM } from '../../ebm/ebm';
  import {
    Plan,
    Constraints,
    initPlans,
    regeneratePlans
  } from '../coach/Coach';
  import '../../typedef';

  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { onMount, onDestroy, tick } from 'svelte';
  import { writable } from 'svelte/store';
  import { fade, fly } from 'svelte/transition';
  import {
    tooltipConfigStore,
    inputFormConfigStore,
    ebmStore,
    constraintsStore,
    bookmarkConfigStore,
    historySidebarOpenStore,
    historyEntriesStore,
    isRestoringEntryStore,
    propagatedFeaturesStore,
    featureValueOverrideStore
  } from '../../store';

  // import modelDataLC from '../../config/data/lc-classifier.json';

  export let modelName = 'lc';
  // export let curModelData = modelDataLC;
  export let windowLoaded = false;
  export let curExample = null;

  /** @type {Logger} */
  export let logger = null;

  let initialized = false;
  let restorationCounter = 0;  // Used to force FeaturePanel re-render on restoration
  const unsubscribes = [];

  // CoachPanel instance — used to invoke its plan-switch / star handlers from the
  // plan dropdown that now lives at the top of the left column (see below).
  let coachPanel = null;

  // Set up tooltip
  let tooltip = null;
  let tooltipConfig = null;
  unsubscribes.push(
    tooltipConfigStore.subscribe((value) => {
      tooltipConfig = value;
    })
  );

  // Set up the input form config store
  let inputFormConfig = null;
  unsubscribes.push(
    inputFormConfigStore.subscribe((value) => (inputFormConfig = value))
  );

  // Set up the GAM Coach object
  let curModelData = null;

  /** @type {EBM} */
  let ebm = null;

  /** @type {Plans} */
  let plans = null;

  /** @type {Constraints} */
  let constraints = null;

  /**
   * Workaround to trigger an update to the plans variable.
   * @param {Plans} newPlans
   */
  const plansUpdated = (newPlans) => {
    plans = newPlans;
  };

  /**
   * Load the model and populate the plans.
   */
  const initModel = async () => {
    initialized = true;

    // Load the model data
    curModelData = await d3.json(
      `PUBLIC_URL/data/${modelName}-classifier.json`
    );
    // console.log(modelData);

    // Initialize an ebm model
    ebm = new EBM(curModelData);
    ebmStore.set(ebm);

    // Re-initialize the bookmark config
    const bookmarkConfig = {
      show: false,
      features: null,
      plans: new Map(),
      focusOutTime: 0,
      plansInfo: null
    };
    bookmarkConfigStore.set(bookmarkConfig);

    // Initialize the Constraints based on the info provided by model developers
    // Creating the constraints object can change the modelData (setting
    // the acceptance range based on the curExample)
    constraints = new Constraints(curModelData, curExample);

    constraintsStore.set(constraints);
    unsubscribes.push(
      constraintsStore.subscribe((value) => {
        constraints = value;
      })
    );

    // Initialize the plans
    await initPlans(
      curModelData,
      ebm,
      curExample,
      constraints,
      plansUpdated,
      logger
    );

    // Initialize the input form
    // inputFormConfig.ebm = ebm;
    // inputFormConfig.curExample = curExample;
    // inputFormConfigStore.set(inputFormConfig);

    // Log the plans
    logger?.addRecord('plans', plans);
  };

  onMount(() => {});

  onDestroy(() => {
    unsubscribes.forEach((unsub) => unsub());
  });

  /**
   * Restore a plan to a saved history state
   */
  const handleRestoreEntry = async (entry) => {
    if (!plans || entry.planIndex === undefined) return;

    const planIndex = entry.planIndex;
    const planStore = plans.planStores.get(planIndex);
    if (!planStore) return;

    // Get current plan from store
    let plan;
    const unsubscribe = planStore.subscribe((value) => {
      plan = value;
    });
    unsubscribe();

    if (!plan) return;

    // Restore ALL feature values from the complete state stored in the entry
    // Use allFeatureValues which contains the complete model state at that entry
    if (entry.allFeatureValues) {
      let updateCount = 0;

      // Use updateFeature which handles all necessary updates and triggering
      for (const feature of plan.features) {
        const featureID = feature.featureID;
        const restoredValue = entry.allFeatureValues[featureID];

        if (restoredValue !== undefined) {
          const featureName = feature.data?.name;
          if (featureName) {
            plan.ebmLocal.updateFeature(featureName, restoredValue);
            updateCount++;
          }

          // CRITICAL: Set hypotheticalValue to the restored value so FeatureCard
          // initializes with the correct restored value when remounting
          feature.hypotheticalValue = restoredValue;
        }
      }
    }

    // Clear propagated features since we're in a clean restored state
    propagatedFeaturesStore.set(new Set());

    // Clear feature value overrides to ensure FeaturePanel shows the restored values
    featureValueOverrideStore.set({});

    // IMPORTANT: Set the restoration flag BEFORE updating the plan
    // This tells the history system to skip creating a new entry when the plan updates
    isRestoringEntryStore.set(true);

    // Update the plan store to trigger reactivity
    // Use update() instead of set() to ensure proper notification
    planStore.update(() => plan);

    // Reset the restoration flag after a brief delay to let the store update complete
    setTimeout(() => {
      isRestoringEntryStore.set(false);
    }, 50);

    // Wait for Svelte to process the planStore update before triggering the FeaturePanel re-render
    // This ensures the updated plan values are available when FeaturePanel subscribes
    await tick();

    // Increment restoration counter to force FeaturePanel re-render
    restorationCounter++;

    // Update history: move restored entry to the end and renumber all entries
    historyEntriesStore.update((historyMap) => {
      const entries = historyMap.get(planIndex) || [];

      // Find the index of the restored entry by matching the exact entry object or entryNumber
      let restoredEntryIndex = -1;
      for (let i = 0; i < entries.length; i++) {
        // Match by entryNumber and score to be sure we have the right entry
        if (entries[i].entryNumber === entry.entryNumber && entries[i].score === entry.score) {
          restoredEntryIndex = i;
          break;
        }
      }

      if (restoredEntryIndex !== -1) {
        // Remove the restored entry from its current position
        const restoredEntry = entries.splice(restoredEntryIndex, 1)[0];

        // Add it to the end
        entries.push(restoredEntry);

        // Renumber all entries sequentially
        entries.forEach((e, idx) => {
          e.entryNumber = idx + 1;
        });

        const newMap = new Map(historyMap);
        newMap.set(planIndex, [...entries]);
        return newMap;
      }

      return historyMap;
    });
  };


  $: curExample && !initialized && initModel();

  // ── Two-column layout helpers ──────────────────────────────────────────────
  // The active plan's store (shared by the left-column FeaturePanel and the
  // right-column ScoreReadout).
  $: activePlanStore =
    plans && plans.planStores.has(plans.activePlanIndex)
      ? plans.planStores.get(plans.activePlanIndex)
      : null;

  // Plan indices available in the dropdown (loaded plans only), sorted ascending.
  $: planIndices =
    plans !== null
      ? [...plans.planStores.keys()].sort((a, b) => a - b)
      : [];

  // Whether the active plan is currently bookmarked — drives the star icon.
  // Read from the shared bookmark store so it updates reactively when
  // CoachPanel's starActivePlan saves/removes the plan.
  $: activePlanSaved =
    plans !== null && $bookmarkConfigStore && $bookmarkConfigStore.plans
      ? $bookmarkConfigStore.plans.has(plans.activePlanIndex)
      : false;
</script>

<div class="main-content-wrapper" class:sidebar-open={$historySidebarOpenStore}>
  <div class="coach-panel-wrapper">
    <CoachPanel
      bind:this={coachPanel}
      {windowLoaded}
      bind:plans
      {logger}
      {ebm}
      modelData={curModelData}
      on:regenerateClicked={() =>
        regeneratePlans(
          constraints,
          curModelData,
          curExample,
          plans,
          plansUpdated,
          logger
        )}
    />
  </div>

  <div class="two-column">
    <!-- Left panel: plan dropdown + save star (aligned with the feature cards,
         parallel to the right-column score readout), then the feature list.
         Scrolls independently. -->
    <div class="left-column">
      {#if plans !== null}
        <div class="plan-row">
          <div class="select plan-select">
            <select
              on:change={(e) =>
                coachPanel && coachPanel.planSelected(parseInt(e.currentTarget.value))}
            >
              {#each planIndices as idx}
                <option value={idx} selected={idx === plans.activePlanIndex}>
                  Plan {idx}
                </option>
              {/each}
            </select>
          </div>

          <div
            class="star-wrapper"
            on:click={(e) => coachPanel && coachPanel.starActivePlan(e)}
            title="Click to save this plan"
          >
            <div class="svg-icon tab-icon" class:no-display={!activePlanSaved}>
              {@html starIconSolid}
            </div>
            <div class="svg-icon tab-icon" class:no-display={activePlanSaved}>
              {@html starIconOutline}
            </div>
          </div>
        </div>
      {/if}

      {#if plans === null}
        <div class="feature-panel-wrapper">
          <FeaturePanel {logger} planStore={null} {constraintsStore} />
        </div>
      {:else}
        {#key `${plans.activePlanIndex}-${restorationCounter}`}
          <div class="feature-panel-wrapper">
            <FeaturePanel
              {windowLoaded}
              {logger}
              planStore={activePlanStore}
              {constraintsStore}
            />
          </div>
        {/key}
      {/if}
    </div>

    <!-- Right panel band order: score readout → "what's driving this score" →
         "ideas to try" → "effects of your changes" (the propagation ripple). -->
    <div class="right-column">
      {#if plans !== null}
        <ScoreReadout planStore={activePlanStore} />
        <div class="rc-drivers">
          <ScoreDrivers planStore={activePlanStore} />
        </div>
        <IdeasToTry planStore={activePlanStore} />
        <div class="rc-effects">
          <ChangeEffects />
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- History Sidebar -->
<HistorySidebar
  activePlanIndex={plans?.activePlanIndex || 0}
  onRestoreEntry={handleRestoreEntry}
/>

<style lang="scss">
  @import '../../define';

  .main-content-wrapper {
    display: flex;
    flex-direction: column;
    transition: padding-right 200ms ease-out;
    padding-right: 0;

    &.sidebar-open {
      padding-right: 320px;
    }
  }

  .main-standalone {
    display: flex;
    flex-direction: column;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 10px;

    padding: 20px 0 20px 0;
    justify-content: center;
    align-items: center;

    height: calc(100vh - 20px);
    max-height: 800px;
    overflow-y: scroll;
    width: 100vw;
    box-sizing: border-box;
  }

  .coach-wrapper {
    border: 1px solid $gray-light-border;
    background: $gray-50;
    border-radius: $border-radius;
    box-shadow: 0px 2px 15px hsla(0, 0%, 0%, 0.07),
      0px 0px 5px hsla(0, 0%, 0%, 0.12);
    overflow: hidden;
    // width: 990px;
  }

  .coach-panel-wrapper {
    position: relative;
    z-index: 2;
    width: 100%;
  }

  /* ── Two-column body: narrow left (controls + features) + flexible right ── */
  .two-column {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: 16px;
    padding: 12px 14px 14px;
    width: 100%;
    box-sizing: border-box;
  }

  .left-column {
    flex: 0 0 324px;
    width: 324px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .right-column {
    flex: 1 1 auto;
    min-width: 0;
    padding-top: 2px;
    // Match the left column (plan row + 600px feature panel) and scroll its own
    // content, so the lower bands (ideas / effects) stay reachable when they grow
    // instead of being clipped by the wrapper's overflow:hidden.
    max-height: 640px;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 6px;
  }

  .rc-drivers {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid $gray-200;
  }

  .rc-effects {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid $gray-200;
  }

  .feature-panel-wrapper {
    position: relative;
    z-index: 1;
    width: 100%;
  }

  /* Plan dropdown + save star — top of the left column, aligned with the
     feature cards and parallel to the right-column score readout. */
  .plan-row {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 0 2px 4px;

    .plan-select {
      select {
        font-size: 0.95rem;
        font-weight: 600;
        padding: 3px 22px 3px 10px;
        cursor: pointer;
      }
    }

    .star-wrapper {
      display: flex;
      align-items: center;
      border-radius: 5px;
      padding: 4px;
      cursor: pointer;
      transition: background-color 100ms ease-in-out;

      &:hover {
        background-color: adjust-color($color: $gray-200, $lightness: -4%);
      }

      .tab-icon {
        color: $gray-700;
        fill: $gray-700;
        display: flex;
        align-items: center;
        cursor: pointer;

        :global(svg) {
          width: 1rem;
          height: 1rem;
        }
      }

      .no-display {
        display: none;
      }
    }
  }

  /* Select control (borrowed from CoachPanel's .select) */
  .select {
    position: relative;
    border-radius: 4px;
    border: 1px solid $gray-light-border;
    background: $gray-50;

    select {
      margin: 0;
      border: none;
      background: transparent;
      -moz-appearance: none;
      -webkit-appearance: none;
    }

    &::after {
      content: '';
      display: block;
      position: absolute;
      right: 8px;
      top: 50%;
      width: 6px;
      height: 6px;
      pointer-events: none;
      border-right: 2px solid $gray-600;
      border-top: 2px solid $gray-600;
      transform: translateY(-65%) rotate(135deg);
      transform-origin: center;
    }
  }
</style>
