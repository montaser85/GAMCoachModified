<script>
  import { slide } from 'svelte/transition';
  import { historySidebarOpenStore, historyEntriesStore } from '../../store';
  import { toggleSaveEntry, MAX_SAVED_ENTRIES } from '../../utils/historyManager';

  /** The currently active plan index */
  export let activePlanIndex = 0;

  /** Callback to restore a history entry state: (entry) => void */
  export let onRestoreEntry = null;

  // A contribution within ±this (log-odds) is neutral — value moved, score didn't.
  const CONTRIB_EPS = 1e-6;

  // Collapsibles keyed by entry timestamp (stable across re-indexing).
  // The "N features changed" group is EXPANDED by default — we track the set of
  // entries the user has explicitly COLLAPSED instead. The "unchanged" group keeps
  // the opposite convention (collapsed by default → track what's expanded).
  let collapsedChanged = new Set();
  let expandedUnchanged = new Set();

  // Transient nudge banner (e.g. the 5-saved cap message).
  let nudge = null;
  let nudgeTimer = null;

  $: planEntries = $historyEntriesStore?.get(activePlanIndex) || [];

  const toggleChanged = (key) => {
    if (collapsedChanged.has(key)) collapsedChanged.delete(key);
    else collapsedChanged.add(key);
    collapsedChanged = collapsedChanged; // reactivity
  };

  const toggleUnchanged = (key) => {
    if (expandedUnchanged.has(key)) expandedUnchanged.delete(key);
    else expandedUnchanged.add(key);
    expandedUnchanged = expandedUnchanged;
  };

  // Restore is a move-to-end relocation (handled by the parent) — nothing is
  // deleted, so it applies immediately without a confirmation dialog.
  const restore = (entry) => onRestoreEntry && onRestoreEntry(entry);

  /** Color bucket for a changed value, from its per-feature contribution. */
  const contribColor = (c) =>
    (c ?? 0) > CONTRIB_EPS ? 'up' : (c ?? 0) < -CONTRIB_EPS ? 'down' : 'neutral';

  const showNudge = (msg) => {
    nudge = msg;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { nudge = null; }, 3500);
  };

  const starClicked = (entry) => {
    historyEntriesStore.update((map) => {
      const res = toggleSaveEntry(map, activePlanIndex, entry);
      if (!res.ok && res.reason === 'cap') {
        showNudge(`You can save up to ${MAX_SAVED_ENTRIES} plans — unsave one to save this`);
      }
      return res.map;
    });
  };
</script>

