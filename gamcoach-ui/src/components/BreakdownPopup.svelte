<script>
  import { breakdownPopupStore } from '../store';

  const POPUP_WIDTH = 440;

  let hideTimer = null;

  const keepPopup = () => clearTimeout(hideTimer);

  const scheduleHide = () => {
    if ($breakdownPopupStore.pinned) return;
    hideTimer = setTimeout(() => {
      breakdownPopupStore.update(v => v.pinned ? v : { ...v, show: false });
    }, 150);
  };

  const closePopup = () => {
    clearTimeout(hideTimer);
    breakdownPopupStore.set({ show: false, x: 0, y: 0, data: null, pinned: false });
  };

  /**
   * Compute a shade within a hue family.
   * index 0 = darkest (largest contributor), increases = lighter.
   */
  const negColor = i => `hsl(4,   82%, ${Math.min(38 + i * 9, 58)}%)`;
  const posColor = i => `hsl(213, 82%, ${Math.min(38 + i * 9, 58)}%)`;
</script>

{#if $breakdownPopupStore.show && $breakdownPopupStore.data}
  {@const d = $breakdownPopupStore.data}

  <!-- Sort into two groups; largest magnitude nearest the center divider -->
  {@const negList = d.features
      .filter(f => f.actualPP < 0)
      .sort((a, b) => a.actualPP - b.actualPP)}   <!-- most-neg first (leftmost) -->
  {@const posList = d.features
      .filter(f => f.actualPP > 0)
      .sort((a, b) => b.actualPP - a.actualPP)}   <!-- most-pos first (nearest center) -->
  {@const totalAbsPP = d.features.reduce((s, f) => s + Math.abs(f.actualPP), 0)}

  <div
    class="bd-popup"
    class:bd-pinned={$breakdownPopupStore.pinned}
    style="left:{Math.min($breakdownPopupStore.x, window.innerWidth - POPUP_WIDTH - 8)}px;
           top:{$breakdownPopupStore.y}px; width:{POPUP_WIDTH}px"
    on:mouseenter={keepPopup}
    on:mouseleave={scheduleHide}
    role="tooltip"
  >
    <!-- ── Header ──────────────────────────────────────────────── -->
    <div class="bd-header">
      <div class="bd-header-row">
        <div class="bd-title-block">
          <span class="bd-label">Approval Probability:</span>
          <span class="bd-scores">{d.origPct}% → {d.curPct}%</span>
          <span class="bd-delta"
            class:bd-delta-pos={d.deltaPP > 0}
            class:bd-delta-neg={d.deltaPP < 0}>
            {d.deltaSign}{d.deltaPP}
          </span>
        </div>
        {#if $breakdownPopupStore.pinned}
          <button class="bd-close" on:click={closePopup} title="Close">✕</button>
        {/if}
      </div>
      <div class="bd-subtitle">SCORE CHANGE BREAKDOWN</div>
    </div>

    <!-- ── Force plot bar ──────────────────────────────────────── -->
    {#if totalAbsPP > 0}
      <div class="force-plot">
        <div class="force-bar">

          <!-- Negative (red) segments — largest on the far left -->
          {#each negList as feat, i}
            <div
              class="force-seg"
              style="width:{Math.abs(feat.actualPP) / totalAbsPP * 100}%;
                     background:{negColor(i)}"
              title="{feat.displayName}: {feat.actualPP.toFixed(1)}"
            >
              <span class="force-label">{feat.displayName}</span>
            </div>
          {/each}

          <!-- Centre divider — only when both sides are present -->
          {#if negList.length > 0 && posList.length > 0}
            <div class="force-divider"></div>
          {/if}

          <!-- Positive (blue) segments — largest nearest the centre -->
          {#each posList as feat, i}
            <div
              class="force-seg"
              style="width:{feat.actualPP / totalAbsPP * 100}%;
                     background:{posColor(i)}"
              title="{feat.displayName}: +{feat.actualPP.toFixed(1)}"
            >
              <span class="force-label">{feat.displayName}</span>
            </div>
          {/each}

        </div>

        <!-- Axis labels -->
        <div class="force-axis">
          {#if negList.length > 0}
            <span class="force-axis-neg">← reduces</span>
          {/if}
          {#if posList.length > 0}
            <span class="force-axis-pos">increases →</span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ── Feature rows ────────────────────────────────────────── -->
    <div class="bd-rows">
      {#each d.features as feat}
        <div class="bd-row">

          <span class="bd-name">{feat.displayName}</span>

          <span class="bd-badge" class:bd-badge-prop={feat.isPropagated}>
            {feat.isPropagated ? 'PROPAGATED' : 'DIRECT'}
          </span>

          <span class="bd-values">{feat.origValStr} → {feat.curValStr}</span>

          <!-- Per-row diverging mini-bar -->
          <div class="bd-bar-wrap">
            <div class="bd-bar-neg-side">
              {#if feat.proportion < 0}
                <div class="bd-bar-fill bd-bar-neg"
                  style="width:{Math.abs(feat.proportion) * 100}%"></div>
              {/if}
            </div>
            <div class="bd-bar-center"></div>
            <div class="bd-bar-pos-side">
              {#if feat.proportion > 0}
                <div class="bd-bar-fill bd-bar-pos"
                  style="width:{feat.proportion * 100}%"></div>
              {/if}
            </div>
          </div>

          <!-- pp contribution + % share -->
          <div class="bd-pct"
            class:bd-pct-pos={feat.actualPP > 0}
            class:bd-pct-neg={feat.actualPP < 0}>
            <span class="bd-pct-val">
              {feat.actualPP > 0 ? '+' : ''}{feat.actualPP}
            </span>
            <span class="bd-pct-sub">
              {feat.pctOfTotal > 0 ? '+' : ''}{feat.pctOfTotal}%
            </span>
          </div>

        </div>
      {/each}
    </div>

  </div>
{/if}

<style lang="scss">
  @import '../define';

  /* ── Popup shell ──────────────────────────────────────────────── */
  .bd-popup {
    position: absolute;
    z-index: 9000;
    background: white;
    border: 1px solid $gray-200;
    border-radius: 8px;
    box-shadow: 0 4px 20px hsla(0, 0%, 0%, 0.14);
    padding: 12px 14px;
    font-size: 0.8rem;
    color: $gray-800;
    pointer-events: all;

    &.bd-pinned {
      border-color: $gray-400;
      box-shadow: 0 4px 24px hsla(0, 0%, 0%, 0.2);
    }
  }

  /* ── Header ───────────────────────────────────────────────────── */
  .bd-header {
    margin-bottom: 10px;

    .bd-header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2px;
    }

    .bd-title-block {
      display: flex;
      align-items: baseline;
      gap: 6px;
      flex-wrap: wrap;
    }

    .bd-label {
      font-size: 0.75rem;
      font-weight: 600;
      //color: $gray-500;
      color: black;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .bd-scores {
      font-size: 1rem;
      font-weight: 700;
      color: $gray-900;
    }

    .bd-delta {
      font-size: 0.85rem;
      font-weight: 700;
      padding: 1px 8px;
      border-radius: 10px;
      &.bd-delta-pos {
        background: hsl(213, 100%, 94%);
        color: hsl(213, 80%, 38%);
        border: 1px solid hsl(213, 80%, 80%);
      }
      &.bd-delta-neg {
        background: hsl(4, 100%, 94%);
        color: hsl(4, 70%, 40%);
        border: 1px solid hsl(4, 70%, 78%);
      }
    }

    .bd-subtitle {
      font-size: 0.70rem;
      font-weight: 600;
      letter-spacing: 0.06em;
      //color: $gray-400;
      color:gray;
      text-transform: uppercase;
    }

    .bd-close {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.85rem;
      //color: $gray-400;
      color: gray;
      padding: 2px 5px;
      border-radius: 4px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
      &:hover {
        color: $gray-700;
        background: $gray-100;
      }
    }
  }

  /* ── Force plot ───────────────────────────────────────────────── */
  .force-plot {
    margin-bottom: 12px;
  }

  .force-bar {
    display: flex;
    height: 24px;
    border-radius: 5px;
    overflow: hidden;
  }

  .force-seg {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    min-width: 0;
    transition: opacity 0.15s;

    &:hover { opacity: 0.82; }

    .force-label {
      font-size: 0.63rem;
      font-weight: 600;
      color: white;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 0 5px;
      text-shadow: 0 1px 2px hsla(0,0%,0%,0.25);
      pointer-events: none;
    }
  }

  /* 2 px white divider between negative and positive sides */
  .force-divider {
    width: 2px;
    background: white;
    flex-shrink: 0;
  }

  .force-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 3px;
    font-size: 0.8rem;
    font-weight: 500;

    .force-axis-neg { color: hsl(4,   70%, 50%); }
    .force-axis-pos { color: hsl(213, 70%, 48%); }
  }

  /* ── Feature rows ─────────────────────────────────────────────── */
  .bd-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .bd-row {
    display: grid;
    /* name | badge | values | mini-bar | label */
    grid-template-columns: 1fr auto auto 120px 52px;
    align-items: center;
    gap: 6px;
    font-size: 0.8rem;
  }

  .bd-name {
    font-weight: 600;
    color: $gray-800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .bd-badge {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    white-space: nowrap;
    background: hsl(213, 100%, 94%);
    color: hsl(213, 80%, 38%);
    border: 1px solid hsl(213, 80%, 80%);
    &.bd-badge-prop {
      background: $gray-100;
      color: $gray-500;
      border-color: $gray-300;
    }
  }

  .bd-values {
    //color: $gray-500;
    color: black;
    white-space: nowrap;
    font-size: 0.8rem;
  }

  /* ── Per-row diverging mini-bar ───────────────────────────────── */
  .bd-bar-wrap {
    display: flex;
    align-items: center;
    height: 7px;

    .bd-bar-neg-side {
      flex: 1;
      height: 100%;
      display: flex;
      justify-content: flex-end;
      background: hsl(0, 0%, 93%);
      border-radius: 3px 0 0 3px;
      overflow: hidden;
    }

    .bd-bar-center {
      width: 1px;
      height: 100%;
      background: $gray-400;
      flex-shrink: 0;
    }

    .bd-bar-pos-side {
      flex: 1;
      height: 100%;
      display: flex;
      justify-content: flex-start;
      background: hsl(0, 0%, 93%);
      border-radius: 0 3px 3px 0;
      overflow: hidden;
    }

    .bd-bar-fill { height: 100%; }
    .bd-bar-neg  { background: hsl(4,   89%, 48%); border-radius: 3px 0 0 3px; }
    .bd-bar-pos  { background: hsl(213, 89%, 44%); border-radius: 0 3px 3px 0; }
  }

  /* ── Label column (pp + %) ────────────────────────────────────── */
  .bd-pct {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;

    &.bd-pct-pos {
      .bd-pct-val { color: hsl(213, 80%, 40%); }
      .bd-pct-sub { color: hsl(213, 60%, 60%); }
    }
    &.bd-pct-neg {
      .bd-pct-val { color: hsl(4, 70%, 42%); }
      .bd-pct-sub { color: hsl(4, 60%, 62%); }
    }

    .bd-pct-val {
      font-size: 0.8rem;
      font-weight: 700;
      line-height: 1;
    }
    .bd-pct-sub {
      font-size: 0.78rem;
      font-weight: 650;
      line-height: 1;
    }
  }
</style>
