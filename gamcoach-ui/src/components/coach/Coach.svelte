<script>
  //@ts-check
  import FeaturePanel from '../feature-panel/FeaturePanel.svelte';
  import CoachPanel from '../coach-panel/CoachPanel.svelte';
  import HistorySidebar from '../history-sidebar/HistorySidebar.svelte';
  import ScoreReadout from '../score-readout/ScoreReadout.svelte';
  import ScoreDrivers from '../score-readout/ScoreDrivers.svelte';

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

  // Goal label for the plan-goal selector, moved from CoachPanel into the left
  // column. Mirrors CoachPanel's "a" → "an" vowel adjustment.
  $: goalLabel = (() => {
    const base = 'Strategies to get a';
    if (!plans) return base;
    const vowels = ['a', 'e', 'i', 'o', 'u'];
    const first = plans.isRegression
      ? (plans.regressionName || '')[0]
      : (plans.classes && plans.classes[0] ? plans.classes[0][0] : '');
    return first && vowels.includes(first.toLowerCase()) ? base + 'n' : base;
  })();
</script>

<div class="main-content-wrapper" class:sidebar-open={$historySidebarOpenStore}>
  <div class="coach-panel-wrapper">
    <CoachPanel
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
    <!-- Left panel: plan-goal selector → "New plans can change …" control (in
         FeaturePanel) → the feature list. Scrolls independently. -->
    <div class="left-column">
      {#if plans !== null}
        <div class="plan-goal">
          <span>{goalLabel}</span>
          {#if plans.isRegression}
            <span class="tab-keyword">{plans.regressionName}</span>
            <span>from</span>
            <input type="number" step="any" id="goal-from" />
            <span>to</span>
            <input type="number" step="any" id="goal-to" />
          {:else}
            <div class="select">
              <select>
                {#each plans.classes as c, i}
                  {#if plans.classTarget.includes(i)}
                    <option value={i}>{c}</option>
                  {/if}
                {/each}
              </select>
            </div>
          {/if}
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

    <!-- Right panel: score readout, then the "what's driving this score"
         decomposition section; rest reserved for later tasks. -->
    <div class="right-column">
      {#if plans !== null}
        <ScoreReadout planStore={activePlanStore} />
        <div class="rc-drivers">
          <ScoreDrivers planStore={activePlanStore} />
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
  }

  .rc-drivers {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid $gray-200;
  }

  .feature-panel-wrapper {
    position: relative;
    z-index: 1;
    width: 100%;
  }

  /* Plan-goal selector, relocated from CoachPanel to the top of the left column */
  .plan-goal {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    font-size: 0.9rem;
    color: $gray-700;
    padding: 2px 2px 8px;
    border-bottom: 1px solid $gray-200;

    .tab-keyword { font-weight: 600; }
    input { width: 70px; padding: 1px; margin: 0; }

    .select {
      position: relative;
      border-radius: 4px;
      border: 1px solid $gray-light-border;
      background: $gray-50;

      select {
        padding: 1px 20px 1px 6px;
        margin: 0;
        border: none;
        background: transparent;
        font-size: 0.9rem;
        cursor: pointer;
        -moz-appearance: none;
        -webkit-appearance: none;
      }
      &::after {
        content: '';
        position: absolute;
        right: 7px;
        top: 50%;
        width: 0;
        height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-top: 5px solid $gray-500;
        transform: translateY(-50%);
        pointer-events: none;
      }
    }
  }
</style>
