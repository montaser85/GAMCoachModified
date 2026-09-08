<script>
  //@ts-check
  import FeaturePanel from '../feature-panel/FeaturePanel.svelte';
  import CoachPanel from '../coach-panel/CoachPanel.svelte';
  import HistorySidebar from '../history-sidebar/HistorySidebar.svelte';
  import ScoreReadout from '../score-readout/ScoreReadout.svelte';
  import ScoreDrivers from '../score-readout/ScoreDrivers.svelte';
  import IdeasToTry from '../ideas/IdeasToTry.svelte';
  import ChangeEffects from '../change-effects/ChangeEffects.svelte';

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
  import { writable, get } from 'svelte/store';
  import { fade, fly } from 'svelte/transition';
  import {
    tooltipConfigStore,
    ebmStore,
    constraintsStore,
    bookmarkConfigStore,
    historySidebarOpenStore,
    historyEntriesStore,
    isRestoringEntryStore,
    propagatedFeaturesStore,
    featureValueOverrideStore,
    planRationaleStore,
    restoreIdeasStore
  } from '../../store';

  // import modelDataLC from '../../config/data/lc-classifier.json';

  export let modelName = 'lc';
  // export let curModelData = modelDataLC;
  export let windowLoaded = false;
  export let curExample = null;
  /** When true, the setup panel starts BLANK (an input form): empty continuous
   *  fields, categoricals defaulted to their first value, and no difficulty —
   *  instead of a dataset profile. Cleared once the user loads one via refresh. */
  export let blankStart = false;

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

  // ── First-time in-card setup (Change 2) ─────────────────────────────────────
  // Before any plans exist, the user enters/adjusts all 20 feature values
  // directly in the cards (a lightweight, non-generated "setup plan"), then
  // clicks "Done with Setup" to lock the baseline and run generation. No
  // propagation and no score are shown during setup; only the loan→DTI fold is
  // applied at Save (inside initModel).
  let setupMode = true;
  let setupEntered = false;
  // True once "Done with Setup" is clicked: hides the banner/button and keeps the
  // (frozen) setup cards on screen while generation runs, so the whole panel is
  // not replaced by a blank loading screen — the "Generating…" message shows in
  // the empty right column instead.
  let setupSubmitted = false;
  /** @type {import('svelte/store').Writable<Plan>|null} */
  let setupPlanStore = null;
  /** Live value of setupPlanStore (kept via subscription; drives the Done gate). */
  let setupPlanCur = null;
  /** Baseline (internal-value array) the user entered in setup; null before Done. */
  let enteredBaseline = null;
  /** The loan-folded baseline the plans were generated from (set in initModel).
   *  Reused by Regenerate so new plans start from the user's own profile. */
  let generationBaseline = null;

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

    // Load the model data (reuse it if setup already loaded it).
    if (!curModelData) {
      curModelData = await d3.json(
        `PUBLIC_URL/data/${modelName}-classifier.json`
      );
    }

    // Initialize an ebm model (reuse if setup already built it).
    if (!ebm) {
      ebm = new EBM(curModelData);
      ebmStore.set(ebm);
    }

    // Re-initialize the bookmark config
    const bookmarkConfig = {
      show: false,
      features: null,
      plans: new Map(),
      focusOutTime: 0,
      plansInfo: null
    };
    bookmarkConfigStore.set(bookmarkConfig);

    // The locked baseline: the values the user entered during setup, else the
    // starting sample. Fold the applied-for loan into its DTI at this single
    // source point, so generation, scoring, and the feature-panel baseline all use
    // the same loan-included DTI. This is the ONE baseline shift at Save.
    const base = enteredBaseline || curExample;
    const baselineExample = foldAppliedLoanIntoDti(
      base,
      curModelData.features.map((f) => f.name)
    );
    // Remember this loan-folded baseline so REGENERATE reuses the exact same starting
    // point (the user's entered / loaded profile) instead of the raw #XYZ prop — the
    // curExample prop still holds the placeholder profile, which is not what the plans
    // should be generated from.
    generationBaseline = baselineExample;

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
        logger,
        // The ORIGINAL (pre-fold) profile — its own DTI, before the applied loan is
        // folded in — so the original score reflects the user's actual profile.
        base
      );
    } finally {
      generating = false;
    }

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

    // Restore the ideas as they were at this entry. The dismissed set is what the
    // rebuilt ideas derive from (so later edits behave correctly), and restoreIdeasStore
    // hands FeaturePanel the exact captured ideas to display on its restore-remount —
    // a plain recompute can't reproduce the entry's view. Old entries (pre-snapshot)
    // have no ideas/dismissed fields; then we skip this and fall back to the recompute.
    if (Array.isArray(entry.dismissedIdeaNames)) {
      plan.dismissedIdeaNames = new Set(entry.dismissedIdeaNames);
    }
    if (Array.isArray(entry.ideas)) {
      restoreIdeasStore.set({
        planIndex,
        ideas: entry.ideas.map((i) => ({ ...i }))
      });
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

  /**
   * Restore the ACTIVE plan to its POST-SETUP initial state — the baseline the app
   * locked in at "Done with Setup" and keeps per-plan as `plan.curExample` (already
   * loan-folded; no snapshot needed to add). Resets the live sample to that baseline,
   * clears the plan's applied/dismissed ideas, and remounts the FeaturePanel so the
   * score, feature values, ideas, breakdowns, and the affected-features panel all
   * rebuild to the initial state. Reuses the existing baseline — it does not touch
   * setup or idea-generation logic. Mirrors handleRestoreEntry's reset+remount path.
   */
  const handleRestoreInitial = async () => {
    if (!plans) return;
    const planIndex = plans.activePlanIndex;
    const planStore = plans.planStores.get(planIndex);
    if (!planStore) return;

    const plan = get(planStore);
    if (!plan || !plan.curExample) return;

    // Reset every feature's live value to its post-setup baseline value.
    for (const feature of plan.features) {
      const baselineValue = plan.curExample[feature.featureID];
      if (baselineValue === undefined) continue;
      const featureName = feature.data?.name;
      if (featureName) plan.ebmLocal.updateFeature(featureName, baselineValue);
      feature.hypotheticalValue = baselineValue;
    }

    // Bring the ideas list back to the original suggested set.
    plan.dismissedIdeaNames = new Set();

    // Restoring the initial ideas means this plan is back at its post-setup baseline,
    // so its exploration history no longer applies — empty it so the panel refreshes
    // to "no entries yet". Only this plan's entries are cleared; other plans keep theirs.
    historyEntriesStore.update((historyMap) => {
      historyMap.delete(planIndex);
      return historyMap;
    });

    // Clear transient UI state so the cards/effects rebuild from the baseline.
    propagatedFeaturesStore.set(new Set());
    featureValueOverrideStore.set({});

    // Don't log this programmatic reset as a history entry.
    isRestoringEntryStore.set(true);
    planStore.update(() => plan);
    setTimeout(() => isRestoringEntryStore.set(false), 50);

    // Force the FeaturePanel to remount so it re-inits everything from the baseline.
    await tick();
    restorationCounter++;
  };


  // First-time flow: enter in-card setup instead of generating immediately.
  // Generation runs only when the user clicks "Done with Setup" (finishSetup).
  $: curExample && !setupEntered && enterSetup();

  /**
   * Build a BLANK model example for the input-form start: every continuous feature
   * empty (''), every categorical defaulted to its FIRST value (the lowest level's
   * label). Indexed parallel to modelData.features, exactly as Plan/initFeatures
   * expects; interaction slots are left as-is (the cards never read them).
   */
  // Per-feature default label for the blank form, overriding the "first level"
  // default for specific categoricals. Value must be one of the feature's encoder
  // labels; ignored otherwise.
  const BLANK_CATEGORICAL_DEFAULTS = { home_ownership: 'RENT' };

  const buildBlankExample = (modelData) => {
    // Start from a real example so the array's length / index layout matches exactly
    // what the EBM + Plan expect (interaction slots included), then only overwrite the
    // editable features' VALUES: continuous → '' (empty), categorical → first value.
    const ex = curExample ? curExample.slice() : [];
    modelData.features.forEach((f, i) => {
      if (i >= ex.length) return;
      if (f.type === 'categorical') {
        const enc = modelData.labelEncoder[f.name] || {};
        const override = BLANK_CATEGORICAL_DEFAULTS[f.name];
        if (override && Object.values(enc).includes(override)) {
          ex[i] = override; // e.g. Home Ownership defaults to "Rent"
        } else {
          const levels = Object.keys(enc)
            .map(Number)
            .filter((n) => !Number.isNaN(n))
            .sort((a, b) => a - b);
          if (levels.length) ex[i] = enc[String(levels[0])]; // first value's label
        }
      } else if (f.type === 'continuous') {
        ex[i] = '';
      }
      // interaction / other slots keep the source example's value (never read).
    });
    return ex;
  };

  /**
   * Enter first-time setup: load the model and build a lightweight, NON-generated
   * "setup plan" from the raw sample so all 20 cards render editable (no coach
   * suggestion, no score, no propagation) before the user commits.
   */
  const enterSetup = async () => {
    setupEntered = true;

    if (!curModelData) {
      curModelData = await d3.json(
        `PUBLIC_URL/data/${modelName}-classifier.json`
      );
    }
    if (!ebm) {
      ebm = new EBM(curModelData);
      ebmStore.set(ebm);
    }

    // BLANK-START input form: build an empty example — continuous fields empty (''),
    // categoricals defaulted to their FIRST value — so the user enters their own
    // application rather than editing a dataset profile. Otherwise use the loaded
    // profile as before.
    const baseExample = blankStart ? buildBlankExample(curModelData) : curExample;

    // Default constraints so the setup FeaturePanel has a constraints store.
    constraints = new Constraints(curModelData, baseExample);
    constraintsStore.set(constraints);

    // A setup plan with cfData === the sample → no suggestions; ebmLocal is the
    // raw baseline; cards are editable and show the user's own starting values.
    const setupPlan = new Plan(
      curModelData,
      baseExample,
      { originalScore: 0 },
      baseExample.slice(),
      0
    );
    // Blank input form: strip any model-config difficulty so no feature shows an
    // assigned difficulty level on load (the user sets these later if they wish).
    if (blankStart) {
      setupPlan.features.forEach((f) => {
        f.difficulty = 'neutral';
        f.isConstrained = false;
      });
    }
    setupPlanStore = writable(setupPlan);
    // Keep a live copy so the Done button's enabled state reacts to edits.
    unsubscribes.push(setupPlanStore.subscribe((v) => (setupPlanCur = v)));
  };

  /** True once every feature in the setup plan has a value (gates the Done button). */
  const allSetupFilled = (p) =>
    !!p &&
    p.features.length > 0 &&
    p.features.every(
      (f) =>
        p.ebmLocal.sample[f.featureID] !== undefined &&
        p.ebmLocal.sample[f.featureID] !== null &&
        p.ebmLocal.sample[f.featureID] !== ''
    );

  /**
   * "Done with Setup": lock the entered values as the baseline, leave setup, and
   * run the existing generation path (initModel folds loan→DTI, builds
   * constraints, generates, computes the first score, activates propagation).
   */
  const finishSetup = () => {
    const setupPlan = setupPlanStore ? get(setupPlanStore) : null;
    if (!setupPlan || !allSetupFilled(setupPlan)) return;
    // The setup plan's live sample carries the user's entered values.
    enteredBaseline = setupPlan.ebmLocal.sample.slice();
    // Hide the banner/button but keep the setup cards visible while generating.
    // (setupMode stays true so the setup panel keeps rendering until plans exist;
    // once plans arrive, the real feature panel replaces it.)
    setupSubmitted = true;
    initModel();
  };

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
            // Regenerate from the SAME loan-folded baseline the plans were first
            // generated from (the user's entered/loaded profile) — not the raw
            // curExample prop, which still holds the #XYZ placeholder.
            generationBaseline || curExample,
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
    <!-- Left panel: plan dropdown + save star (aligned with the feature cards,
         parallel to the right-column score readout), then the feature list.
         Scrolls independently. -->
    <div class="left-column">
      {#if !generating && plans !== null}
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

          <!-- Save / Saved button (replaces the old star icon). The hover message is
               now a CUSTOM styled tooltip (matching the panel-wide tip look) instead
               of the native `title`, which can't be resized; `class:disabled` is what
               starClicked() checks to block saving a below-approval plan, so it must
               stay on the clicked element (and we avoid the native `disabled`
               attribute, which would suppress the hover). -->
          <button
            class="save-plan-btn"
            class:saved={activePlanSaved}
            class:disabled={starDisabled}
            on:click={(e) => coachPanel && coachPanel.starActivePlan(e)}
          >
            {#if activePlanSaved}
              <svg class="save-check" viewBox="0 0 24 24" width="14" height="14"
                   fill="none" stroke="currentColor" stroke-width="3.2"
                   stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M5 12l5 5l9 -11" />
              </svg>
              Saved
            {:else}
              Save
            {/if}
            <span class="save-tip">{starTitle}</span>
          </button>

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

      {#if generating || plans === null}
        <!-- While generating, `plans` becomes non-null EARLY (with empty plan
             stores) — so we gate the real cards on `!generating` and keep the
             setup cards up until generation actually finishes. This prevents the
             left panel from momentarily emptying after "Done with Setup". -->
        {#if setupMode && setupPlanStore}
          <!-- First-time in-card setup: all 20 cards editable, no score/propagation.
               After "Done with Setup" the banner/button hide but the cards stay
               (frozen) while generation runs; the "Generating…" message shows in
               the right column so the whole panel is never blanked. -->
          {#if !setupSubmitted}
            <div class="setup-banner">
              Enter your details in the cards below, then press
              <strong>Done with Setup</strong> to see your result.
            </div>
          {/if}
          <div class="feature-panel-wrapper">
            <FeaturePanel
              {windowLoaded}
              {logger}
              planStore={setupPlanStore}
              {constraintsStore}
              setupMode={true}
            />
          </div>
          {#if !setupSubmitted}
            <button
              class="setup-done-btn"
              disabled={!allSetupFilled(setupPlanCur)}
              on:click={finishSetup}
            >Done with Setup</button>
          {/if}
        {:else}
          <div class="feature-panel-wrapper">
            <FeaturePanel {logger} planStore={null} {constraintsStore} />
          </div>
        {/if}
      {:else}
        {#key `${plans.activePlanIndex}-${restorationCounter}-${plans.planOrderVersion || 0}`}
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
      {#if generating}
        <!-- Plan/idea generation in flight — the message shows HERE (in the
             otherwise-empty right column) so the left cards stay visible instead
             of the whole panel going blank. -->
        <div class="rc-generating">
          <div class="plan-loading-spinner" />
          <div class="plan-loading-text">Generating ideas…</div>
          <div class="plan-loading-sub">This can take a few moments.</div>
        </div>
      {:else if plans !== null}
        <ScoreReadout planStore={activePlanStore} />
        <div class="rc-drivers">
          <ScoreDrivers planStore={activePlanStore} />
        </div>
        <IdeasToTry planStore={activePlanStore} onRestoreInitial={handleRestoreInitial} />
        <div class="rc-effects">
          <ChangeEffects planStore={activePlanStore} />
        </div>
      {/if}
    </div>
  </div>
</div>

<!-- History Sidebar -->
<HistorySidebar
  activePlanIndex={plans?.activePlanIndex || 1}
  onRestoreEntry={handleRestoreEntry}
/>

<style lang="scss">
  @import '../../define';

  .plan-loading,
  .rc-generating {
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
    // NOTE: no `zoom` here — a page zoom broke the feature cards' d3 interactions.
    // Width is (viewport − 744px), centered by the grid (`1fr auto 1fr`) for EQUAL
    // 372px margins whose right side clears the 352px History sidebar + scrollbar (so
    // the panel never sits under History when it is open). On wide screens this still
    // leaves a roomy panel; it only feels tight on ~1440-and-narrower displays.
    width: calc(100vw - 744px);
    max-width: 1350px;
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
    flex: 0 0 364px;
    width: 364px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  // First-time in-card setup (Change 2).
  .setup-banner {
    font-size: 1.02rem;
    line-height: 1.4;
    color: $gray-700;
    background: $blue-50;
    border: 1px solid $blue-200;
    border-radius: 8px;
    padding: 10px 12px;
    margin-bottom: 4px;

    strong { color: $blue-700; }
  }

  .setup-done-btn {
    align-self: stretch;
    margin-top: 10px;
    padding: 12px 16px;
    font-size: 1.1rem;
    font-weight: 700;
    color: white;
    background: $blue-600;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 120ms ease;

    &:hover:not(:disabled) { background: $blue-700; }
    &:disabled {
      background: $gray-300;
      cursor: not-allowed;
    }
  }

  .right-column {
    flex: 1 1 auto;
    min-width: 0;
    padding-top: 2px;
    // Matches the left column's (viewport-scaled) height and scrolls its own
    // content, so the lower bands (ideas / effects) stay reachable when they grow
    // instead of being clipped by the wrapper's overflow:hidden. Raised (was
    // `- 325px`) so the panel extends into the space it used to leave empty at the
    // bottom of the screen, in step with the taller `.top` region.
    max-height: max(400px, calc(100vh - 245px));
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
      font-size: 1.0rem;
    }
    .note-label {
      font-size: 1.0rem;
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
          font-size: 1.0rem;
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
        font-size: 1.0rem;
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
        font-size: 1.15rem;
        font-weight: 600;
        padding: 3px 22px 3px 10px;
        cursor: pointer;
      }
    }

    // Save / Saved button (replaces the old star). Designed to be clearly VISIBLE
    // in EVERY state — especially the disabled (< 50% approval) state, which is the
    // default when plans first load — so users notice the button exists. It is
    // never faded out; instead each state has its own solid color.
    .save-plan-btn {
      position: relative; // anchor for the custom hover tooltip
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex: 0 0 auto;
      font-family: inherit;
      font-size: 0.95rem;
      font-weight: 700;
      line-height: 1;
      white-space: nowrap;
      padding: 6px 14px;
      border-radius: 6px;
      cursor: pointer;

      // Custom hover tooltip — the same panel-wide tip look (size + frame) as every
      // other hover text, replacing the un-resizable native `title`.
      .save-tip {
        @include hover-tip;
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        z-index: 500;
        width: max-content;
        max-width: 240px;
        white-space: normal;
        text-align: left;
        cursor: default;
        pointer-events: none;
      }
      &:hover .save-tip { display: block; }
      transition: background-color 120ms ease, border-color 120ms ease,
        color 120ms ease;

      // Enabled + not saved — a solid blue call-to-action.
      background: hsl(206, 82%, 52%);
      border: 1px solid hsl(206, 82%, 44%);
      color: white;

      .save-check {
        flex: 0 0 auto;
      }

      &:hover {
        background: hsl(206, 82%, 46%);
        border-color: hsl(206, 82%, 38%);
      }

      // Saved — a solid green pill with the checkmark.
      &.saved {
        background: hsl(142, 52%, 40%);
        border-color: hsl(142, 52%, 32%);
        color: white;

        &:hover {
          background: hsl(142, 52%, 34%);
          border-color: hsl(142, 52%, 27%);
        }
      }

      // Below 50% and not yet saved: cannot save. Still FULLY VISIBLE (no opacity
      // fade) so users notice the button — a soft, readable blue with a not-allowed
      // cursor. The tooltip explains that 50% approval is needed first.
      &.disabled {
        cursor: not-allowed;

        &:not(.saved) {
          background: hsl(206, 58%, 91%);
          border-color: hsl(206, 42%, 74%);
          color: hsl(206, 40%, 42%);

          &:hover {
            background: hsl(206, 58%, 91%);
            border-color: hsl(206, 42%, 74%);
          }
        }

        // A saved plan that later drops below approval stays green, just muted.
        &.saved {
          background: hsl(142, 36%, 56%);
          border-color: hsl(142, 32%, 45%);

          &:hover {
            background: hsl(142, 36%, 56%);
            border-color: hsl(142, 32%, 45%);
          }
        }
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
