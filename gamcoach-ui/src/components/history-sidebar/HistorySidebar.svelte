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

  // Expanded collapsibles, keyed by entry timestamp (stable across re-indexing).
  let expandedChanged = new Set();
  let expandedUnchanged = new Set();

  // ── Reflection notes (saved entries only) ─────────────────────────────────
  // Four independent tap-to-open fields, stored SEPARATELY on entry.note
  // ({why, learned, worth, other}) so each is retained/edited on its own.
  const NOTE_FIELDS = [
    { key: 'why', label: 'Why did you try this combination?' },
    { key: 'learned', label: 'What did you learn from this plan?' },
    { key: 'worth', label: 'What makes this plan worth keeping?' },
    { key: 'other', label: 'Other notes' }
  ];
  let noteOpen = new Set();   // entries with the note editor expanded (timestamp)
  let openFields = new Set(); // open question fields ("timestamp|key")

  /** True when any of the entry's note fields has real (non-whitespace) content. */
  const hasNote = (entry) =>
    !!entry.note && Object.values(entry.note).some((v) => v && String(v).trim());

  /** How many of the four fields have real content (for the "N answered" badge). */
  const answeredCount = (entry) =>
    entry.note
      ? Object.values(entry.note).filter((v) => v && String(v).trim()).length
      : 0;

  // Notify store subscribers (marker, control label) without touching the data.
  const touchStore = () => historyEntriesStore.update((m) => m);

  const toggleNoteOpen = (ts) => {
    if (noteOpen.has(ts)) noteOpen.delete(ts);
    else noteOpen.add(ts);
    noteOpen = noteOpen;
  };

  const toggleField = (ts, key) => {
    const id = `${ts}|${key}`;
    if (openFields.has(id)) openFields.delete(id);
    else openFields.add(id);
    openFields = openFields;
  };

  /** Write-through a field edit (raw, so typing is never fought). */
  const setNoteField = (entry, key, value) => {
    entry.note = { ...(entry.note || {}), [key]: value };
    touchStore();
  };

  /** On blur: drop empty fields; all-empty notes collapse back to null. */
  const cleanupNote = (entry) => {
    if (!entry.note) return;
    const cleaned = {};
    for (const [k, v] of Object.entries(entry.note)) {
      if (v && String(v).trim()) cleaned[k] = v;
    }
    entry.note = Object.keys(cleaned).length ? cleaned : null;
    touchStore();
  };

  /** Focus a field's textarea as soon as it opens. */
  const autofocus = (node) => { node.focus(); };

  // Transient nudge banner (e.g. the 5-saved cap message).
  let nudge = null;
  let nudgeTimer = null;

  $: planEntries = $historyEntriesStore?.get(activePlanIndex) || [];

  const toggleChanged = (key) => {
    if (expandedChanged.has(key)) expandedChanged.delete(key);
    else expandedChanged.add(key);
    expandedChanged = expandedChanged; // reactivity
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
    // Unsaving discards the entry's note — warn first when one has content.
    if (entry.saved && hasNote(entry)) {
      if (!window.confirm('This will remove your note. Unsave anyway?')) return;
    }
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
                <span class="entry-score">{entry.probPct}%</span>
                {#if hasNote(entry)}
                  <span class="note-marker" title="This entry has a note">🗒</span>
                {/if}
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

            <!-- N features changed (vs load-time baseline) — collapsed by default -->
            {#if entry.features.length > 0}
              <button class="group-toggle" on:click={() => toggleChanged(entry.timestamp)}>
                <span class="gt-arrow">{expandedChanged.has(entry.timestamp) ? '▾' : '▸'}</span>
                {entry.features.length} feature{entry.features.length !== 1 ? 's' : ''} changed
              </button>
              {#if expandedChanged.has(entry.timestamp)}
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

            <!-- Reflection note — saved entries only -->
            {#if entry.saved}
              <div class="note-section">
                <button class="group-toggle note-head" on:click={() => toggleNoteOpen(entry.timestamp)}>
                  <span class="gt-arrow">{noteOpen.has(entry.timestamp) ? '▾' : '▸'}</span>
                  <span class="note-pencil">✎</span>
                  <span class="note-label">{hasNote(entry) ? 'edit note' : 'add a note'}</span>
                  {#if answeredCount(entry) > 0}
                    <span class="answered-badge">{answeredCount(entry)} answered</span>
                  {/if}
                </button>
                {#if noteOpen.has(entry.timestamp)}
                  <div class="note-fields" transition:slide={{ duration: 150 }}>
                    {#each NOTE_FIELDS as f (f.key)}
                      <div class="note-q">
                        <button class="q-row" on:click={() => toggleField(entry.timestamp, f.key)}>
                          <span class="q-icon">{openFields.has(`${entry.timestamp}|${f.key}`) ? '−' : '＋'}</span>
                          <span class="q-text">{f.label}</span>
                        </button>
                        {#if openFields.has(`${entry.timestamp}|${f.key}`)}
                          <textarea
                            class="q-input"
                            rows="3"
                            use:autofocus
                            value={entry.note?.[f.key] ?? ''}
                            on:input={(e) => setNoteField(entry, f.key, e.target.value)}
                            on:blur={() => cleanupNote(entry)}
                          ></textarea>
                        {/if}
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
    color: $gray-900;
    line-height: 1;
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
    .gt-arrow { width: 9px; color: $gray-500; }
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
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 15px;
      font-weight: 500;
      color: $gray-800;
    }

    .feat-val {
      flex: 0 0 auto;
      text-align: right;
      font-variant-numeric: tabular-nums;
      font-size: 15px;

      .from  { color: $gray-400; font-weight: 500; }
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

  /* ── Reflection note (saved entries only) ────────── */
  .note-marker {
    font-size: 0.85rem;
    line-height: 1;
    opacity: 0.75;
  }

  .note-section {
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid $gray-200; /* divider from the feature groups */
  }

  /* Note header row — same chevron affordance as the two section rows above,
     but visually lighter (secondary to the plan data). Clicking anywhere on
     the row toggles the panel. */
  .note-head {
    margin-top: 0;
    color: $gray-500;
    &:hover { color: $gray-700; }

    .note-pencil {
      flex: 0 0 auto;
      font-size: 0.85rem;
    }
    .note-label {
      font-size: 0.85rem;
      font-weight: 600;
    }
    .answered-badge {
      margin-left: auto;
      flex: 0 0 auto;
      font-size: 0.72rem;
      font-weight: 600;
      color: $gray-500;
      background: $gray-100;
      border: 1px solid $gray-200;
      border-radius: 9px;
      padding: 1px 8px;
      line-height: 1.5;
    }
  }

  .note-fields {
    margin-top: 4px;
  }

  .note-q {
    border-top: 1px solid $gray-100; /* thin dividers between question rows */
    &:first-child { border-top: none; }

    .q-row {
      display: flex;
      align-items: baseline;
      gap: 7px;
      width: 100%;
      padding: 6px 0;
      background: none;
      border: none;
      cursor: pointer;
      text-align: left;

      .q-icon {
        width: 12px;
        flex: 0 0 auto;
        font-size: 0.85rem;
        color: $gray-400;
      }
      .q-text {
        font-size: 0.85rem;
        color: $gray-600;
      }
      &:hover .q-text { color: $gray-900; }
    }

    .q-input {
      display: block;
      width: 100%;
      box-sizing: border-box;
      margin: 0 0 8px 19px;
      max-width: calc(100% - 19px);
      min-height: 54px;
      resize: vertical; /* multi-line, vertically resizable */
      padding: 6px 8px;
      font-size: 0.85rem;
      font-family: inherit;
      line-height: 1.4;
      color: $gray-800;
      border: 1px solid $gray-300;
      border-radius: 5px;
      background: $gray-50;

      &:focus {
        outline: none;
        border-color: $blue-500;
        background: white;
      }
    }
  }
</style>
