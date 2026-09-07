<script>
  // @ts-check
  import { onDestroy } from 'svelte';
  import { computeScoreDrivers } from './scoreDrivers';
  import HeaderInfo from '../header-info/HeaderInfo.svelte';
  import { LINK_POPUP_TEXT } from '../../utils/featureDefinitions';

  /** Active plan store (writable<Plan>) or null while loading. */
  export let planStore = null;

  const BLUE = '#378ADD';
  const RED = '#E24B4A';
  const DOMAIN = 9; // symmetric axis half-range
  const TICKS = [-9, -7, -5, -3, 0, 3, 5, 7, 9];

  let collapsed = false; // section hide/unhide (name stays visible)

  let plan = null;
  let unsub = null;
  $: resubscribe(planStore);
  function resubscribe(store) {
    if (unsub) { unsub(); unsub = null; }
    plan = null;
    if (store) unsub = store.subscribe((v) => { plan = v; });
  }
  onDestroy(() => { if (unsub) unsub(); });

  // Live decomposition, sorted highest-positive → lowest-negative.
  $: drivers = plan ? computeScoreDrivers(plan) : { features: [] };
  $: rows = [...drivers.features].sort((a, b) => b.actualPP - a.actualPP);

  // Net total = the SUM OF THE DISPLAYED BARS (approach (a)). The per-feature
  // actualPP values are already scaled so their unrounded sum equals the true net
  // score change (current − original); summing the displayed (1-decimal) values here
  // makes the title, the bars, and the bottom total use ONE identical figure that
  // always agrees — the only difference from the raw net is sub-0.1 rounding.
  $: panelTotal = rows.length
    ? Math.round(rows.reduce((s, r) => s + r.actualPP, 0) * 10) / 10
    : 0;

  // Bar length: |value| as a fraction of the half-axis (a value of 9 fills 50%).
  const barPct = (v) => (Math.min(Math.abs(v), DOMAIN) / DOMAIN) * 50;
  // Tick x-position: 0 → 50%, +9 → 100%, −9 → 0%.
  const tickPct = (t) => 50 + (t / DOMAIN) * 50;
  const signed = (v) => (v >= 0 ? '+' : '−') + Math.abs(v);

  // Uniform name-column width = the widest driver name at the .sd-name font, so every
  // full feature name fits on ONE line and all the bars still share a zero baseline.
  let nameColPx = 150;
  $: nameColPx = computeNameCol(rows);
  function computeNameCol(rows) {
    if (!rows || !rows.length || typeof document === 'undefined') return 150;
    const p =
      computeNameCol._p ||
      (() => {
        const s = document.createElement('span');
        s.style.cssText =
          'position:absolute;left:-9999px;top:-9999px;visibility:hidden;' +
          'white-space:nowrap;font-size:1.02rem;';
        document.body.appendChild(s);
        computeNameCol._p = s;
        return s;
      })();
    let max = 0;
    for (const r of rows) {
      p.textContent = r.displayName;
      const w = p.getBoundingClientRect().width;
      if (w > max) max = w;
    }
    return Math.max(90, Math.min(280, Math.ceil(max) + 3));
  }
</script>

