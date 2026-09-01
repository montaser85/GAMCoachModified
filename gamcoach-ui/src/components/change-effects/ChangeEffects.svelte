<script>
  // @ts-check
  // "Effects of your changes" — right-panel section (below "What's driving this
  // score"). Display-only: renders the source-edit events produced by
  // FeaturePanel from the engine's existing propagation output. No propagation
  // or decomposition logic lives here.
  import { onDestroy } from 'svelte';
  import { sigmoid } from '../../ebm/ebm';
  import { changeEffectsStore } from '../../store';
  import HeaderInfo from '../header-info/HeaderInfo.svelte';

  const BLUE = '#185FA5'; // helps approval
  const RED = '#A32D2D'; // hurts approval

  /** Active plan store (writable<Plan>) or null while loading — the SAME store the
   * score readout uses, so the row hovers' "new" score always matches the readout. */
  export let planStore = null;

  /** @type {Array<any>} */
  let events = [];
  const unsub = changeEffectsStore.subscribe((v) => (events = v));
  onDestroy(unsub);

  // Live plan → current & original approval scores in "points" (probability × 100),
  // identical math to ScoreReadout. Re-subscribe when the store prop changes.
  let plan = null;
  let unsubPlan = null;
  $: resubscribe(planStore);
  function resubscribe(store) {
    if (unsubPlan) { unsubPlan(); unsubPlan = null; }
    plan = null;
    if (store) unsubPlan = store.subscribe((v) => { plan = v; });
  }
  onDestroy(() => { if (unsubPlan) unsubPlan(); });

  $: curPct = plan ? Math.round(sigmoid(plan.ebmLocal.predScore) * 100) : null;
  $: origPct = plan ? Math.round(sigmoid(plan.originalScore) * 100) : null;

  let collapsed = false; // section hide/unhide (name stays visible)

  // Tabler-style outline SVGs (stroke = currentColor; color set by the wrapper).
  const A =
    'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  // Thumb attrs — hollow (no fill) with a thick colored border.
  const T =
    'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    // ti-arrow-narrow-right (connector)
    arrow: `<svg ${A}><path d="M5 12l14 0"/><path d="M15 16l4 -4"/><path d="M15 8l4 4"/></svg>`,
    // ti-thumb-up (outline, thick border)
    thumbUp: `<svg ${T}><path d="M7 11v8a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h4a5 5 0 0 0 5 -5v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/></svg>`,
    // ti-thumb-down (outline, thick border)
    thumbDown: `<svg ${T}><path d="M7 13v-8a1 1 0 0 0 -1 -1h-3a1 1 0 0 0 -1 1v7a1 1 0 0 0 1 1h4a5 5 0 0 1 5 5v1a2 2 0 0 0 4 0v-5h3a2 2 0 0 0 2 -2l-1 -5a2 3 0 0 0 -2 -2h-7a3 3 0 0 0 -3 3"/></svg>`,
    // ti-hand-finger (empty state)
    hand: `<svg ${A}><path d="M8 13v-8.5a1.5 1.5 0 0 1 3 0v7.5"/><path d="M11 11.5v-2a1.5 1.5 0 0 1 3 0v2.5"/><path d="M14 10.5a1.5 1.5 0 0 1 3 0v1.5"/><path d="M17 11.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.988 1.984"/></svg>`
  };

  // Per-row hover sentence: the causal body built in FeaturePanel.recordChangeEffects
  // (source change + every dependent it moved) PLUS a live approval-score clause when
  // the row carries one. The score endpoints are read here (not baked at edit time),
  // so the "new" score is always the CURRENT score — the same value the readout shows.
  // `curPct`/`origPct` are referenced so the tooltips recompute when the score changes.
  function buildTooltip(ev, orig, cur) {
    const body =
      ev.tooltipBody ||
      // Back-compat / no-body fallback.
      (ev.effects && ev.effects.length === 0
        ? `Changing the ${ev.sourceDisplayName.toLowerCase()} didn't change any other feature`
        : '');
    if (ev.showApproval && orig !== null && cur !== null) {
      return `${body}, which changed your approval score from ${orig}% to ${cur}%.`;
    }
    return `${body}.`;
  }

  // Reactive rows: rebuild whenever the events OR the live scores change, so an older
  // row's "new" score follows the readout after a later edit instead of going stale.
  $: rows = events.map((ev) => ({ ev, tip: buildTooltip(ev, origPct, curPct) }));
</script>