{#if $historySidebarOpenStore}
  <div class="sidebar-panel">
    <div class="sidebar-header">
      <h2>Exploration History</h2>
    </div>

    <div class="list-caption">Newest first</div>

    {#if nudge}
      <div class="nudge">{nudge}</div>
    {/if}

    <div class="entries-list">
      {#if planEntries.length === 0}
        <div class="no-entries">No entries yet. Start modifying features to build your history.</div>
      {:else}
        {#each [...planEntries].reverse() as entry (entry.timestamp)}
          <div class="entry-card" class:saved={entry.saved}>

            <!-- Header: entry number + approval % · star + Restore -->
            <div class="entry-header">
              <div class="entry-info">
                <span class="entry-number">Entry {entry.entryNumber}</span>
                <!-- Approval keys off the TRUE probability (predScore ≥ 0 ⇔ prob ≥ 0.5),
                     matching the main score line's honesty rule — not the rounded %. -->
                <span class="entry-score" class:below={entry.score < 0}>{entry.probPct}%</span>
                <span
                  class="entry-approval"
                  class:approved={entry.score >= 0}
                  class:rejected={entry.score < 0}
                  title={entry.score >= 0 ? 'Approved' : 'Not approved'}
                >{entry.score >= 0 ? '✓' : '✗'}</span>
              </div>
              <div class="entry-actions">
                <button
                  class="star-btn"
                  class:starred={entry.saved}
                  on:click={() => starClicked(entry)}
                  title={entry.saved ? 'Unsave this entry' : 'Save this entry'}
                >
                  {entry.saved ? '★' : '☆'}
                </button>
                <button class="restore-btn" on:click={() => restore(entry)} title="Restore this state">
                  Restore
                </button>
              </div>
            </div>

            <!-- N features changed (vs load-time baseline) — EXPANDED by default -->
            {#if entry.features.length > 0}
              <button class="group-toggle" on:click={() => toggleChanged(entry.timestamp)}>
                <span class="gt-arrow">{!collapsedChanged.has(entry.timestamp) ? '▾' : '▸'}</span>
                <span class="gt-label"><b class="feat-count">{entry.features.length}</b> feature{entry.features.length !== 1 ? 's' : ''} now different from your profile values</span>
              </button>
              {#if !collapsedChanged.has(entry.timestamp)}
                <div class="group-list" transition:slide={{ duration: 150 }}>
                  {#each entry.features as feat (feat.featureID)}
                    <div class="feat-row">
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
            {/if}

            <!-- N unchanged — collapsed by default -->
            {#if entry.unchangedFeatures && entry.unchangedFeatures.length > 0}
              <button class="group-toggle" on:click={() => toggleUnchanged(entry.timestamp)}>
                <span class="gt-arrow">{expandedUnchanged.has(entry.timestamp) ? '▾' : '▸'}</span>
                {entry.unchangedFeatures.length} unchanged
              </button>
              {#if expandedUnchanged.has(entry.timestamp)}
                <div class="group-list" transition:slide={{ duration: 150 }}>
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
  $c-saved: hsl(35, 90%, 46%);

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

  // "Newest first" caption above the entries, right-aligned.
  .list-caption {
    flex: 0 0 auto;
    padding: 8px 12px 0;
    text-align: right;
    font-size: 0.78rem;
    font-style: italic;
    color: $gray-500;
  }

  .nudge {
    flex: 0 0 auto;
    margin: 8px 10px 0;
    padding: 8px 12px;
    background: hsl(35, 100%, 94%);
    border: 1px solid hsl(35, 80%, 72%);
    border-radius: 6px;
    font-size: 0.85rem;
    color: hsl(35, 80%, 26%);
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

    /* Saved entries: darker accent border + filled star */
    &.saved {
      border: 2px solid $c-saved;
      padding: 11px 13px; /* keep content width stable despite thicker border */
    }
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
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
    color: $gray-900;      // ≥ approval: black (current style)
    line-height: 1;

    &.below { color: $gray-500; } // below approval: gray
  }

  // Approval status icon — same glyphs/colors as the main score line
  // ("✓ Approved" green / "✗ Not approved" red).
  .entry-approval {
    font-size: 1.05rem;
    font-weight: 800;
    line-height: 1;
    cursor: default;

    &.approved { color: hsl(140, 55%, 34%); }
    &.rejected { color: $red-600; }
  }

  .entry-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .star-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 1.25rem;
    line-height: 1;
    padding: 2px 4px;
    color: $gray-400;
    transition: color 150ms;

    &:hover { color: $c-saved; }
    &.starred { color: $c-saved; }
  }

  .restore-btn {
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

  /* ── Collapsible groups ──────────────────────────── */
  .group-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    margin-top: 6px;
    padding: 3px 0;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    color: $gray-600;
    text-align: left;
    &:hover { color: $gray-900; }
    .gt-arrow { width: 9px; flex: 0 0 auto; color: $gray-500; align-self: flex-start; margin-top: 1px; }
    // Keep the count and the full sentence as ONE flowing text block so the number
    // sits inline on the first line (not a separately-centered flex item).
    .gt-label { min-width: 0; }
    .feat-count { color: $gray-900; } // the count in bold black
  }

  .group-list {
    margin: 2px 0 4px 15px;
  }

  .feat-row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 2px 0;

    .feat-name {
      min-width: 0;
      // Show the FULL feature name — wrap instead of truncating with an ellipsis.
      white-space: normal;
      overflow-wrap: break-word;
      font-size: 15px;
      font-weight: 500;
      color: $gray-800;
    }

    .feat-val {
      flex: 0 0 auto;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-size: 15px;

      .from  { color: $gray-900; font-weight: 500; } // "before" value in black
      .arrow { color: $gray-400; margin: 0 3px; }
      .to    { font-weight: 700; }
      .to.val-up      { color: $c-up; }
      .to.val-down    { color: $c-down; }
      .to.val-neutral { color: $gray-800; }
    }

    /* Unchanged rows: quieter */
    &.uc {
      .feat-name { font-size: 0.85rem; color: $gray-500; font-weight: 400; }
      .feat-val  { font-size: 0.85rem; color: $gray-500; }
    }
  }

</style>
