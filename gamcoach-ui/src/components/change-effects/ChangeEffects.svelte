<script>
  // @ts-check
  // "Effects of your changes" — right-panel section (below "What's driving this
  // score"). Display-only: renders the source-edit events produced by
  // FeaturePanel from the engine's existing propagation output. No propagation
  // or decomposition logic lives here.
  import { onDestroy } from 'svelte';
  import { changeEffectsStore } from '../../store';

  const BLUE = '#185FA5'; // helps approval
  const RED = '#A32D2D'; // hurts approval

  /** @type {Array<any>} */
  let events = [];
  const unsub = changeEffectsStore.subscribe((v) => (events = v));
  onDestroy(unsub);

  let collapsed = false; // section hide/unhide (name stays visible)

  // Short, friendly labels for the compact row layout.
  const SHORT_NAMES = {
    home_ownership: 'Home Ownership',
    annual_inc: 'Annual Income',
    loan_amnt: 'Loan Amount',
    revol_bal: 'Revolving Balance',
    revol_util: 'Credit Utilization',
    term: 'Payment Period',
    purpose: 'Loan Purpose',
    inq_last_6mths: 'Credit Inquiries',
    mort_acc: 'Mortgages',
    open_acc: 'Open Accts',
    total_acc: 'All Accts',
    fico_score: 'FICO',
    dti: 'Debt to Income'
  };
  const shortName = (name, fallback) => SHORT_NAMES[name] || fallback || name;

  // Source feature → neutral icon key. Money → dollar, home ownership → home,
  // then a sensible icon per feature type.
  const SOURCE_ICON = {
    loan_amnt: 'dollar',
    annual_inc: 'dollar',
    revol_bal: 'dollar',
    home_ownership: 'home',
    revol_util: 'percent',
    term: 'calendar',
    purpose: 'tag',
    inq_last_6mths: 'hash',
    open_acc: 'hash',
    mort_acc: 'hash',
    total_acc: 'hash'
  };
  const iconFor = (name) => SOURCE_ICON[name] || 'dollar';

  // Tabler-style outline SVGs (stroke = currentColor; color set by the wrapper).
  const A =
    'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  // Thumb attrs — hollow (no fill) with a thick colored border.
  const T =
    'viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    // ti-currency-dollar
    dollar: `<svg ${A}><path d="M16.7 8a3 3 0 0 0 -2.7 -2h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6h-4a3 3 0 0 1 -2.7 -2"/><path d="M12 3v3m0 12v3"/></svg>`,
    // ti-home
    home: `<svg ${A}><path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"/><path d="M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"/></svg>`,
    // ti-percentage
    percent: `<svg ${A}><path d="M17 5l-10 14"/><path d="M6.5 6.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/><path d="M17.5 17.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/></svg>`,
    // ti-calendar
    calendar: `<svg ${A}><path d="M4 7a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12z"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M4 11h16"/></svg>`,
    // ti-tag
    tag: `<svg ${A}><path d="M7.5 7.5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M3 6v5.172a2 2 0 0 0 .586 1.414l7.71 7.71a2.41 2.41 0 0 0 3.408 0l5.592 -5.592a2.41 2.41 0 0 0 0 -3.408l-7.71 -7.71a2 2 0 0 0 -1.414 -.586h-5.172a3 3 0 0 0 -3 3z"/></svg>`,
    // ti-hash
    hash: `<svg ${A}><path d="M5 9l14 0"/><path d="M5 15l14 0"/><path d="M11 4l-4 16"/><path d="M17 4l-4 16"/></svg>`,
    // ti-arrow-narrow-right (connector)
    arrow: `<svg ${A}><path d="M5 12l14 0"/><path d="M15 16l4 -4"/><path d="M15 8l4 4"/></svg>`,
    // ti-thumb-up (outline, thick border)
    thumbUp: `<svg ${T}><path d="M7 11v8a1 1 0 0 1 -1 1h-3a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h4a5 5 0 0 0 5 -5v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"/></svg>`,
    // ti-thumb-down (outline, thick border)
    thumbDown: `<svg ${T}><path d="M7 13v-8a1 1 0 0 0 -1 -1h-3a1 1 0 0 0 -1 1v7a1 1 0 0 0 1 1h4a5 5 0 0 1 5 5v1a2 2 0 0 0 4 0v-5h3a2 2 0 0 0 2 -2l-1 -5a2 3 0 0 0 -2 -2h-7a3 3 0 0 0 -3 3"/></svg>`,
    // ti-hand-finger (empty state)
    hand: `<svg ${A}><path d="M8 13v-8.5a1.5 1.5 0 0 1 3 0v7.5"/><path d="M11 11.5v-2a1.5 1.5 0 0 1 3 0v2.5"/><path d="M14 10.5a1.5 1.5 0 0 1 3 0v1.5"/><path d="M17 11.5a1.5 1.5 0 0 1 3 0v4.5a6 6 0 0 1 -6 6h-2h.208a6 6 0 0 1 -5.012 -2.7a69.74 69.74 0 0 1 -.196 -.3c-.312 -.479 -1.407 -2.388 -3.286 -5.728a1.5 1.5 0 0 1 .536 -2.022a1.867 1.867 0 0 1 2.28 .28l1.988 1.984"/></svg>`
  };

  // Combined causal explanation for the per-row info hover.
  const rowTooltip = (ev) => ev.effects.map((e) => e.tooltip).join('\n\n');
