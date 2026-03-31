<script>
  import { breakdownPopupStore } from '../store';

  const POPUP_WIDTH = 420;
  const SEGMENT_COLORS = [
    'hsl(206, 89.74%, 44%)',
    'hsl(174, 100%, 29.41%)',
    'hsl(291, 63.72%, 42.16%)',
    'hsl(35, 100%, 45%)',
    'hsl(122, 39.44%, 39%)',
    'hsl(4, 89.62%, 48%)',
  ];

  let hideTimer = null;

  const keepPopup = () => clearTimeout(hideTimer);

  const scheduleHide = () => {
    // Never auto-hide when pinned (user clicked to lock it open).
    if ($breakdownPopupStore.pinned) return;
    hideTimer = setTimeout(() => {
      breakdownPopupStore.update(v => v.pinned ? v : { ...v, show: false });
    }, 150);
  };

  const closePopup = () => {
    clearTimeout(hideTimer);
    breakdownPopupStore.set({ show: false, x: 0, y: 0, data: null, pinned: false });
  };
</script>

{#if $breakdownPopupStore.show}
  <div
    class="bd-popup"
    class:bd-pinned={$breakdownPopupStore.pinned}
    style="left:{Math.min($breakdownPopupStore.x, window.innerWidth - POPUP_WIDTH - 8)}px;
           top:{$breakdownPopupStore.y}px; width:{POPUP_WIDTH}px"
    on:mouseenter={keepPopup}
    on:mouseleave={scheduleHide}
    role="tooltip"
  >
    {#if $breakdownPopupStore.data}
      {@const d = $breakdownPopupStore.data}

      <div class="bd-header">
        <div class="bd-header-top">
          <div class="bd-header-left">
            <span class="bd-scores">{d.origPct}% → {d.curPct}%</span>
            <span class="bd-delta"
              class:bd-delta-pos={d.deltaPP > 0}
              class:bd-delta-neg={d.deltaPP < 0}>
              {d.deltaPP > 0 ? '+' : ''}{d.deltaPP}pp
            </span>
          </div>
          {#if $breakdownPopupStore.pinned}
            <button class="bd-close" on:click={closePopup} title="Close">✕</button>
          {/if}
        </div>
        <div class="bd-subtitle">SCORE CHANGE BREAKDOWN</div>
      </div>

      <div class="bd-stacked-bar">
        {#each d.features as feat, i}
          <div class="bd-segment"
            style="width:{feat.proportion * 100}%;
                   background:{SEGMENT_COLORS[i % SEGMENT_COLORS.length]}"
            title="{feat.displayName}: {Math.round(feat.proportion * 100)}%"
          />
        {/each}
      </div>

      <div class="bd-rows">
        {#each d.features as feat, i}
          <div class="bd-row">
            <span class="bd-dot"
              style="background:{SEGMENT_COLORS[i % SEGMENT_COLORS.length]}">
            </span>
            <span class="bd-name">{feat.displayName}</span>
            <span class="bd-badge" class:bd-badge-prop={feat.isPropagated}>
              {feat.isPropagated ? 'PROPAGATED' : 'DIRECT'}
            </span>
            <span class="bd-values">{feat.origValStr} → {feat.curValStr}</span>
            <div class="bd-bar-wrap">
              <div class="bd-bar"
                style="width:{feat.proportion * 100}%;
                       background:{SEGMENT_COLORS[i % SEGMENT_COLORS.length]}">
              </div>
            </div>
            <span class="bd-pct">{Math.round(feat.proportion * 100)}%</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style lang="scss">
  @import '../define';

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

    // Slightly stronger border when pinned so the user knows it's locked.
    &.bd-pinned {
      border-color: $gray-400;
      box-shadow: 0 4px 24px hsla(0, 0%, 0%, 0.2);
    }

    .bd-header {
      margin-bottom: 8px;

      .bd-header-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 2px;
      }

      .bd-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .bd-scores {
        font-size: 1.05rem;
        font-weight: 700;
        color: $gray-900;
      }

      .bd-delta {
        font-size: 0.85rem;
        font-weight: 700;
        padding: 1px 7px;
        border-radius: 10px;
        &.bd-delta-pos {
          background: $blue-50;
          color: $blue-700;
          border: 1px solid $blue-200;
        }
        &.bd-delta-neg {
          background: $red-50;
          color: $red-700;
          border: 1px solid $red-200;
        }
      }

      .bd-close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 0.85rem;
        color: $gray-400;
        line-height: 1;
        padding: 2px 4px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
        &:hover {
          color: $gray-700;
          background: $gray-100;
        }
      }

      .bd-subtitle {
        font-size: 0.7rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        color: $gray-500;
        text-transform: uppercase;
      }
    }

    .bd-stacked-bar {
      display: flex;
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 10px;
      background: $gray-200;

      .bd-segment {
        height: 100%;
        transition: opacity 0.15s;
        &:hover { opacity: 0.8; }
      }
    }

    .bd-rows {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }

    .bd-row {
      display: grid;
      grid-template-columns: 10px 1fr auto auto 80px 32px;
      align-items: center;
      gap: 6px;
      font-size: 0.76rem;

      .bd-dot {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        flex-shrink: 0;
      }

      .bd-name {
        font-weight: 600;
        color: $gray-800;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .bd-badge {
        font-size: 0.65rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        padding: 1px 5px;
        border-radius: 3px;
        background: $blue-50;
        color: $blue-700;
        border: 1px solid $blue-200;
        white-space: nowrap;
        &.bd-badge-prop {
          background: $gray-100;
          color: $gray-600;
          border-color: $gray-300;
        }
      }

      .bd-values {
        color: $gray-600;
        white-space: nowrap;
        font-size: 0.72rem;
      }

      .bd-bar-wrap {
        height: 5px;
        background: $gray-200;
        border-radius: 3px;
        overflow: hidden;

        .bd-bar {
          height: 100%;
          border-radius: 3px;
        }
      }

      .bd-pct {
        font-weight: 700;
        color: $gray-700;
        text-align: right;
      }
    }
  }
</style>
