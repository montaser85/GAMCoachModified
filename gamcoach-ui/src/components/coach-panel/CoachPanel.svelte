<script>
  //@ts-check
  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG } from '../../utils/utils';
  import { onMount, onDestroy, tick, createEventDispatcher } from 'svelte';
  import {
    tooltipConfigStore,
    confirmModalConfigStore,
    bookmarkConfigStore,
    checkModalConfigStore,
    compareOpenStore,
    propagatedFeaturesStore,
    historyEntriesStore,
    historySidebarOpenStore,
    isRestoringEntryStore,
    constraintsStore,
    planRationaleStore
  } from '../../store';
  import { get } from 'svelte/store';
  import { createHistoryEntry, addHistoryEntry } from '../../utils/historyManager';

  import CompareModal from '../compare-modal/CompareModal.svelte';
  import ExampleModal from '../example-modal/ExampleModal.svelte';

  import '../../typedef';
  import { Plan, SavedPlan, TOTAL_PLAN_NUM } from '../coach/Coach';
  import { InitPlanLabels } from './CoachPanel';

  import refreshIcon from '../../img/icon-refresh2.svg';
  import starIconSolid from '../../img/icon-star-solid.svg';
  import starIconOutline from '../../img/icon-star-outline.svg';
  import checkIcon from '../../img/icon-check-box.svg';

  export let windowLoaded = false;
  /** @type {Logger} */
  export let logger = null;

  /** @type {Plans} */
  export let plans = null;

  /** @type {import('../../ebm/ebm').EBM} */
  export let ebm = null;

  export let modelData = null;

  // Component variables
  let component = null;
  let tooltipConfig = null;
  let mounted = false;

  const unsubscribes = [];
  let initialized = false;
  const NUM_TOTAL_PAN = 5;
  const dispatch = createEventDispatcher();

  // Set up the model goal labels
  let planLabels = [];
  let savedPlanIndex = new Set();

  // ── "New plans can change at most [N] features" control (Row 1) ──────────────
  // Relocated from FeaturePanel's row-header to the top toolbar row. Reads/writes
  // the same global constraintsStore, so the max-features preference behaves
  // exactly as before — only the control's location changed.
  /** @type {Constraints} */
  let constraints = null;
  let maxFeatureNum = 'null';
  let maxFeatureInit = false;
  unsubscribes.push(
    constraintsStore.subscribe((value) => {
      constraints = value;
      // Seed the dropdown from the constraints once they are available.
      if (constraints && !maxFeatureInit) {
        maxFeatureNum =
          constraints.maxNumFeaturesToVary === null
            ? 'null'
            : `${constraints.maxNumFeaturesToVary}`;
        maxFeatureInit = true;
      }
    })
  );

  /** @type {Map<number, Plan>} */
  const localPlans = new Map();
  // Incremented each time any plan store emits — passed to CompareModal so it
  // can reactively rebuild the comparison table without needing its own store subscriptions.
  let localPlansVersion = 0;

  // History tracking
  /** @type {Map<number, number>} Track previous score for each plan for history delta */
  const previousScores = new Map();
  /** @type {Map<number, object>} Track initial feature state (after coach suggestions loaded) */
  const initialFeatureStates = new Map();
  /** @type {Map<number, NodeJS.Timeout>} Track pending history entry timeouts */
  const pendingHistoryTimeouts = new Map();
  let propagatedFeatures = new Set();
  let isRestoringEntry = false;

  // ── Worked example ("Watch example") ───────────────────────────────────────
  // The always-visible button is the SOLE entry point: the modal only opens on
  // its click — no auto-hint, no auto-open, under any condition.
  let exampleOpen = false;
  const openExample = () => { exampleOpen = true; };

  // Set up tooltip
  unsubscribes.push(
    tooltipConfigStore.subscribe((value) => {
      tooltipConfig = value;
    })
  );

  // Track propagated features for history
  unsubscribes.push(
    propagatedFeaturesStore.subscribe((value) => {
      propagatedFeatures = value;
    })
  );

  // Track restoration state
  unsubscribes.push(
    isRestoringEntryStore.subscribe((value) => {
      isRestoringEntry = value;
    })
  );

  // Set up the regenerate confirm modal
  if (localStorage.getItem('needRegenerateConfirmV2') === null) {
    localStorage.setItem('needRegenerateConfirmV2', 'true');
  }

  if (localStorage.getItem('needSaveConfirm') === null) {
    localStorage.setItem('needSaveConfirm', 'true');
  }

  let confirmModalConfig = null;
  unsubscribes.push(
    confirmModalConfigStore.subscribe((value) => {
      confirmModalConfig = value;
    })
  );

  // Set up the bookmark store
  /** @type{BookmarkConfig} */
  let bookmarkConfig = null;
  unsubscribes.push(
    bookmarkConfigStore.subscribe((value) => {
      bookmarkConfig = value;

      if (bookmarkConfig.action === 'addUnpicked') {
        bookmarkConfig.unpickedPlans = new Map();
        const localIndexes = [...localPlans.keys()];
        for (let j = 0; j < localIndexes.length; j++) {
          const i = localIndexes[j];
          if (!bookmarkConfig.plans.has(i)) {
            const curPlan = localPlans.get(i);
            const savedPlan = new SavedPlan(
              curPlan.planIndex,
              curPlan.ebmLocal,
              curPlan.curExample
            );
            bookmarkConfig.unpickedPlans.set(i, savedPlan);
          }

          if (bookmarkConfig.unpickedPlans.size >= 2) {
            break;
          }
        }
        bookmarkConfig.action = undefined;
        bookmarkConfigStore.set(bookmarkConfig);
      }

      if (bookmarkConfig.action === 'delete') {
        // Sync up the bookmarked plans
        savedPlanIndex.forEach((planIndex) => {
          if (!bookmarkConfig.plans.has(planIndex)) {
            savedPlanIndex.delete(planIndex);
            savedPlanIndex = savedPlanIndex;
          }
        });
        bookmarkConfig.action = undefined;
        bookmarkConfigStore.set(bookmarkConfig);
      }
    })
  );

  const starClicked = (e, plan) => {
    e.preventDefault();
    e.stopPropagation();

    // Test if the plan is a success
    if (e.currentTarget.classList.contains('disabled')) {
      return;
    }

    // Log the interaction
    const oldValue = Array.from(savedPlanIndex);

    // Check if users have already saved this plan
    if (savedPlanIndex.has(plan.planIndex)) {
      // Remove the plan from the bookmarks
      bookmarkConfig.plans.delete(plan.planIndex);
      bookmarkConfigStore.set(bookmarkConfig);
      savedPlanIndex.delete(plan.planIndex);
    } else {
      // Warn the users that they are saving adjusted plans
      const curPlan = localPlans.get(plan.planIndex);

      if (curPlan.isChangedByUser) {
        const needSaveConfirm = localStorage.getItem('needSaveConfirm');
        if (needSaveConfirm === 'true') {
          confirmModalConfig = {
            title: `Plan ${plan.planIndex} Has Been Modified`,
            show: true,
            confirmed: true,
            contextLines: [
              `Plan ${plan.planIndex} has been modified by you. Saving this
               plan will <b> only save these new changes </b> instead of GAM
               Coach's initial suggested changes.`,
              `If you want to restore the initial changes, you can click the
               reset buttons in the extended feature cards.`
            ],
            confirmText: 'Save',
            cancelText: 'Cancel',
            doNotShowAgain: false,
            confirmCallback: (doNotShowAgain, confirmed) => {
              if (confirmed) {
                localStorage.setItem(
                  'needSaveConfirm',
                  doNotShowAgain ? 'false' : 'true'
                );
                // Save the new plan to the bookmark
                const savedPlan = new SavedPlan(
                  plan.planIndex,
                  curPlan.ebmLocal,
                  curPlan.curExample,
                  get(planRationaleStore).get(plan.planIndex) || {}
                );
                bookmarkConfig.plans.set(plan.planIndex, savedPlan);
                bookmarkConfigStore.set(bookmarkConfig);

                // Save the plan to the local record
                savedPlanIndex.add(plan.planIndex);
                savedPlanIndex = savedPlanIndex;
              }
            }
          };
          confirmModalConfigStore.set(confirmModalConfig);
          return;
        }
      }

      // Save the new plan to the bookmark
      const savedPlan = new SavedPlan(
        plan.planIndex,
        curPlan.ebmLocal,
        curPlan.curExample,
        get(planRationaleStore).get(plan.planIndex) || {}
      );
      bookmarkConfig.plans.set(plan.planIndex, savedPlan);
      bookmarkConfigStore.set(bookmarkConfig);

      // Save the plan to the local record
      savedPlanIndex.add(plan.planIndex);
    }
    savedPlanIndex = savedPlanIndex;

    logger?.addLog({
      eventName: 'plan starred',
      elementName: 'star',
      valueName: 'savedPlanIndex',
      oldValue: oldValue,
      newValue: Array.from(savedPlanIndex)
    });
  };

  /**
   * Handler for selecting a plan from the plan dropdown. Preserves the exact
   * plan-switching behavior of the old tabs — only the control changed. Exported
   * so the dropdown, now rendered by Coach.svelte at the top of the left column
   * (parallel to the score readout), can invoke it via `bind:this`.
   * @param planIndex {number} Plan index
   */
  export const planSelected = (planIndex) => {
    if (!plans.planStores.has(planIndex)) {
      return;
    }

    if (plans.activePlanIndex === planIndex) {
      return;
    }

    // Log the interaction
    logger?.addLog({
      eventName: `plan${planIndex} clicked`,
      elementName: 'tab'
    });

    plans.activePlanIndex = planIndex;
  };

  /**
   * Save/unsave the currently-active plan (star beside the plan dropdown).
   * Delegates to the same starClicked handler the old per-tab star used.
   * Exported for the same reason as planSelected (see above).
   * @param {MouseEvent} e
   */
  export const starActivePlan = (e) => {
    const activeLabel = planLabels.find(
      (p) => p.planIndex === plans.activePlanIndex
    );
    if (activeLabel) starClicked(e, activeLabel);
  };

  /**
   * Initialize the plan panel. This function should only be called after the
   * plan data is passed from the parent component.
   */
  const initPlanPanel = async () => {
    initialized = true;

    const returnObj = InitPlanLabels(plans, '');
    planLabels = returnObj.localPlanLabels;

    await tick();
  };

  /**
   * Handler when plan store is updated.
   * @param {Plan} value
   * @param {number} planIndex
   */
  const planStoreUpdated = (value, planIndex) => {
    localPlans.set(planIndex, value);
    localPlansVersion += 1; // triggers CompareModal reactive rebuild

    // Seed the bookmark / input-form feature list on the FIRST emission (before
    // the score-change early returns below). Saving a plan renders its change
    // list via SavedPlan.getChangeList(bookmarkConfig.features); if that feature
    // list is still null (no edit yet), the render throws and aborts the Svelte
    // flush — freezing all reactivity. Setting it here guarantees it's ready as
    // soon as a plan can be saved.
    if (bookmarkConfig && bookmarkConfig.features === null) {
      bookmarkConfig.features = value.features;
      bookmarkConfig.plansInfo = plans;
      bookmarkConfigStore.set(bookmarkConfig);
    }

    // ─── History tracking: capture entry if score changed ─────────────────
    const currentScore = value.ebmLocal.predScore;
    const previousScore = previousScores.get(planIndex);

    if (previousScore === undefined) {
      // First update: just record the score, don't create entry
      previousScores.set(planIndex, currentScore);
      return;
    }

    // If we're restoring an entry, skip history entry creation
    if (isRestoringEntry) {
      return;
    }

    // If score didn't change, do nothing
    if (previousScore === currentScore) {
      return;
    }

    // Score changed! Cancel any pending timeout for this plan
    const pendingTimeout = pendingHistoryTimeouts.get(planIndex);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
    }

    // IMPORTANT: Capture propagatedFeatures and currentScore NOW so we can create the entry
    // with the correct values 800ms later. If we wait, these values might change.
    const capturedPropagatedFeatures = new Set(propagatedFeatures);
    const capturedCurrentScore = currentScore;
    const capturedPreviousScore = previousScore;
    const capturedPlanValue = value;  // Capture the plan state too


    // Set a new timeout to create the entry after 800ms of no changes
    // This waits for the user to "settle" on a new value
    const newTimeout = setTimeout(() => {
      historyEntriesStore.update((historyMap) => {
        // Get the previous entry (if any) to compare against
        const previousEntry = (historyMap.get(planIndex) || []).slice(-1)[0] || null;

        // For the first entry, use the initial feature state (after coach suggestions)
        // not the original input values
        if (!previousEntry && !initialFeatureStates.has(planIndex)) {
          // Fallback: if initial state wasn't captured, use current sample
          const initialState = {};
          for (const feature of capturedPlanValue.features) {
            initialState[feature.featureID] = capturedPlanValue.ebmLocal.sample[feature.featureID];
          }
          initialFeatureStates.set(planIndex, initialState);
        }

        const entry = createHistoryEntry(
          planIndex,
          capturedPlanValue,  // Use the captured plan from when score changed
          capturedPropagatedFeatures,  // Use the captured propagation
          capturedPreviousScore,  // Use the captured previous score
          1,  // Will be renumbered by addHistoryEntry
          previousEntry,  // Pass previous entry as baseline
          !previousEntry ? initialFeatureStates.get(planIndex) : null  // Pass initial state for Entry 1
        );

        entry.planIndex = planIndex; // Store plan index for restoration

        return addHistoryEntry(historyMap, planIndex, entry);
      });

      // IMPORTANT: Clear propagatedFeaturesStore after entry is created
      // so the next direct change starts fresh without old propagation data
      propagatedFeaturesStore.set(new Set());

      pendingHistoryTimeouts.delete(planIndex);
    }, 800);

    // Update previousScore IMMEDIATELY so next change has correct baseline
    previousScores.set(planIndex, currentScore);

    // Track this timeout so we can cancel it if score changes again
    pendingHistoryTimeouts.set(planIndex, newTimeout);
  };

  /**
   * Handler when a new store is added to the plans object.
   */
  const planStoreAdded = () => {
    plans.planStores.forEach((planStore, planIndex) => {
      // Add this plan index to a local array and subscribe the store
      if (!localPlans.has(planIndex)) {
        // Initialize history tracking for this plan
        // Use undefined so first update won't create an entry
        previousScores.set(planIndex, undefined);

        let isFirstUpdate = true;
        unsubscribes.push(
          planStore.subscribe((value) => {
            // Capture the initial feature state on the very first update for this
            // plan. RE-BASELINE: the coach's suggestions are no longer applied to
            // any plan's ebmLocal/score — plans exist only to supply ideas — so we
            // snapshot the plan's baseline sample as-is (no fold).
            if (isFirstUpdate) {
              const initialState = {};
              for (const feature of value.features) {
                initialState[feature.featureID] = value.ebmLocal.sample[feature.featureID];
              }
              initialFeatureStates.set(planIndex, initialState);
              isFirstUpdate = false;
            }
            planStoreUpdated(value, planIndex);
          })
        );

      }
    });
  };

  /**
   * Handler for regenerate click event.
   */
  const regenerateClicked = () => {
    // Let users wait the current batch to finish or fail before starting the
    // next batch
    if (plans.failedPlans.size === 0 && localPlans.size !== TOTAL_PLAN_NUM) {
      alert(
        ''.concat(
          'Please wait until all pending plans are generated ',
          'before regenerating any new plans.'
        )
      );
      return;
    }

    // Show the confirm modal if it is the first time
    const needRegenerateConfirm = localStorage.getItem('needRegenerateConfirmV2');
    if (needRegenerateConfirm === 'true') {
      confirmModalConfig = {
        title: 'New Plans',
        show: true,
        confirmed: true,
        contextLines: [
          `After generating new plans, you will <b>lose access</b> to all current
          unsaved plans.`,
          'Make sure to click the star icons to save plans you like.'
        ],
        confirmText: 'New Plans',
        cancelText: 'Cancel',
        doNotShowAgain: false,
        confirmCallback: (doNotShowAgain, confirmed) => {
          if (confirmed) {
            localStorage.setItem(
              'needRegenerateConfirmV2',
              doNotShowAgain ? 'false' : 'true'
            );
            dispatchRegenerateClicked();
          }
        }
      };
      confirmModalConfigStore.set(confirmModalConfig);
    } else {
      dispatchRegenerateClicked();
    }
  };

  /**
   * Dispatch the regeneration click event to the parent.
   */
  const dispatchRegenerateClicked = () => {
    // Save two un-pinked plans for review during user study
    if (logger && plans.nextPlanIndex === 1 + TOTAL_PLAN_NUM) {
      bookmarkConfig.unpickedPlans = new Map();
      for (let i = 1; i < 1 + TOTAL_PLAN_NUM; i++) {
        if (!bookmarkConfig.plans.has(i)) {
          const curPlan = localPlans.get(i);
          const savedPlan = new SavedPlan(
            curPlan.planIndex,
            curPlan.ebmLocal,
            curPlan.curExample
          );
          bookmarkConfig.unpickedPlans.set(i, savedPlan);
        }

        if (bookmarkConfig.unpickedPlans.size >= 2) {
          break;
        }
      }
      bookmarkConfigStore.set(bookmarkConfig);
    }

    plans.activePlanIndex = plans.nextPlanIndex;

    // Make this component ready to be initialized again with new plans
    initialized = false;

    // Make this component listen to new stores
    plans.planStores.clear();
    localPlans.clear();

    dispatch('regenerateClicked');
  };

  /**
   * Toggle the bookmark panel
   */
  const bookmarkClicked = () => {
    // If the the bookmark is already shown, we hide it
    if (Date.now() - bookmarkConfig.focusOutTime < 200) {
      bookmarkConfig.show = false;
      bookmarkConfigStore.set(bookmarkConfig);
    } else {
      bookmarkConfig.show = true;
      bookmarkConfigStore.set(bookmarkConfig);

      // Log the interaction
      logger?.addLog({
        eventName: 'bookmark opened',
        elementName: 'bookmark'
      });
    }
  };

  /**
   * Toggle the plan comparison modal.
   */
  const compareClicked = () => {
    // Before "Done with Setup" there are no plans to compare, so keep the button
    // visible (no layout shift) but do not open the panel.
    if (plans === null) return;
    compareOpenStore.update(v => !v);
    logger?.addLog({ eventName: 'compare opened', elementName: 'compare' });
  };

  /**
   * Open the check modal for manual prediction testing
   */
  const checkClicked = () => {
    checkModalConfigStore.update(value => {
      value.show = true;
      value.ebm = ebm;
      value.modelData = modelData;
      return value;
    });

    // Log the interaction
    logger?.addLog({
      eventName: 'check modal opened',
      elementName: 'check'
    });
  };

  /**
   * Handler for the "New plans can change at most [N] features" dropdown.
   * Writes maxNumFeaturesToVary into the shared constraints (same behavior as
   * the control's previous home in FeaturePanel).
   */
  const maxFeatureNumChanged = () => {
    resizeFeatureSelect();

    if (constraints === null) return;

    const oldValue = constraints.maxNumFeaturesToVary;

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
   * Size the max-features select to fit the current option text.
   */
  const resizeFeatureSelect = () => {
    const optionMap = {
      null: 'any number of',
      1: 'at most one',
      2: 'at most two',
      3: 'at most three',
      4: 'at most four'
    };

    const hiddenSelect = d3
      .select(component)
      .select('#hidden-select')
      .style('display', 'initial');

    hiddenSelect.select('#hidden-option').text(optionMap[maxFeatureNum]);

    const selectWidth = hiddenSelect.node().clientWidth + 5 + 'px';
    hiddenSelect.style('display', 'none');

    d3.select(component).select('#feature-num-select').style('width', selectWidth);
  };

  onMount(() => {
    const iconList = [
      { class: 'icon-refresh', svg: refreshIcon },
      { class: 'icon-star-solid', svg: starIconSolid },
      { class: 'icon-star-outline', svg: starIconOutline },
      { class: 'icon-check-box', svg: checkIcon }
    ];
    bindInlineSVG(component, iconList);
    mounted = true;
  });

  onDestroy(() => {
    unsubscribes.forEach((unsub) => unsub());
    // Clean up any pending history timeouts
    pendingHistoryTimeouts.forEach((timeout) => {
      clearTimeout(timeout);
    });
    pendingHistoryTimeouts.clear();
  });

  $: windowLoaded && plans && !initialized && initPlanPanel();
  $: plans && localPlans.size !== NUM_TOTAL_PAN && planStoreAdded();
  // Keep the constraints in sync when the user picks a max-features option (and
  // size the select). Gated on mount + constraints so it never fires prematurely.
  $: mounted && constraints && maxFeatureNum && maxFeatureNumChanged();
</script>

<div class="coach-panel" bind:this={component}>
  <div class="coach-header">
    <div class="coach-logo">
      <img src="PUBLIC_URL/logo.svg" alt="GAM Coach" draggable="false" />
      <!-- <span class='coach-name'>GAM Coach</span> -->
      <span class="coach-tagline">
        Personal coach to help you obtain desired AI decisions
      </span>
    </div>
  </div>

  <!-- Row 1: action buttons (Compare · Watch example · History · Bookmarks ·
       Regenerate) with the "New plans can change at most N features" control at
       the far right. -->
  <div class="coach-toolbar-row">
    <div class="coach-controls">
      <div class="icon-wrapper" on:click={compareClicked} title="Compare all plans side by side">
        <svg class="compare-svg" viewBox="0 0 20 20" width="18" height="18"
             fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1.5" y="2.5" width="7" height="15" rx="1.5"/>
          <rect x="11.5" y="2.5" width="7" height="15" rx="1.5"/>
          <line x1="5" y1="6.5" x2="5" y2="6.5"/>
          <line x1="15" y1="6.5" x2="15" y2="6.5"/>
        </svg>
        <span class="icon-label">Compare Plans</span>
      </div>
      <!-- Watch example — persistent, subtle entry point -->
      <button class="watch-example-btn" on:click={openExample} title="Watch a short worked example">
        <svg viewBox="0 0 20 20" width="13" height="13" aria-hidden="true">
          <polygon points="5,3 17,10 5,17" fill="currentColor"/>
        </svg>
        Watch Example
      </button>
      <div class="icon-wrapper" on:click={() => historySidebarOpenStore.update(v => !v)} title="Your explorations">
        <svg class="history-svg" viewBox="0 0 24 24" width="18" height="18" style="fill: none;" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 8l0 4l2 2"/>
          <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/>
        </svg>
        <span class="icon-label">Your Explorations</span>
      </div>
      <div class="icon-wrapper" on:click={bookmarkClicked} title="Saved plans">
        <div class="svg-icon icon-star-outline" />
        <span class="icon-label">Saved Plans</span>
      </div>
<!-- To bring the Check Button back, just remove the style="display: none;" attribute -->
      <div class="icon-wrapper" on:click={checkClicked} title="Manual Prediction Check" style="display: none;">
        <div class="svg-icon icon-check-box" />
        <span class="icon-label">Check</span>
      </div>

      <div
        class="icon-wrapper"
        on:click={regenerateClicked}
        title="Generate new plans based on my configurations"
      >
        <div class="svg-icon icon-refresh" />
        <span class="icon-label">New Plans</span>
      </div>
    </div>

    <!-- "New plans can change at most [N] features" — relocated from FeaturePanel -->
    <span class="max-feature-control"><span class="mf-label">New plans<br />can change</span>
      <div class="select" id="hidden-select">
        <select>
          <option id="hidden-option"></option>
        </select>
      </div>
      <div class="select">
        <select id="feature-num-select" bind:value={maxFeatureNum}>
          <option value="null">any number of</option>
          <option value="1">at most one</option>
          <option value="2">at most two</option>
          <option value="3">at most three</option>
          <option value="4">at most four</option>
        </select>
      </div>
      {maxFeatureNum === '1' ? 'feature' : 'features'}
    </span>
  </div>

  <!-- The plan dropdown + save star are rendered by Coach.svelte at the top of
       the left column (aligned with the feature cards, parallel to the score
       readout), invoking planSelected / starActivePlan here via bind:this. -->

  <!-- Plan comparison modal — rendered inside coach-panel so it has access
       to localPlans and planLabels; position:fixed in CSS places it above all. -->
  <CompareModal
    {plans}
    {planLabels}
    {localPlans}
    {localPlansVersion}
    onSelectPlan={(idx) => { planSelected(idx); compareOpenStore.set(false); }}
  />

  <ExampleModal open={exampleOpen} onClose={() => { exampleOpen = false; }} />
</div>

<style lang="scss">
  @import './CoachPanel.scss';

  /* Compare button SVG icon — inherits current-color from .icon-wrapper */
  .compare-svg {
    display: block;
    color: inherit;
  }
</style>