<div class="score-drivers" style="--sd-name-col: {nameColPx}px">
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="sd-header" on:click={() => (collapsed = !collapsed)}>
    <span class="sd-title-text">Your score changed by <span
        class="sd-title-net" class:pos={panelTotal >= 0} class:neg={panelTotal < 0}
      >{signed(panelTotal)} points</span> from the original</span>
    <HeaderInfo text="How much each change moved your score up or down from your original score. The bars break down the net change above." />
    <svg class="sd-chev" class:collapsed viewBox="0 0 24 24" width="24" height="24"
         fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 9l6 6l6 -6"/>
    </svg>
  </div>

  {#if !collapsed}
  {#if rows.length > 0}
    <div class="sd-subtitle">Here's what each change contributed:</div>
  {/if}
  <div class="sd-axis-labels">
    <span class="sd-hurts">&larr; hurts</span>
    <span class="sd-helps">helps &rarr;</span>
  </div>

  {#if rows.length > 0}
    <div class="sd-rows">
      {#each rows as r (r.name)}
        <div class="sd-row">
          <div class="sd-name">
            <span class="sd-name-text">{r.displayName}</span>
            {#if LINK_POPUP_TEXT[r.name]}
              <span class="sd-name-tip">{LINK_POPUP_TEXT[r.name]}</span>
            {/if}
          </div>
          <div class="sd-plot">
            <div class="sd-zero"></div>
            {#if r.actualPP >= 0}
              <div class="sd-bar pos" style="left: 50%; width: {barPct(r.actualPP)}%"></div>
            {:else}
              <div class="sd-bar neg" style="right: 50%; width: {barPct(r.actualPP)}%"></div>
            {/if}
          </div>
          <div class="sd-value" class:pos={r.actualPP >= 0} class:neg={r.actualPP < 0}>
            {signed(r.actualPP)}
          </div>
        </div>
      {/each}
    </div>

    <!-- Bottom axis -->
    <div class="sd-axis">
      <div class="sd-axis-spacer"></div>
      <div class="sd-axis-ticks">
        {#each TICKS as t}
          <span class="sd-tick" style="left: {tickPct(t)}%">{t}</span>
        {/each}
      </div>
      <div class="sd-axis-spacer sd-axis-spacer-value"></div>
    </div>

    <!-- Summed total — the bars above add up to this (same figure as the title). -->
    <div class="sd-total">
      <span class="sd-total-label">Total:</span>
      <span class="sd-total-value" class:pos={panelTotal >= 0} class:neg={panelTotal < 0}
        >{signed(panelTotal)}</span>
    </div>
  {:else}
    <div class="sd-empty">No differences from the original application yet.</div>
  {/if}
  {/if}
</div>

<style lang="scss">
  @import '../../define';

  $blue: #378ADD;
  $red: #E24B4A;
  $name-col: 142px;
  $value-col: 54px;
  $col-gap: 8px;

  .score-drivers {
    padding: 2px;
  }

  .sd-header {
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

    .sd-chev {
      margin-left: auto;
      color: $gray-500;
      flex: 0 0 auto;
      transition: transform 150ms ease;
      &.collapsed { transform: rotate(-90deg); }
    }
  }

  // Dynamic net-change title. The signed net is tinted blue (up) / red (down) to
  // match the bars; a value of 0 stays blue (the "+0" neutral state).
  .sd-title-text {
    min-width: 0; // allow the long title to wrap instead of shoving the chevron out
    line-height: 1.25;
  }
  .sd-title-net {
    font-variant-numeric: tabular-nums;
    &.pos { color: $blue; }
    &.neg { color: $red; }
  }

  .sd-subtitle {
    font-size: 1.0rem;
    color: $gray-600;
    margin-bottom: 8px;
  }

  // Summed total row — the per-change bars add up to this (the same figure as the
  // title). A top border sets it apart as the sum.
  .sd-total {
    display: flex;
    align-items: baseline;
    justify-content: flex-end; // sits on the right, below the per-bar point values
    gap: 6px;
    margin-top: 6px;
    padding-top: 8px;
    border-top: 2px solid $gray-300;

    .sd-total-label {
      font-size: 1.05rem;
      font-weight: 700;
      color: $gray-800;
    }
    .sd-total-value {
      font-size: 1.08rem;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      &.pos { color: $blue; }
      &.neg { color: $red; }
    }
  }

  .sd-axis-labels {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
    font-size: 0.98rem;
    font-weight: 600;

    .sd-hurts { color: $red; }
    .sd-helps { color: $blue; }
  }

  .sd-rows {
    display: flex;
    flex-direction: column;
  }

  .sd-row {
    display: grid;
    grid-template-columns: var(--sd-name-col, #{$name-col}) 1fr $value-col;
    column-gap: $col-gap;
    align-items: center;
  }

  .sd-name {
    position: relative;
    font-size: 1.02rem;
    color: $gray-800;
    cursor: default; // no help/question cursor on hover
    // Full feature name on a SINGLE line (the column is sized to the widest name).
    white-space: nowrap;
    line-height: 1.2;

    // Hover definition — same text as the left-panel feature-card info popup,
    // styled to match it (white card, blue border).
    .sd-name-tip {
      @include hover-tip;  // shared panel-wide tooltip look (size + frame)
      display: none;
      position: absolute;
      left: 0;
      top: 100%;
      margin-top: 4px;
      z-index: 600;
      width: 230px;
      max-width: 260px;
      white-space: normal;
      text-align: left;
      cursor: default;
    }
    &:hover .sd-name-tip { display: block; }
  }

  .sd-plot {
    position: relative;
    height: 24px;
  }

  /* Continuous black zero baseline (rows touch so the segments connect). */
  .sd-zero {
    position: absolute;
    left: 50%;
    top: 0;
    bottom: 0;
    width: 2px;
    background: $gray-900;
    transform: translateX(-50%);
    z-index: 1;
  }

  .sd-bar {
    position: absolute;
    top: 50%;
    height: 12px;
    transform: translateY(-50%);
    &.pos { background: $blue; border-radius: 0 3px 3px 0; }
    &.neg { background: $red;  border-radius: 3px 0 0 3px; }
  }

  .sd-value {
    text-align: right;
    font-size: 1.03rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    &.pos { color: $blue; }
    &.neg { color: $red; }
  }

  /* ── Bottom axis ─────────────────────────────────────────────────── */
  .sd-axis {
    display: grid;
    grid-template-columns: var(--sd-name-col, #{$name-col}) 1fr $value-col;
    column-gap: $col-gap;
    margin-top: 2px;
  }

  .sd-axis-ticks {
    position: relative;
    height: 16px;
    border-top: 1px solid $gray-200;

    .sd-tick {
      position: absolute;
      top: 3px;
      transform: translateX(-50%);
      font-size: 0.82rem;
      color: $gray-500;
      font-variant-numeric: tabular-nums;
    }
  }

  .sd-empty {
    font-size: 1.02rem;
    color: $gray-500;
    padding: 8px 2px;
  }
</style>
