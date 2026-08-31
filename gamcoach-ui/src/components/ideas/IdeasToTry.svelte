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
  import { ideasStore, ideaDismissStore } from '../../store';
  import HeaderInfo from '../header-info/HeaderInfo.svelte';

  /** Active plan store (writable<Plan>) or null while loading — used for the
   * points-based status line. */
  export let planStore = null;

  const THRESHOLD = 50; // approval threshold, in points (matches ScoreReadout)

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

  $: curPoints = plan ? Math.round(sigmoid(plan.ebmLocal.predScore) * 100) : null;
  $: statusLine =
    curPoints === null
      ? ''
      : curPoints >= THRESHOLD
      ? "You've reached approval. A few things you could still try:"
      : `${THRESHOLD - curPoints} points to go. A few things that could help:`;
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
          <span class="it-chip">
            <span class="it-verb">{idea.verb}</span>
            <span class="it-feat">{idea.displayName}</span>
            {#if idea.mode === 'amount' && idea.targetDisplay}
              <span class="it-target">to {idea.targetDisplay}</span>
            {/if}
            <button
              class="it-dismiss"
              title="Dismiss this idea"
              on:click|stopPropagation={() => ideaDismissStore.set(idea.name)}
            >&times;</button>
          </span>
        {/each}
      </div>
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

  /* Amber lever chips (finalized style). */
  .it-chip {
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

    // Per-idea dismiss (×) button — replaces the idea with a directional one.
    .it-dismiss {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 2px;
      width: 18px;
      height: 18px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: #8a6d3b;
      font-size: 1.1rem;
      line-height: 1;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease;

      &:hover {
        background: #e8d3a0;
        color: #000;
      }
    }
  }
</style>