</script>

<div class="change-effects">
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="ce-title" class:ce-title-empty={events.length === 0} on:click={() => (collapsed = !collapsed)}>
    Effects of your changes
    <span
      class="ce-info"
      title="How each feature you edit ripples through your application, and whether each ripple helps or hurts your approval."
      >i</span
    >
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
      {#each events as ev (ev.sourceName)}
        <div class="ce-row">
          <!-- Per-row causal-link info (left) -->
          <span class="ce-info ce-row-info" title={rowTooltip(ev)}>i</span>

          <!-- Source -->
          <div class="ce-source">
            <span class="ce-src-icon">{@html ICONS[iconFor(ev.sourceName)]}</span>
            <div class="ce-src-name">{shortName(ev.sourceName, ev.sourceDisplayName)}</div>
            <div class="ce-src-val">{ev.sourceValueDisplay}</div>
          </div>

          <!-- Connector -->
          <span class="ce-arrow">{@html ICONS.arrow}</span>

          <!-- Effect(s) -->
          <div class="ce-effects">
            {#each ev.effects as ef}
              <div class="ce-effect">
                <span class="ce-thumb" style="color:{ef.helps ? BLUE : RED}">
                  {@html ef.helps ? ICONS.thumbUp : ICONS.thumbDown}
                </span>
                <div class="ce-eff-name">{shortName(ef.depName, ef.depDisplayName)}</div>
                <div class="ce-eff-val">{ef.beforeDisplay} &rarr; {ef.afterDisplay}</div>
              </div>
            {/each}
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
      font-size: 0.85rem;
      line-height: 1.5;
    }
  }

  /* ── Header + legend ─────────────────────────────────────────────────── */
  .ce-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 1rem;
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

  .ce-info {
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
    flex: 0 0 auto;
  }

  .ce-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin-bottom: 12px;
    font-size: 0.82rem;
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

    &:first-child {
      border-top: none;
    }
  }

  .ce-row-info {
    align-self: center;
  }

  .ce-source {
    flex: 0 0 auto;
    width: 88px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 4px;

    .ce-src-icon {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: $gray-100;
      color: $gray-500;
      display: flex;
      align-items: center;
      justify-content: center;

      :global(svg) {
        width: 23px;
        height: 23px;
      }
    }

    .ce-src-name {
      font-size: 0.82rem;
      color: $gray-700;
      line-height: 1.2;
    }

    .ce-src-val {
      font-size: 0.84rem;
      font-weight: 700;
      color: $gray-900;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
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

  .ce-effect {
    flex: 0 0 auto;
    min-width: 58px;
    max-width: 110px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 3px;

    .ce-eff-name {
      font-size: 0.8rem;
      color: $gray-700;
      line-height: 1.2;
    }

    .ce-eff-val {
      font-size: 0.84rem;
      font-weight: 700;
      color: $gray-900;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
  }
</style>
