<script>
  import { historySidebarOpenStore, historyEntriesStore } from '../../store';

  /** The currently active plan index */
  export let activePlanIndex = 0;

  /** Callback to restore a history entry state: (entry) => void */
  export let onRestoreEntry = null;

  let expandedUnchanged = new Set(); // display indices with expanded "unchanged"

  // A propagated change whose per-feature contribution is within ±this (log-odds)
  // is neutral — the value moved but the score didn't.
  const CONTRIB_EPS = 1e-6;

  $: planEntries = $historyEntriesStore?.get(activePlanIndex) || [];

  const toggleUnchangedExpanded = (idx) => {
    if (expandedUnchanged.has(idx)) expandedUnchanged.delete(idx);
    else expandedUnchanged.add(idx);
    expandedUnchanged = expandedUnchanged; // reactivity
  };

  // Restore is a move-to-end relocation (handled by the parent) — nothing is
  // deleted, so it applies immediately without a confirmation dialog.
  const restore = (entry) => onRestoreEntry && onRestoreEntry(entry);

  /** Color bucket for a propagated value, from its per-feature contribution. */
  const contribColor = (c) =>
    (c ?? 0) > CONTRIB_EPS ? 'up' : (c ?? 0) < -CONTRIB_EPS ? 'down' : 'neutral';
</script>

{#if $historySidebarOpenStore}
  <div class="sidebar-panel">
    <div class="sidebar-header">
      <h2>Exploration History</h2>
    </div>

    <div class="entries-list">
      {#if planEntries.length === 0}
        <div class="no-entries">No entries yet. Start modifying features to build your history.</div>
      {:else}
        {#each [...planEntries].reverse() as entry, idx (idx)}
          {@const userFeats = entry.features.filter(f => !f.isAuto)}
          {@const autoFeats = entry.features.filter(f => f.isAuto)}
          <div class="entry-card">

            <!-- Header: entry number + approval % (anchor) · Restore -->
            <div class="entry-header">
              <div class="entry-info">
                <span class="entry-number">Entry {entry.entryNumber}</span>
                <span class="entry-score">{entry.probPct}%</span>
              </div>
              <button class="restore-btn" on:click={() => restore(entry)} title="Restore this state">
                Restore
              </button>
            </div>

            <!-- You changed (always present) -->
            {#if userFeats.length > 0}
              <div class="group">
                <div class="group-label">You changed</div>
                {#each userFeats as feat (feat.featureID)}
                  <div class="feat-row user">
                    <span class="feat-name">{feat.name}</span>
                    <span class="feat-val">
                      <span class="from">{feat.displayOldValue}</span>
                      <span class="arrow">&rarr;</span>
                      <span class="to">{feat.displayNewValue}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- This caused (only when propagation occurred) -->
            {#if autoFeats.length > 0}
              <div class="group group-caused">
                <div class="group-label">This caused</div>
                {#each autoFeats as feat (feat.featureID)}
                  <div class="feat-row caused">
                    <span class="feat-name">{feat.name}</span>
                    <span class="feat-val">
                      <span class="from">{feat.displayOldValue}</span>
                      <span class="arrow">&rarr;</span>
                      <span class="to val-{contribColor(feat.contribution)}">{feat.displayNewValue}</span>
                    </span>
                  </div>
                {/each}
              </div>
            {/if}

            <!-- Unchanged rollup (collapsed by default) -->
            {#if entry.unchangedFeatures && entry.unchangedFeatures.length > 0}
              <button class="uc-toggle" on:click={() => toggleUnchangedExpanded(idx)}>
                <span class="uc-arrow">{expandedUnchanged.has(idx) ? '▾' : '▸'}</span>
                {entry.unchangedFeatures.length} unchanged
              </button>
              {#if expandedUnchanged.has(idx)}
                <div class="uc-list">
                  {#each entry.unchangedFeatures as feat (feat.featureID)}
                    <div class="feat-row uc">
                      <span class="feat-name">{feat.name}</span>
                      <span class="feat-val">{feat.displayValue}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            {/if}

          </div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  $c-up: #185FA5;
  $c-down: #A32D2D;

  .sidebar-panel {
    position: fixed;
    right: 0; top: 0; bottom: 0;
    width: 320px;
    background: white;
    border-left: 1px solid $gray-300;
    box-shadow: -2px 0 8px hsla(0, 0%, 0%, 0.06);
    z-index: 9997;
    display: flex;
    flex-direction: column;
    animation: slideInRight 200ms ease-out;
  }

  @keyframes slideInRight {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
  }

  .sidebar-header {
    flex: 0 0 auto;
    padding: 16px;
    border-bottom: 1px solid $gray-200;
    background: $gray-50;

    h2 {
      margin: 0;
      font-size: 1rem;
      font-weight: 700;
      color: $gray-900;
      letter-spacing: 0.05em;
    }
  }

  .entries-list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .no-entries {
    padding: 24px 16px;
    text-align: center;
    color: $gray-500;
    font-size: 0.9rem;
    line-height: 1.4;
  }

  /* ── Entry card ──────────────────────────────────── */
  .entry-card {
    padding: 12px 14px;
    background: white;
    border: 1px solid $gray-400;
    border-radius: 8px;
    flex: 0 0 auto;
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .entry-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .entry-number {
    font-size: 0.9rem;
    font-weight: 700;
    color: $gray-700;
    letter-spacing: 0.04em;
  }

  .entry-score {
    font-size: 22px;
    font-weight: 800;
    color: $gray-900;
    line-height: 1;
  }

  .restore-btn {
    flex: 0 0 auto;
    padding: 5px 14px;
    font-size: 0.8rem;
    font-weight: 600;
    background: $blue-600;
    color: white;
    border: none;
    border-radius: 5px;
    cursor: pointer;
    transition: background 150ms;
    &:hover { background: $blue-700; }
    &:active { background: $blue-800; }
  }

  /* ── Groups ──────────────────────────────────────── */
  .group { margin-top: 8px; }

  .group-caused {
    margin-top: 10px;
    padding-top: 9px;
    border-top: 1px solid $gray-200;
  }

  .group-label {
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: $gray-500;
    margin-bottom: 5px;
  }

  .feat-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 2px 0;
  }

  .feat-name {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .feat-val {
    flex: 0 0 auto;
    text-align: right;
    font-variant-numeric: tabular-nums;

    /* "from" and arrow are muted so the "to" value stays the emphasis. */
    .from  { color: $gray-400; font-weight: 500; }
    .arrow { color: $gray-400; margin: 0 3px; }
    .to    { font-weight: 700; }
  }

  /* Both groups share the same row font (size + weight); only the "to" value
     color differs — primary in "You changed", contribution-colored in "This
     caused". */
  .feat-row.user, .feat-row.caused {
    .feat-name { font-size: 15px; font-weight: 500; color: $gray-800; }
    .feat-val  { font-size: 15px; }
  }

  .feat-row.user .feat-val .to { color: $gray-900; }

  .feat-row.caused .feat-val {
    .to.val-up      { color: $c-up; }
    .to.val-down    { color: $c-down; }
    .to.val-neutral { color: $gray-700; }
  }

  /* ── Unchanged rollup ────────────────────────────── */
  .uc-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin-top: 10px;
    padding: 4px 0 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    color: $gray-500;
    text-align: left;
    &:hover { color: $gray-700; }
    .uc-arrow { width: 9px; }
  }

  .uc-list {
    margin-top: 4px;
    .feat-row.uc {
      .feat-name { font-size: 0.8rem; color: $gray-500; }
      .feat-val  { font-size: 0.8rem; color: $gray-500; }
    }
  }
</style>
