<script>
  import { breakdownPopupStore } from '../store';

  const POPUP_WIDTH = 440;

  // Color-vision-safe red/blue (never red/green). Bars use the brighter stops;
  // value labels use the darker stops so they stay readable as text.
  const RED_BAR = '#E24B4A';
  const BLUE_BAR = '#378ADD';
  const RED_TEXT = '#A32D2D';
  const BLUE_TEXT = '#185FA5';
  // Rollup: contributions below 10% of the LARGEST single contribution collapse,
  // AND at most 4 rows are ever shown individually (whichever is stricter).
  const ROLLUP_REL_THRESHOLD = 0.10;
  const MAX_VISIBLE_ROWS = 4;
  // A positive is only named in the verdict when it is at least this fraction of
  // the largest harm's magnitude — otherwise a small offset isn't overstated.
  const OFFSET_MENTION_FRACTION = 0.25;

  let hideTimer = null;
  let expanded = false;
  let lastData = null;

  // Reset the rollup expansion whenever a new breakdown is shown.
  $: if ($breakdownPopupStore.data !== lastData) {
    lastData = $breakdownPopupStore.data;
    expanded = false;
  }

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

  const signed = v => (v > 0 ? '+' : '') + v;

  /**
   * Split contributors into the rows shown individually and the rest rolled up.
   * Two rules, whichever is STRICTER:
   *   - relative threshold: roll up any |contribution| < 10% of the largest, and
   *   - hard cap: never show more than 4 rows individually.
   * Always shows at least the top 2; a lone left-over becomes its own row rather
   * than a one-item rollup (a rollup must hold ≥ 2 members). Rows + rollup net
   * always sum to the total.
   */
  const splitRows = (feats) => {
    const maxAbs = Math.max(...feats.map(f => Math.abs(f.actualPP)), 0);
    const threshold = ROLLUP_REL_THRESHOLD * maxAbs;
    // feats arrive sorted by |contribution| desc, so the above-threshold ones
    // form a prefix.
    let k = feats.filter(f => Math.abs(f.actualPP) >= threshold).length;
    k = Math.max(k, Math.min(2, feats.length));  // always show the top 2
    k = Math.min(k, MAX_VISIBLE_ROWS);           // …but never more than 4 (cap wins)
    let shown = feats.slice(0, k);
    let rolled = feats.slice(k);
    if (rolled.length === 1) { shown = feats.slice(0, k + 1); rolled = []; } // no lone rollup
    const rollupNet = Math.round(rolled.reduce((s, f) => s + f.actualPP, 0) * 10) / 10;
    return { shown, rolled, rollupNet, maxAbs };
  };

  /** Join names with an Oxford comma: [a] → "a", [a,b] → "a and b", … */
  const joinNames = (names) => {
    if (names.length <= 1) return names[0] || '';
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
  };

  /** Top drivers (up to `maxN`) whose combined magnitude covers most (≥80%). */
  const topCovering = (sorted, maxN, coverage = 0.8) => {
    const total = sorted.reduce((s, f) => s + Math.abs(f.actualPP), 0);
    const picked = [];
    let acc = 0;
    for (const f of sorted) {
      picked.push(f);
      acc += Math.abs(f.actualPP);
      if (picked.length >= maxN || acc >= coverage * total) break;
    }
    return picked;
  };

  /** Bar length as a fraction of the largest single contribution. */
  const barFrac = (v, maxAbs) => (maxAbs > 0 ? Math.abs(v) / maxAbs * 100 : 0);

  /**
   * Generated verdict sentence.
   *   - Names the top harms (up to 3) covering most of the dominant-direction
   *     movement, e.g. "Your A, B, and C all pulled approval down."
   *   - Mentions an offsetting contributor ONLY when it is substantial (≥ 25% of
   *     the largest harm) — otherwise omits it, so a small offset is never
   *     overstated while the net stays strongly one-directional.
   *   - Falls back to the simple single-name form when everything shares a sign.
   */
  const verdict = (feats, headerDelta) => {
    if (!feats.length) return '';
    const drop = headerDelta < 0;
    const driverSign = drop ? -1 : 1;
    const drivers = feats.filter(f => Math.sign(f.actualPP) === driverSign);
    const offsets = feats.filter(f => Math.sign(f.actualPP) === -driverSign);

    // All one direction → simple form naming just the dominant contributor.
    if (drivers.length === 0 || offsets.length === 0) {
      return `Your ${feats[0].displayName.toLowerCase()} drove most of this ${drop ? 'drop' : 'gain'}.`;
    }

    const driversSorted = drivers.slice().sort((a, b) => Math.abs(b.actualPP) - Math.abs(a.actualPP));
    const named = topCovering(driversSorted, 3).map(f => f.displayName.toLowerCase());
    const driverVerb = drop ? 'pulled approval down' : 'pushed approval up';
    let sentence = `Your ${joinNames(named)} ${named.length > 1 ? 'all ' : ''}${driverVerb}`;

    // Offset clause only if the largest offset is substantial vs. the top harm.
    const largestHarm = Math.abs(driversSorted[0].actualPP);
    const topOffset = offsets.slice().sort((a, b) => Math.abs(b.actualPP) - Math.abs(a.actualPP))[0];
    if (Math.abs(topOffset.actualPP) >= OFFSET_MENTION_FRACTION * largestHarm) {
      const offsetVerb = drop ? 'offset part of it' : 'worked against it';
      sentence += `, though your ${topOffset.displayName.toLowerCase()} ${offsetVerb}`;
    }
    return sentence + '.';
  };