<div class="change-effects">
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="ce-title" class:ce-title-empty={events.length === 0} on:click={() => (collapsed = !collapsed)}>
    Features affected by your changes
    <HeaderInfo text="Shows how changing one feature also changes others." />
    <svg class="ce-chev" class:collapsed viewBox="0 0 24 24" width="24" height="24"
         fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 9l6 6l6 -6"/>
    </svg>
  </div>

  {#if !collapsed}
  {#if events.length === 0}
    <!-- Empty state -->
    <div class="ce-empty">
      <span class="ce-empty-icon">{@html ICONS.hand}</span>
      <div class="ce-empty-text">
        <div>You haven't changed anything yet.</div>
        <div>Edit a feature on the left to see how it ripples through your application.</div>
      </div>
    </div>
  {:else}
    <!-- Legend -->
    <div class="ce-legend">
      <span class="ce-leg">
        <span class="ce-thumb sm" style="color:{BLUE}">{@html ICONS.thumbUp}</span>
        helps approval
      </span>
      <span class="ce-leg">
        <span class="ce-thumb sm" style="color:{RED}">{@html ICONS.thumbDown}</span>
        hurts approval
      </span>
    </div>

    <!-- Rows -->
    <div class="ce-rows">
      {#each rows as { ev, tip } (ev.sourceName)}
        <!-- Names + thumbs only; the numbers live in the hover tooltip shown when
             the per-row info icon is hovered, so they never crowd the display. -->
        <div class="ce-row">
          <!-- Per-row info icon (gray) — hover it to reveal the causal sentence. -->
          <span class="ce-info ce-row-info">i</span>
          <div class="ce-row-tip">{tip}</div>

          <!-- Source: full feature name -->
          <div class="ce-source">
            <div class="ce-src-name">{ev.sourceDisplayName}</div>
          </div>

          <!-- Connector -->
          <span class="ce-arrow">{@html ICONS.arrow}</span>

          <!-- Effect(s), or a neutral no-effect message -->
          <div class="ce-effects">
            {#if ev.effects.length === 0}
              <span class="ce-none">Nothing else changed</span>
            {:else}
              {#each ev.effects as ef}
                <div class="ce-effect">
                  <span class="ce-thumb" style="color:{ef.helps ? BLUE : RED}">
                    {@html ef.helps ? ICONS.thumbUp : ICONS.thumbDown}
                  </span>
                  <div class="ce-eff-name">{ef.depDisplayName}</div>
                </div>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
  {/if}
</div>

<style lang="scss">
  @import '../../define';

  .change-effects {
    padding: 2px;
  }

  /* ── Empty state ─────────────────────────────────────────────────────── */
  .ce-title-empty {
    margin-bottom: 10px;
  }

  .ce-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 14px;
    padding: 26px 20px;
    border: 1.5px dashed $gray-300;
    border-radius: 12px;
    color: $gray-500;

    .ce-empty-icon {
      flex: 0 0 auto;
      width: 26px;
      height: 26px;
      color: $gray-500;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .ce-empty-text {
      font-size: 1.02rem;
      line-height: 1.5;
    }
  }

  /* ── Header + legend ─────────────────────────────────────────────────── */
  .ce-title {
    position: relative; // positioning context for the HeaderInfo hover popup
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 1.2rem;
    font-weight: 700;
    color: $gray-900;
    cursor: pointer;
    user-select: none;
    margin-bottom: 8px;

    .ce-chev {
      margin-left: auto;
      color: $gray-500;
      flex: 0 0 auto;
      transition: transform 150ms ease;
      &.collapsed { transform: rotate(-90deg); }
    }
  }

  .ce-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin-bottom: 12px;
    font-size: 0.98rem;
    font-weight: 600;
    color: $gray-700;

    .ce-leg {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
  }

  .ce-thumb {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;

    &.sm {
      width: 16px;
      height: 16px;
    }
  }

  /* ── Rows ────────────────────────────────────────────────────────────── */
  .ce-rows {
    display: flex;
    flex-direction: column;
  }

  .ce-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 2px;
    border-top: 1px solid $gray-200;
    position: relative; // anchor for the per-row hover tooltip

    &:first-child {
      border-top: none;
    }
  }

  // Per-row info icon — GRAY circle + gray italic "i" (same shape as the
  // left-panel feature-card info icons, but neutral gray instead of blue).
  .ce-info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: transparent;
    border: 2.5px solid $gray-500;
    color: $gray-500;
    font-size: 12px;
    font-weight: 700;
    font-style: italic;
    font-family: Georgia, serif;
    -webkit-text-stroke: 0.4px currentColor;
    line-height: 1;
    cursor: pointer;
    flex: 0 0 auto;
    transition: border-color 0.15s, color 0.15s;

    &:hover {
      border-color: $gray-700;
      color: $gray-700;
    }
  }

  .ce-row-info {
    align-self: center;
  }

  // Per-row causal-link tooltip — same look as the left-panel feature-card info
  // popup (FeatureCard.scss .link-popup): white card, blue border, dark text. Shown
  // only while the row's info icon is hovered. Opens UPWARD (above the row): this is
  // the last band in the right panel, whose own overflow:auto would clip a downward
  // tooltip on the bottom-most row (e.g. Loan Amount) — so it read as cut off and
  // needed extra scrolling. Opening above keeps it inside the visible scroll area.
  .ce-row-tip {
    position: absolute;
    bottom: calc(100% - 6px);
    left: 0;
    z-index: 60;
    max-width: 300px;
    width: max-content;
    background: white;
    border: 1px solid $blue-200;
    color: $gray-700;
    padding: 9px 11px;
    border-radius: 6px;
    font-size: 0.82rem;
    line-height: 1.5;
    white-space: pre-line; // render the \n\n between multiple effects as blank lines
    box-shadow: 0 4px 16px hsla(0, 0%, 0%, 0.14);
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 120ms ease;
  }

  .ce-row-info:hover ~ .ce-row-tip {
    opacity: 1;
    visibility: visible;
  }

  .ce-source {
    flex: 0 0 auto;
    width: 146px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    gap: 2px;

    .ce-src-name {
      font-size: 1.0rem;
      font-weight: 600;
      color: $gray-800;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
  }

  .ce-arrow {
    flex: 0 0 auto;
    width: 30px;
    height: 24px;
    color: $gray-400;
    display: flex;
    align-items: center;
    justify-content: center;

    :global(svg) {
      width: 30px;
      height: 24px;
    }
  }

  .ce-effects {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 14px 20px;
  }

  /* No-effect row: neutral text where the thumbs would be — reads as an absence,
     not a positive or negative outcome. */
  .ce-none {
    align-self: center;
    font-size: 0.98rem;
    font-style: italic;
    color: $gray-500;
  }

  .ce-effect {
    flex: 0 0 auto;
    min-width: 64px;
    max-width: 108px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 3px;

    // Full feature name — wraps onto up to TWO lines (uses vertical space),
    // never more.
    .ce-eff-name {
      font-size: 0.96rem;
      color: $gray-700;
      line-height: 1.2;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
  }
</style>
