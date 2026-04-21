<script>
  import { historySidebarOpenStore, historyEntriesStore } from '../../store';

  /** The currently active plan index */
  export let activePlanIndex = 0;

  /** Callback to restore a history entry state: (entry) => void */
  export let onRestoreEntry = null;


  let confirmTooltip = null;
  let confirmingEntry = null;
  let expandedUnchanged = new Set();  // Track which entries have expanded unchanged features

  $: planEntries = $historyEntriesStore?.get(activePlanIndex) || [];

  /**
   * Toggle expanded state for unchanged features
   */
  const toggleUnchangedExpanded = (entryIndex) => {
    if (expandedUnchanged.has(entryIndex)) {
      expandedUnchanged.delete(entryIndex);
    } else {
      expandedUnchanged.add(entryIndex);
    }
    expandedUnchanged = expandedUnchanged;  // Trigger reactivity
  };

  /**
   * Show confirmation tooltip when entry is clicked
   */
  const handleEntryClick = (e, entryIndex) => {
    const rect = e.currentTarget.getBoundingClientRect();
    confirmTooltip = {
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      entryIndex
    };
    confirmingEntry = planEntries[entryIndex];
  };

  /**
   * Confirm restoration and call callback
   */
  const confirmRestore = () => {
    if (confirmingEntry && onRestoreEntry) {
      onRestoreEntry(confirmingEntry);
    }
    confirmTooltip = null;
    confirmingEntry = null;
  };

  /**
   * Cancel restoration
   */
  const cancelRestore = () => {
    confirmTooltip = null;
    confirmingEntry = null;
  };


  /**
   * Format a feature value for display
   */
  function formatValue(val, feature) {
    if (val === null || val === undefined) return '—';
    if (typeof val === 'string') return val;
    if (typeof val === 'number') {
      if (val >= 1000) {
        return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
      }
      return val.toFixed(2);
    }
    return String(val);
  }
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
            <div
              class="entry-card"
              on:click={(e) => handleEntryClick(e, idx)}
              role="button"
              tabindex="0"
              title={entry.timestamp ? new Date(entry.timestamp).toLocaleString() : ''}
            >
              <!-- Entry Header -->
              <div class="entry-header">
                <div class="entry-info">
                  <span class="entry-number">Entry {entry.entryNumber}</span>
                  <span class="entry-score">{entry.probPct}%</span>
                </div>
              </div>

              <!-- Direct Features -->
              {#if entry.features.some(f => !f.isAuto)}
                <div class="features-group">
                  <div class="group-label direct">DIRECT</div>
                  {#each entry.features.filter(f => !f.isAuto) as feat (feat.featureID)}
                    <div class="feature-row direct">
                      <span class="feature-name">{feat.name}</span>
                      <span class="feature-values">
                        {feat.displayNewValue}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}

              <!-- Auto-Changed Features -->
              {#if entry.features.some(f => f.isAuto)}
                <div class="features-group">
                  <div class="group-label auto">↔ AUTO</div>
                  {#each entry.features.filter(f => f.isAuto) as feat (feat.featureID)}
                    <div class="feature-row auto">
                      <span class="feature-name">{feat.name}</span>
                      <span class="feature-values">
                        {feat.displayNewValue}
                      </span>
                    </div>
                  {/each}
                </div>
              {/if}

              <!-- Unchanged Features (Collapsible) -->
              {#if entry.unchangedFeatures && entry.unchangedFeatures.length > 0}
                <div class="features-group">
                  <button
                    class="group-label-btn unchanged"
                    on:click={() => toggleUnchangedExpanded(idx)}
                    title="Toggle unchanged features"
                  >
                    <span class="expand-icon">
                      {expandedUnchanged.has(idx) ? '▼' : '▶'}
                    </span>
                    <span>UNCHANGED ({entry.unchangedFeatures.length})</span>
                  </button>
                  {#if expandedUnchanged.has(idx)}
                    <div class="unchanged-features-list">
                      {#each entry.unchangedFeatures as feat (feat.featureID)}
                        <div class="feature-row unchanged">
                          <span class="feature-name">{feat.name}</span>
                          <span class="feature-values">
                            {feat.displayValue}
                          </span>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    </div>
  {/if}

  <!-- Confirmation Tooltip -->
  {#if confirmTooltip}
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div class="confirm-overlay" on:click={cancelRestore} />
    <div
      class="confirm-tooltip"
      style="left: {confirmTooltip.x}px; top: {confirmTooltip.y}px"
    >
      <div class="confirm-message">Restore this state?</div>
      <div class="confirm-buttons">
        <button class="btn-confirm" on:click={confirmRestore}>Confirm</button>
        <button class="btn-cancel" on:click={cancelRestore}>Cancel</button>
      </div>
    </div>
  {/if}

<style lang="scss">
  @import '../../define';

  /* ── Sidebar Panel ────────────────────────────────── */
  .sidebar-panel {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
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
    from {
      transform: translateX(100%);
    }
    to {
      transform: translateX(0);
    }
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
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .no-entries {
    padding: 24px 16px;
    text-align: center;
    color: $gray-500;
    font-size: 0.85rem;
    line-height: 1.4;
  }

  /* ── Entry Card ──────────────────────────────────── */
  .entry-card {
    padding: 12px;
    background: white;
    border: 1px solid $gray-200;
    border-radius: 6px;
    cursor: pointer;
    transition: all 150ms;
    flex: 0 0 auto;

    &:hover {
      background: $gray-50;
      border-color: $gray-300;
      box-shadow: 0 2px 4px hsla(0, 0%, 0%, 0.04);
    }
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 10px;
    gap: 8px;
  }

  .entry-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }

  .entry-number {
    font-size: 0.8rem;
    font-weight: 700;
    color: $gray-700;
    letter-spacing: 0.06em;
  }

  .entry-score {
    font-size: 1rem;
    font-weight: 800;
    color: $gray-900;
  }

  /* ── Features Groups ─────────────────────────────── */
  .features-group {
    margin-bottom: 8px;

    &:last-child {
      margin-bottom: 0;
    }
  }

  .group-label {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 4px;
    padding: 0 4px;

    &.direct {
      color: $gray-700;
    }

    &.auto {
      color: $gray-500;
    }
  }

  .group-label-btn {
    background: none;
    border: none;
    padding: 0 4px;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    color: $gray-500;
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 4px;
    transition: color 150ms;

    &:hover {
      color: $gray-600;
    }

    &.unchanged {
      color: $gray-500;
    }
  }

  .expand-icon {
    display: inline-block;
    font-size: 0.5rem;
    width: 0.5rem;
    text-align: center;
    transition: transform 150ms;
  }

  .unchanged-features-list {
    margin-bottom: 8px;
  }

  .feature-row {
    font-size: 0.75rem;
    line-height: 1.3;
    padding: 4px 6px;
    margin-bottom: 3px;
    border-radius: 3px;
    display: flex;
    justify-content: space-between;
    gap: 4px;

    &.direct {
      color: $gray-800;
      font-weight: 500;
      background: hsla(0, 0%, 0%, 0.02);
    }

    &.auto {
      color: $gray-600;
      font-weight: 400;
      background: hsla(0, 0%, 0%, 0.01);
    }

    &.unchanged {
      color: $gray-500;
      font-weight: 400;
      background: hsla(0, 0%, 0%, 0.005);
      opacity: 0.8;
    }

    &:last-child {
      margin-bottom: 0;
    }
  }

  .feature-name {
    flex: 0 0 auto;
    max-width: 60%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .feature-values {
    flex: 1 1 auto;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: inherit;
    opacity: 0.85;
  }

  /* ── Confirmation Tooltip ────────────────────────── */
  .confirm-overlay {
    position: fixed;
    inset: 0;
    z-index: 9998;
  }

  .confirm-tooltip {
    position: fixed;
    z-index: 9999;
    background: white;
    border: 1px solid $gray-300;
    border-radius: 6px;
    padding: 12px;
    box-shadow: 0 4px 16px hsla(0, 0%, 0%, 0.12);
    transform: translate(-50%, -100%);
    min-width: 180px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .confirm-message {
    font-size: 0.85rem;
    font-weight: 600;
    color: $gray-900;
    text-align: center;
  }

  .confirm-buttons {
    display: flex;
    gap: 6px;
    justify-content: center;
  }

  .btn-confirm,
  .btn-cancel {
    padding: 5px 12px;
    font-size: 0.75rem;
    font-weight: 600;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    transition: all 150ms;
  }

  .btn-confirm {
    background: $green-600;
    color: white;

    &:hover {
      background: $green-700;
    }

    &:active {
      background: $green-800;
    }
  }

  .btn-cancel {
    background: $gray-200;
    color: $gray-700;

    &:hover {
      background: $gray-300;
    }

    &:active {
      background: $gray-400;
    }
  }
</style>
