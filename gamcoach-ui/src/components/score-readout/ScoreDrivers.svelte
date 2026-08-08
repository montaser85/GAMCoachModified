<script>
  // @ts-check
  import { onDestroy } from 'svelte';
  import { computeScoreDrivers } from './scoreDrivers';

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

  // Bar length: |value| as a fraction of the half-axis (a value of 9 fills 50%).
  const barPct = (v) => (Math.min(Math.abs(v), DOMAIN) / DOMAIN) * 50;
  // Tick x-position: 0 → 50%, +9 → 100%, −9 → 0%.
  const tickPct = (t) => 50 + (t / DOMAIN) * 50;
  const signed = (v) => (v >= 0 ? '+' : '−') + Math.abs(v);
</script>

<div class="score-drivers">
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="sd-header" on:click={() => (collapsed = !collapsed)}>
    What's driving this score
    <span class="sd-info" title="Each feature's contribution to the current score, in points.">i</span>
    <svg class="sd-chev" class:collapsed viewBox="0 0 24 24" width="24" height="24"
         fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 9l6 6l6 -6"/>
    </svg>
  </div>

  {#if !collapsed}
  <div class="sd-axis-labels">
    <span class="sd-hurts">&larr; hurts</span>
    <span class="sd-helps">helps &rarr;</span>
  </div>

  {#if rows.length > 0}
    <div class="sd-rows">
      {#each rows as r (r.name)}
        <div class="sd-row">
          <div class="sd-name">{r.displayName}</div>
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
  {:else}
    <div class="sd-empty">No differences from the original application yet.</div>
  {/if}
  {/if}
</div>

<style lang="scss">
  @import '../../define';

  $blue: #378ADD;
  $red: #E24B4A;
  $name-col: 132px;
  $value-col: 46px;
  $col-gap: 8px;

  .score-drivers {
    padding: 2px;
  }

  .sd-header {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 1rem;
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

    .sd-info {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      border: 1px solid $gray-400;
      color: $gray-500;
      font-size: 0.68rem;
      font-weight: 700;
      font-style: italic;
      cursor: default;
    }
  }

  .sd-axis-labels {
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
    font-size: 0.82rem;
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
    grid-template-columns: $name-col 1fr $value-col;
    column-gap: $col-gap;
    align-items: center;
  }

  .sd-name {
    font-size: 0.85rem;
    color: $gray-800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
    font-size: 0.86rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    &.pos { color: $blue; }
    &.neg { color: $red; }
  }

  /* ── Bottom axis ─────────────────────────────────────────────────── */
  .sd-axis {
    display: grid;
    grid-template-columns: $name-col 1fr $value-col;
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
      font-size: 0.68rem;
      color: $gray-500;
      font-variant-numeric: tabular-nums;
    }
  }

  .sd-empty {
    font-size: 0.85rem;
    color: $gray-500;
    padding: 8px 2px;
  }
</style>
