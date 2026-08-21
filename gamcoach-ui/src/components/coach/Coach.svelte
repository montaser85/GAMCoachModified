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
  import { foldAppliedLoanIntoDti } from '../../engine/params.mjs';
  import {
    Plan,
    Constraints,
    initPlans,
    regeneratePlans,
    PLAN_NOTE_FIELDS
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
    featureValueOverrideStore,
    planRationaleStore
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

  // True while plan generation is in flight (initial or regenerate) — drives the
  // "Generating your plans…" loading state so a participant never faces an
  // unexplained blank/frozen panel during a slow (regeneration-heavy) generation.
  let generating = false;

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

    // Fold the applied-for loan into the applicant's baseline DTI at the single
    // source point, so generation, scoring, and the feature-panel baseline all use
    // the same loan-included DTI.
    const baselineExample = foldAppliedLoanIntoDti(
      curExample,
      curModelData.features.map((f) => f.name)
    );

    // Initialize the Constraints based on the info provided by model developers
    // Creating the constraints object can change the modelData (setting
    // the acceptance range based on the curExample)
    constraints = new Constraints(curModelData, baselineExample);

    constraintsStore.set(constraints);
    unsubscribes.push(
      constraintsStore.subscribe((value) => {
        constraints = value;
      })
    );

    // Initialize the plans (show the "Generating your plans…" state meanwhile).
    generating = true;
    try {
      await initPlans(
        curModelData,
        ebm,
        baselineExample,
        constraints,
        plansUpdated,
        logger
      );
    } finally {
      generating = false;
    }

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

  // Whether the active plan currently clears the approval threshold (predProb ≥ 0.5,
  // i.e. predScore ≥ 0 — the same honesty rule the score readout uses; never the
  // rounded percentage). Saving is gated on this so a bookmark is always an approved
  // plan. Reacts to live edits via the store subscription.
  $: activePlanApproved =
    $activePlanStore && $activePlanStore.ebmLocal
      ? $activePlanStore.ebmLocal.predScore >= 0
      : false;

  // The star is disabled whenever the live plan is below approval — regardless of
  // whether it's already saved. A sub-50% plan can't be bookmarked, and an
  // already-saved plan whose live edits fall below 50% gets the same "blocked" star
  // (the frozen bookmark stays put; remove it from the Bookmarks panel if needed).
  $: starDisabled = !activePlanApproved;
  $: starTitle = starDisabled
    ? 'Reach 50% approval to save this plan'
    : activePlanSaved
      ? 'Click to remove this plan from the saved plans'
      : 'Click to save this plan';

  // ── Per-plan rationale (expandable multi-question note, "Add your note") ─────
  // Each plan's note is an object keyed by the PLAN_NOTE_FIELDS questions, read from
  // the per-plan store by the active plan index — so switching plans shows that
  // plan's own answers and switching back retains them. Editing is write-through to
  // the store; it is decoupled from plan values, so feature edits, resets, and the
  // {#key} remount never disturb it. The expand/open state is UI-only (Sets keyed by
  // plan index / "index|key"); it lives above the {#key} block so it survives
  // switches too.
  let planNoteOpen = new Set();    // plan indices whose note editor is expanded
  let planNoteFields = new Set();  // "planIndex|fieldKey" of open question textareas

  $: activeNote =
    plans !== null && $planRationaleStore
      ? $planRationaleStore.get(plans.activePlanIndex) || {}
      : {};

  const hasPlanNote = (note) =>
    !!note && Object.values(note).some((v) => v && String(v).trim());
  const planAnsweredCount = (note) =>
    note ? Object.values(note).filter((v) => v && String(v).trim()).length : 0;

  const togglePlanNoteOpen = (idx) => {
    if (planNoteOpen.has(idx)) planNoteOpen.delete(idx);
    else planNoteOpen.add(idx);
    planNoteOpen = planNoteOpen;
  };
  const togglePlanField = (idx, key) => {
    const id = `${idx}|${key}`;
    if (planNoteFields.has(id)) planNoteFields.delete(id);
    else planNoteFields.add(id);
    planNoteFields = planNoteFields;
  };

  // Write-through a single question's answer (raw, so typing is never fought).
  const setPlanNoteField = (key, value) => {
    if (plans === null) return;
    const idx = plans.activePlanIndex;
    planRationaleStore.update((m) => {
      const cur = { ...(m.get(idx) || {}) };
      cur[key] = value;
      m.set(idx, cur);
      return m;
    });
  };
  // On blur: drop empty answers so the "N answered" count stays honest.
  const cleanupPlanNote = () => {
    if (plans === null) return;
    const idx = plans.activePlanIndex;
    planRationaleStore.update((m) => {
      const cur = m.get(idx);
      if (!cur) return m;
      const cleaned = {};
      for (const [k, v] of Object.entries(cur)) {
        if (v && String(v).trim()) cleaned[k] = v;
      }
      m.set(idx, cleaned);
      return m;
    });
  };

  /** Focus a field's textarea as soon as it opens. */
  const noteAutofocus = (node) => { node.focus(); };
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
      on:regenerateClicked={async () => {
        generating = true;
        try {
          await regeneratePlans(
            constraints,
            curModelData,
            curExample,
            plans,
            plansUpdated,
            logger
          );
        } finally {
          generating = false;
        }
      }}
    />
  </div>

  <div class="two-column">
    {#if generating}
      <!-- Plan generation in flight — honest progress feedback so the panel is
           never an unexplained blank/frozen screen. -->
      <div class="plan-loading">
        <div class="plan-loading-spinner" />
        <div class="plan-loading-text">Generating your plans…</div>
        <div class="plan-loading-sub">This can take a few moments.</div>
      </div>
    {:else}
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
            class:disabled={starDisabled}
            on:click={(e) => coachPanel && coachPanel.starActivePlan(e)}
            title={starTitle}
          >
            <div class="svg-icon tab-icon" class:no-display={!activePlanSaved}>
              {@html starIconSolid}
            </div>
            <div class="svg-icon tab-icon" class:no-display={activePlanSaved}>
              {@html starIconOutline}
            </div>
          </div>

          <!-- Per-plan rationale header — sits in the plan row, right beside the plan
               name / star. The multi-question editor (the same tap-to-open reflection
               style history used to have) expands BELOW the row. The note is attached
               to the PLAN, kept per-plan (planRationaleStore, keyed by plan index),
               and frozen into the receipt on save. -->
          <button
            class="note-head"
            on:click={() => togglePlanNoteOpen(plans.activePlanIndex)}
          >
            <span class="gt-arrow">{planNoteOpen.has(plans.activePlanIndex) ? '▾' : '▸'}</span>
            <span class="note-pencil">✎</span>
            <span class="note-label">{hasPlanNote(activeNote) ? 'Edit your note' : 'Add your note'}</span>
            {#if planAnsweredCount(activeNote) > 0}
              <span class="answered-badge">{planAnsweredCount(activeNote)} answered</span>
            {/if}
          </button>
        </div>

        <!-- The note questions expand below the plan row (full width of the column). -->
        {#if planNoteOpen.has(plans.activePlanIndex)}
          <div class="plan-note-fields">
            {#each PLAN_NOTE_FIELDS as f (f.key)}
              <div class="note-q">
                <button class="q-row" on:click={() => togglePlanField(plans.activePlanIndex, f.key)}>
                  <span class="q-icon">{planNoteFields.has(`${plans.activePlanIndex}|${f.key}`) ? '−' : '＋'}</span>
                  <span class="q-text">{f.label}</span>
                </button>
                {#if planNoteFields.has(`${plans.activePlanIndex}|${f.key}`)}
                  <textarea
                    class="q-input"
                    rows="3"
                    use:noteAutofocus
                    value={activeNote[f.key] ?? ''}
                    on:input={(e) => setPlanNoteField(f.key, e.target.value)}
                    on:blur={cleanupPlanNote}
                  ></textarea>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
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
    {/if}
  </div>
</div>

<!-- History Sidebar -->
<HistorySidebar
  activePlanIndex={plans?.activePlanIndex || 0}
  onRestoreEntry={handleRestoreEntry}
/>

<style lang="scss">
  @import '../../define';

  .plan-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    width: 100%;
    min-height: 340px;
    padding: 60px 20px;
    text-align: center;

    .plan-loading-spinner {
      width: 40px;
      height: 40px;
      border: 4px solid $gray-200;
      border-top-color: $blue-600;
      border-radius: 50%;
      animation: plan-loading-spin 0.9s linear infinite;
    }

    .plan-loading-text {
      font-size: 1.05rem;
      font-weight: 700;
      color: $gray-900;
    }

    .plan-loading-sub {
      font-size: 0.85rem;
      color: $gray-500;
    }
  }

  @keyframes plan-loading-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .main-content-wrapper {
    display: flex;
    flex-direction: column;
    // The History sidebar is a fixed overlay pinned to the right edge (width 320px)
    // and does not overlap the main visualization panel, so opening it must NOT
    // contract the main content — the panel stays exactly as it is.
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
    // Always reserve the scrollbar's space so the column width (and the score
    // bar inside it) never jumps when the scrollbar appears/disappears.
    scrollbar-gutter: stable;
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

  /* Editability hint under the plan dropdown, above the feature list. */
  /* Per-plan rationale header — a compact tap target that sits IN the plan row,
     right beside the plan-name dropdown and the save star. The multi-question
     editor (ported from the old history reflection style) expands below the row. */
  .note-head {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 4px 6px;
    background: none;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    color: $gray-600;
    transition: background-color 100ms ease-in-out;
    &:hover {
      color: $gray-900;
      background-color: adjust-color($color: $gray-200, $lightness: -4%);
    }

    .gt-arrow {
      flex: 0 0 auto;
      font-size: 0.8rem;
      line-height: 1;
    }
    .note-pencil {
      flex: 0 0 auto;
      font-size: 0.85rem;
    }
    .note-label {
      font-size: 0.85rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .answered-badge {
      flex: 0 0 auto;
      font-size: 0.7rem;
      font-weight: 600;
      color: $gray-500;
      background: $gray-100;
      border: 1px solid $gray-200;
      border-radius: 9px;
      padding: 1px 7px;
      line-height: 1.5;
    }
  }

  /* The expandable questions — below the plan row, full column width. */
  .plan-note-fields {
    margin: 0 2px 4px;
    padding-top: 4px;

    .note-q {
      border-top: 1px solid $gray-100; /* thin dividers between question rows */
      &:first-child { border-top: none; }

      .q-row {
        display: flex;
        align-items: baseline;
        gap: 7px;
        width: 100%;
        padding: 6px 0;
        background: none;
        border: none;
        cursor: pointer;
        text-align: left;

        .q-icon {
          width: 12px;
          flex: 0 0 auto;
          font-size: 0.85rem;
          color: $gray-400;
        }
        .q-text {
          font-size: 0.85rem;
          color: $gray-600;
        }
        &:hover .q-text { color: $gray-900; }
      }

      .q-input {
        display: block;
        width: 100%;
        box-sizing: border-box;
        margin: 0 0 8px 19px;
        max-width: calc(100% - 19px);
        min-height: 54px;
        resize: vertical; /* multi-line, vertically resizable */
        padding: 6px 8px;
        font-size: 0.85rem;
        font-family: inherit;
        line-height: 1.4;
        color: $gray-800;
        border: 1px solid $gray-300;
        border-radius: 5px;
        background: $gray-50;

        &:focus {
          outline: none;
          border-color: $blue-500;
          background: white;
        }
      }
    }
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

      // Sub-50% and not yet saved: cannot bookmark. Dim it, block the pointer, and
      // suppress the hover affordance so it reads as unavailable.
      &.disabled {
        cursor: not-allowed;
        opacity: 0.4;

        &:hover {
          background-color: transparent;
        }
        .tab-icon {
          cursor: not-allowed;
        }
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