</script>

{#if $breakdownPopupStore.show && $breakdownPopupStore.data}
  {@const d = $breakdownPopupStore.data}
  {@const feats = d.features}
  {@const split = splitRows(feats)}

  <div
    class="bd-popup"
    class:bd-pinned={$breakdownPopupStore.pinned}
    style="left:{Math.min($breakdownPopupStore.x, window.innerWidth - POPUP_WIDTH - 8)}px;
           top:{$breakdownPopupStore.y}px; width:{POPUP_WIDTH}px"
    on:mouseenter={keepPopup}
    on:mouseleave={scheduleHide}
    role="tooltip"
  >
    <!-- ── 1. Header ───────────────────────────────────────────── -->
    <div class="bd-header-row">
      <div class="bd-title-block">
        <span class="bd-label">Approval probability</span>
        <span class="bd-scores">{d.origPct}% &rarr; {d.curPct}%</span>
      </div>
      <div class="bd-header-right">
        <span class="bd-delta"
          class:bd-delta-pos={d.deltaPP > 0}
          class:bd-delta-neg={d.deltaPP < 0}>
          {signed(d.deltaPP)}
        </span>
        {#if $breakdownPopupStore.pinned}
          <button class="bd-close" on:click={closePopup} title="Close">✕</button>
        {/if}
      </div>
    </div>

    <!-- ── 2. Verdict sentence ─────────────────────────────────── -->
    <div class="bd-verdict">{verdict(feats, d.deltaPP)}</div>

    <!-- ── 3. Axis labels ──────────────────────────────────────── -->
    <div class="bd-axis-labels">
      <span class="bd-axis-neg" style="color:{RED_TEXT}">&larr; Decreases approval</span>
      <span class="bd-axis-pos" style="color:{BLUE_TEXT}">Increases approval &rarr;</span>
    </div>

    <!-- ── 4. Diverging bars ───────────────────────────────────── -->
    <div class="bd-rows">
      {#each split.shown as feat}
        <div class="bd-row">
          <div class="bd-row-top">
            <span class="bd-name">{feat.displayName}</span>
            <span class="bd-val"
              class:bd-val-left={feat.actualPP < 0}
              style="color:{feat.actualPP < 0 ? RED_TEXT : BLUE_TEXT}">
              {signed(feat.actualPP)}
            </span>
          </div>
          <div class="bd-diverge">
            <div class="bd-half bd-half-left">
              {#if feat.actualPP < 0}
                <div class="bd-fill"
                  style="width:{barFrac(feat.actualPP, split.maxAbs)}%; background:{RED_BAR}"></div>
              {/if}
            </div>
            <div class="bd-axis"></div>
            <div class="bd-half bd-half-right">
              {#if feat.actualPP > 0}
                <div class="bd-fill"
                  style="width:{barFrac(feat.actualPP, split.maxAbs)}%; background:{BLUE_BAR}"></div>
              {/if}
            </div>
          </div>
          <div class="bd-sub">{feat.origValStr} &rarr; {feat.curValStr}</div>
        </div>
      {/each}
    </div>

    <!-- ── 6. Rollup row ───────────────────────────────────────── -->
    {#if split.rolled.length > 0}
      <button class="bd-rollup" on:click={() => (expanded = !expanded)}>
        <span class="bd-rollup-caret">{expanded ? '▾' : '▸'}</span>
        <span class="bd-rollup-label">{split.rolled.length} smaller changes</span>
        <span class="bd-rollup-net"
          style="color:{split.rollupNet < 0 ? RED_TEXT : BLUE_TEXT}">
          {signed(split.rollupNet)} <em>net</em>
        </span>
      </button>
      {#if expanded}
        <div class="bd-rollup-members">
          {#each split.rolled as m}
            <div class="bd-rollup-member">
              <span class="bd-name">{m.displayName}</span>
              <span class="bd-val"
                style="color:{m.actualPP < 0 ? RED_TEXT : BLUE_TEXT}">
                {signed(m.actualPP)}
              </span>
            </div>
          {/each}
        </div>
      {/if}
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

    &.bd-pinned {
      border-color: $gray-400;
      box-shadow: 0 4px 24px hsla(0, 0%, 0%, 0.2);
    }
  }

  /* ── Header ───────────────────────────────────────────────────── */
  .bd-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .bd-title-block {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }

  .bd-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: $gray-700;
  }

  .bd-scores {
    font-size: 1.05rem;
    font-weight: 700;
    color: $gray-900;
  }

  .bd-header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .bd-delta {
    font-size: 0.9rem;
    font-weight: 700;
    padding: 2px 9px;
    border-radius: 11px;
    &.bd-delta-pos { background: hsl(211, 68%, 92%); color: #185FA5; }
    &.bd-delta-neg { background: hsl(4, 68%, 93%); color: #A32D2D; }
  }

  .bd-close {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.85rem;
    color: gray;
    padding: 2px 5px;
    border-radius: 4px;
    line-height: 1;
    transition: color 0.15s, background 0.15s;
    &:hover { color: $gray-700; background: $gray-100; }
  }

  /* ── 2. Verdict sentence ──────────────────────────────────────── */
  .bd-verdict {
    margin: 6px 0 12px;
    font-size: 14px;
    line-height: 1.35;
    color: $gray-600;
  }

  /* ── 3. Axis labels ───────────────────────────────────────────── */
  .bd-axis-labels {
    display: flex;
    justify-content: space-between;
    margin-bottom: 8px;
    font-size: 0.78rem;
    font-weight: 600;
  }

  /* ── 4. Diverging bar rows ────────────────────────────────────── */
  .bd-rows {
    display: flex;
    flex-direction: column;
    gap: 18px; /* inter-row gap — larger than the 4px row-internal gap */
  }

  .bd-row {
    display: flex;
    flex-direction: column;
    gap: 4px; /* tight: name → bar → before/after group as one unit */
  }

  .bd-row-top {
    display: flex;
    align-items: baseline;
    gap: 0;
  }

  .bd-name {
    font-weight: 600;
    color: $gray-800;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex-shrink: 1;
  }

  .bd-val {
    font-weight: 700;
    font-size: 0.85rem;
    white-space: nowrap;
    flex-shrink: 0;
    /* Positive (increase) values sit on the right, matching the right-pointing
       bar. Negative (decrease) values sit right beside the name, matching the
       left-pointing bar, so the value stays close to the feature it describes. */
    margin-left: auto;
    &.bd-val-left { margin-left: 8px; }
  }

  /* Bars diverge from a real, bold center zero-line. The axis is 24px — taller
     than the 12px bars — using negative margins so it overflows visually without
     growing the row (keeping the before/after line tight under the bar). */
  .bd-diverge {
    display: flex;
    align-items: center;
    height: 12px;
  }

  .bd-half {
    flex: 1;
    display: flex;
    align-items: center;
    height: 12px;
    overflow: hidden;
  }
  .bd-half-left  { justify-content: flex-end;   border-radius: 3px 0 0 3px; }
  .bd-half-right { justify-content: flex-start; border-radius: 0 3px 3px 0; }

  .bd-fill {
    height: 12px;
    border-radius: 2px;
  }

  .bd-axis {
    width: 3px;
    height: 24px;
    margin: -6px 0; /* extend 6px above/below the 12px bar row, no layout growth */
    background: $gray-900;
    flex-shrink: 0;
  }

  .bd-sub {
    font-size: 0.76rem;
    color: $gray-500;
    white-space: nowrap;
  }

  /* ── 6. Rollup ────────────────────────────────────────────────── */
  .bd-rollup {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin-top: 10px;
    padding: 6px 4px;
    background: none;
    border: none;
    border-top: 1px solid $gray-200;
    cursor: pointer;
    font-size: 0.8rem;
    color: $gray-700;
    text-align: left;

    &:hover { background: $gray-100; }

    .bd-rollup-caret { color: $gray-500; width: 10px; }
    .bd-rollup-label { flex: 1; font-weight: 600; }
    .bd-rollup-net {
      font-weight: 700;
      em { font-style: normal; font-weight: 500; color: $gray-500; margin-left: 2px; }
    }
  }

  .bd-rollup-members {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 4px 4px 2px 22px;

    .bd-rollup-member {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      font-size: 0.78rem;
    }
  }
</style>
