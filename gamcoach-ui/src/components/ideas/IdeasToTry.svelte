<script>
  // @ts-check
  // "Ideas to try" — right-panel section (below "What's driving this score").
  // Display-only. Two render modes per idea:
  //   - mode 'amount'    → the plan's suggested change WITH a target amount,
  //                        e.g. "Raise Annual Income to $90,000".
  //   - mode 'direction' → a directional replacement (after the user dismisses an
  //                        original idea), e.g. "Raise Annual Income".
  // Each idea has a dismiss (×) button; dismissing publishes the feature name to
  // ideaDismissStore, and FeaturePanel swaps in a directional replacement.
  import { onDestroy } from 'svelte';
  import { sigmoid } from '../../ebm/ebm';
  import { ideasStore, ideaApplyStore } from '../../store';
  import { approvalPoints, APPROVAL_POINTS } from '../../utils/score';
  import HeaderInfo from '../header-info/HeaderInfo.svelte';

  /** Active plan store (writable<Plan>) or null while loading — used for the
   * points-based status line. */
  export let planStore = null;
  /** Called to restore the whole panel to its post-setup initial state. */
  export let onRestoreInitial = null;

  const THRESHOLD = APPROVAL_POINTS; // approval threshold, in points (matches ScoreReadout)

  /** @type {Array<{name:string, displayName:string, verb:string, direction:string, mode:string, targetDisplay?:string}>} */
  let ideas = [];
  const unsubIdeas = ideasStore.subscribe((v) => (ideas = v));
  onDestroy(unsubIdeas);

  // Current score in "points" (probability × 100), same math as ScoreReadout.
  let plan = null;
  let unsubPlan = null;
  $: resubscribe(planStore);
  function resubscribe(store) {
    if (unsubPlan) { unsubPlan(); unsubPlan = null; }
    plan = null;
    if (store) unsubPlan = store.subscribe((v) => { plan = v; });
  }
  onDestroy(() => { if (unsubPlan) unsubPlan(); });

  let collapsed = false; // section hide/unhide (name stays visible)

  // The warning shown for "Restore initial ideas" — reused by both the button's
  // hover tooltip and the inline confirmation panel so they never drift apart.
  const RESTORE_WARNING =
    'This will restore everything to the original ideas, undoing all your changes.';
  // When true, the button is replaced by a small confirm/cancel panel (clicking
  // "Restore initial ideas" now asks for confirmation instead of acting immediately).
  let confirmingRestore = false;

  // Clamp so the status line agrees with the readout/approval status: a probability
  // in [0.495, 0.50) must NOT read "You've reached approval" (it renders as 49, not 50).
  $: curPoints = plan ? approvalPoints(sigmoid(plan.ebmLocal.predScore)) : null;
  $: statusLine =
    curPoints === null
      ? ''
      : curPoints >= THRESHOLD
      ? "You've reached approval. A few things you could still try:"
      : `${THRESHOLD - curPoints} points to go. A few things that could help:`;

  // Show "Restore initial ideas" only once the user has diverged from the post-setup
  // state — i.e. edited any feature (isChangedByUser) or applied/dismissed any idea
  // (dismissedIdeaNames). Hidden when already at the initial state (nothing to undo).
  $: showRestore =
    !!onRestoreInitial &&
    !!plan &&
    (plan.isChangedByUser ||
      (plan.dismissedIdeaNames instanceof Set && plan.dismissedIdeaNames.size > 0));

  // If the restore control goes away (e.g. after restoring, or a plan switch), make
  // sure a lingering confirmation panel is dismissed too.
  $: if (!showRestore) confirmingRestore = false;

  // Position the custom hover tooltip (a position:fixed child) just above the chip
  // that was hovered, centered on it. Fixed coords are used so the tooltip escapes
  // the right column's overflow clipping. Recomputed on each hover.
  function positionIdeaTip(e) {
    const chip = e.currentTarget;
    const tip = chip.querySelector('.it-tip');
    if (!tip) return;
    const r = chip.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top - 9}px`;
  }
</script>

{#if ideas.length > 0}
  <div class="ideas-to-try">
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="it-title" on:click={() => (collapsed = !collapsed)}>
      Ideas to try
      <HeaderInfo text="Things you could try to change the current approval score." />
      <svg class="it-chev" class:collapsed viewBox="0 0 24 24" width="24" height="24"
           fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6l6 -6"/>
      </svg>
    </div>

    {#if !collapsed}
      {#if statusLine}
        <div class="it-status">{statusLine}</div>
      {/if}

      <div class="it-chips">
        {#each ideas as idea (idea.name)}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <span
            class="it-chip"
            class:it-chip-apply={idea.mode === 'amount'}
            aria-label={idea.mode === 'amount'
              ? `Click to apply: ${idea.verb} ${idea.displayName} to ${idea.targetDisplay}`
              : undefined}
            on:mouseenter={positionIdeaTip}
            on:click={() => {
              if (idea.mode === 'amount')
                ideaApplyStore.set({ name: idea.name, value: idea.applyValue });
            }}
          >
            <span class="it-verb">{idea.verb}</span>
            <span class="it-feat">{idea.displayName}</span>
            {#if idea.mode === 'amount' && idea.targetDisplay}
              <span class="it-target">to {idea.targetDisplay}</span>
            {/if}
            {#if idea.mode === 'amount'}
              <!-- Custom hover tooltip (replaces the slow, unstyleable native
                   `title`): appears instantly, larger font, thicker border. -->
              <span class="it-tip">Click to apply: {idea.verb} {idea.displayName} to {idea.targetDisplay}</span>
            {/if}
          </span>
        {/each}
      </div>

      {#if showRestore}
        {#if !confirmingRestore}
          <!-- Full-state restore to the post-setup baseline. Clicking opens the small
               confirmation panel below (it undoes ALL the user's changes, not just the
               ideas), so the reset is never a one-click accident. -->
          <button
            class="it-restore"
            on:mouseenter={positionIdeaTip}
            on:click={() => (confirmingRestore = true)}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3 -6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            Restore initial ideas
            <span class="it-tip it-tip-warn">{RESTORE_WARNING}</span>
          </button>
        {:else}
          <!-- Small inline confirm/cancel panel: shows the same warning text and
               requires an explicit choice before the whole panel is reset. -->
          <div class="it-confirm" role="alertdialog" aria-label="Confirm restore initial ideas">
            <div class="it-confirm-msg">{RESTORE_WARNING}</div>
            <div class="it-confirm-actions">
              <button class="it-confirm-btn cancel" on:click={() => (confirmingRestore = false)}>
                Cancel
              </button>
              <button
                class="it-confirm-btn confirm"
                on:click={() => { confirmingRestore = false; onRestoreInitial && onRestoreInitial(); }}
              >
                Restore
              </button>
            </div>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  .ideas-to-try {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid $gray-200;
  }

  .it-title {
    position: relative; // positioning context for the HeaderInfo hover popup
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 1.2rem;
    font-weight: 700;
    color: $gray-900;
    margin-bottom: 8px;
    cursor: pointer;
    user-select: none;

    .it-chev {
      margin-left: auto;
      color: $gray-500;
      flex: 0 0 auto;
      transition: transform 150ms ease;
      &.collapsed { transform: rotate(-90deg); }
    }
  }

  .it-status {
    font-size: 1.05rem;
    color: $gray-700;
    margin-bottom: 10px;
  }

  .it-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 10px;
  }

  /* Amber lever chips (directional ideas). */
  .it-chip {
    position: relative; // anchor for the custom hover tooltip
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: #fbf0da;
    border: 1px solid #e8d3a0;
    border-radius: 18px;
    color: #000;
    font-size: 1.05rem;
    line-height: 1.2;
    cursor: default;

    /* Initial (amount) ideas: a very light blue, clickable to apply the change. */
    &.it-chip-apply {
      background: #eaf4fd;
      border-color: #bcdcf5;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;

      &:hover {
        background: #d8ebfb;
        border-color: #93c6ef;
      }

      // Show the custom tooltip instantly on hover (no native-title delay).
      &:hover .it-tip {
        opacity: 1;
      }
    }

    .it-verb {
      font-weight: 700;
    }

    .it-feat {
      font-weight: 500;
    }

    // Target amount shown only for original (mode 'amount') ideas.
    .it-target {
      font-weight: 600;
    }
  }

  // Custom hover tooltip (shared by the amount chips and the restore button): bigger
  // font and a thicker border than the native tooltip, appearing immediately.
  // position:fixed (coordinates set by positionIdeaTip on mouseenter) so it is never
  // clipped by the right column's overflow.
  .it-tip {
    @include hover-tip;  // the shared panel-wide tooltip look (size + frame)
    position: fixed;
    left: 0;
    top: 0;
    transform: translate(-50%, -100%); // anchor bottom-center over the target
    z-index: 9999;
    width: max-content;
    max-width: 280px;
    text-align: center;
    white-space: normal;
    pointer-events: none;
    opacity: 0;                 // hidden until hover
    transition: opacity 60ms ease;  // rapid fade-in, no delay

    // Warning variant (restore button): amber border to signal it undoes changes.
    &.it-tip-warn {
      border-color: #e0a020;
      max-width: 300px;
    }
  }

  // "Restore initial ideas" — full-state reset to the post-setup baseline.
  .it-restore {
    position: relative; // anchor for its hover tooltip
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    line-height: 1;
    padding: 7px 13px;
    border-radius: 8px;
    border: 1px solid $gray-400;
    background: white;
    color: $gray-700;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, color 120ms ease;

    svg { flex: 0 0 auto; }

    &:hover {
      background: $gray-100;
      border-color: $gray-500;
      color: $gray-900;
    }

    // Show its warning tooltip instantly on hover.
    &:hover .it-tip {
      opacity: 1;
    }
  }

  // Small inline confirmation panel shown after clicking "Restore initial ideas".
  // Amber-bordered (matches the warning tooltip) so it reads as a caution step.
  .it-confirm {
    margin-top: 14px;
    padding: 11px 13px;
    border: 1px solid #e0a020;
    border-radius: 8px;
    background: hsl(38, 100%, 97%);
    max-width: 320px;

    .it-confirm-msg {
      font-size: 0.95rem;
      font-weight: 500;
      line-height: 1.4;
      color: $gray-900;
      margin-bottom: 10px;
    }

    .it-confirm-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .it-confirm-btn {
      font-family: inherit;
      font-size: 0.92rem;
      font-weight: 600;
      line-height: 1;
      padding: 7px 14px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;

      // Cancel — quiet, keeps the current state.
      &.cancel {
        border: 1px solid $gray-400;
        background: white;
        color: $gray-700;
        &:hover { background: $gray-100; border-color: $gray-500; color: $gray-900; }
      }

      // Restore — the committing action, amber to echo the warning.
      &.confirm {
        border: 1px solid #cf8f16;
        background: #e0a020;
        color: white;
        &:hover { background: #cf8f16; border-color: #b57e12; }
      }
    }
  }
</style>
