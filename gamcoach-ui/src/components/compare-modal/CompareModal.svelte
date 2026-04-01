<script>
  import { onDestroy } from 'svelte';
  import { compareOpenStore } from '../../store';

  /** @type {import('../coach/Coach').Plans} */
  export let plans = null;
  export let planLabels = [];
  /** @type {Map<number, import('../coach/Coach').Plan>} */
  export let localPlans = null;
  /** Incremented by CoachPanel whenever any plan store updates — triggers reactive rebuild. */
  export let localPlansVersion = 0;

  let unchangedOpen = false;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const sigmoid = x => 1 / (1 + Math.exp(-x));

  /**
   * Format a raw feature value for display.
   * Handles log10 transform, categorical label lookup, integers, and large numbers.
   */
  function formatVal(val, feature) {
    if (val === null || val === undefined) return '—';

    if (feature.data?.type === 'categorical') {
      const enc = feature.labelEncoder;
      if (enc) {
        const entry = Object.entries(enc).find(([, v]) => v === val);
        return entry ? entry[0] : String(val);
      }
      return String(val);
    }

    if (feature.transform === 'log10') {
      val = Math.pow(10, val);
    }

    if (val >= 1000) {
      return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }

    if (feature.requiresInt) return Math.round(val).toString();

    return parseFloat(val.toFixed(2)).toString();
  }

  // ─── Comparison data ──────────────────────────────────────────────────────

  let planList = [];
  let changedFeatureIDs = [];
  let unchangedFeatureIDs = [];
  let originalProbPct = 0;

  function rebuildComparison() {
    if (!plans || !localPlans || localPlans.size === 0) {
      planList = [];
      changedFeatureIDs = [];
      unchangedFeatureIDs = [];
      return;
    }

    originalProbPct = Math.round(sigmoid(plans.originalScore) * 100);

    // Build sorted plan list
    const newList = Array.from(localPlans.keys())
      .sort((a, b) => a - b)
      .map(idx => {
        const plan = localPlans.get(idx);
        if (!plan) return null;

        const probPct = sigmoid(plan.ebmLocal.predScore) * 100;
        const deltaPP = probPct - (sigmoid(plans.originalScore) * 100);
        const label = planLabels.find(l => l.planIndex === idx);

        return {
          planIndex: idx,
          name: label?.name ?? `Plan ${idx}`,
          approvalPct: Math.round(probPct),
          deltaPP: parseFloat(deltaPP.toFixed(1)),
          isBest: false,
          features: plan.features.map(f => {
            // ebmLocal.sample[featureID] is the live current value — updated by
            // both the coach's initial suggestion AND any user slider changes.
            // f.myValue is only set once at plan creation and never updated.
            const currentVal = plan.ebmLocal.sample[f.featureID];
            const origVal    = plan.curExample[f.featureID];
            // f.isChanged !== 0 → coach suggested a change (1 = direct, 2 = propagated).
            // currentVal !== origVal → user slider moved it away from original.
            // f.coachValue !== f.originalValue → redundant safety check on stored values.
            // Any of these being true should highlight the cell.
            const isChanged  = (f.isChanged !== 0)
                             || (currentVal !== origVal)
                             || (f.coachValue !== f.originalValue);
            return {
              featureID: f.featureID,
              displayName: f.data?.description?.displayName ?? f.data?.name ?? `Feature ${f.featureID}`,
              isChanged,
              currentDisplay: formatVal(currentVal, f),
              originalDisplay: formatVal(f.originalValue, f)
            };
          })
        };
      })
      .filter(Boolean);

    // Mark best (highest approval probability)
    if (newList.length > 0) {
      const maxPct = Math.max(...newList.map(p => p.approvalPct));
      newList.forEach(p => { p.isBest = p.approvalPct === maxPct; });
    }

    // Categorise features: changed = at least one plan differs from original
    const firstFeatures = newList[0]?.features ?? [];
    const newChanged = [];
    const newUnchanged = [];

    for (const feat of firstFeatures) {
      const anyChanged = newList.some(p =>
        p.features.find(f => f.featureID === feat.featureID)?.isChanged
      );
      (anyChanged ? newChanged : newUnchanged).push(feat.featureID);
    }

    planList = newList;
    changedFeatureIDs = newChanged;
    unchangedFeatureIDs = newUnchanged;
  }

  // ── Direct store subscription for modal-open trigger ─────────────────────
  // Using a direct subscription + setTimeout(0) rather than a Svelte reactive
  // statement: this guarantees the callback runs in a fresh macrotask AFTER
  // all pending Svelte prop propagation, reactive flushes, and microtasks
  // have settled — so localPlans is definitely readable with full plan data.
  const _compareUnsub = compareOpenStore.subscribe(isOpen => {
    if (isOpen) {
      // Synchronous attempt first (works if planList is already populated)
      rebuildComparison();
      // Macrotask fallback — runs after ALL pending work, guaranteed correct
      setTimeout(() => rebuildComparison(), 0);
    }
  });
  onDestroy(() => _compareUnsub());

  // Rebuild immediately whenever a plan store emits (slider changes, plan load).
  $: localPlansVersion && rebuildComparison();

  // ─── Helpers for template ─────────────────────────────────────────────────

  const getFeature = (plan, featureID) =>
    plan.features.find(f => f.featureID === featureID);

  const getFeatureName = featureID =>
    planList[0]?.features.find(f => f.featureID === featureID)?.displayName
    ?? `Feature ${featureID}`;
</script>

{#if $compareOpenStore}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="cmp-overlay" on:click|self={() => compareOpenStore.set(false)} role="dialog" aria-modal="true">
    <div class="cmp-modal">

      <!-- ── Header ───────────────────────────────────────────────── -->
      <div class="cmp-header">
        <div>
          <div class="cmp-title">Plan Comparison</div>
          <div class="cmp-subtitle">
            All {planList.length} plan{planList.length !== 1 ? 's' : ''} side by side
            {#if originalProbPct} · Original approval probability: <strong>{originalProbPct}%</strong>{/if}
          </div>
        </div>
        <button class="cmp-x" on:click={() => compareOpenStore.set(false)} title="Close">✕</button>
      </div>

      <!-- ── Legend ───────────────────────────────────────────────── -->
      <div class="cmp-legend">
        <span class="leg leg-changed">Changed from original</span>
        <span class="leg leg-same">Same across all plans</span>
      </div>

      <!-- ── Table ────────────────────────────────────────────────── -->
      <div class="cmp-scroll">
        <table class="cmp-table">
          <thead>
            <tr class="cmp-head-row">
              <th class="th-feature">FEATURE</th>
              {#each planList as plan}
                <th class="th-plan" class:th-best={plan.isBest}>
                  <div class="plan-name">
                    {#if plan.isBest}<span class="star">★</span>{/if}
                    {plan.name}
                  </div>
                  <div class="plan-pct" class:plan-pct-best={plan.isBest}>
                    {plan.approvalPct}%
                  </div>
                  <div class="plan-pct-label">APPROVAL PROB.</div>
                  <div class="plan-delta"
                    class:delta-pos={plan.deltaPP > 0}
                    class:delta-neg={plan.deltaPP < 0}>
                    {plan.deltaPP > 0 ? '+' : ''}{plan.deltaPP} from original
                  </div>
                </th>
              {/each}
            </tr>
          </thead>

          <tbody>
            <!-- Changed features -->
            {#if changedFeatureIDs.length > 0}
              <tr class="sec-row sec-changed">
                <td colspan={planList.length + 1}>CHANGED FEATURES (in at least one plan)</td>
              </tr>
              {#each changedFeatureIDs as fid}
                <tr class="data-row">
                  <td class="td-name">{getFeatureName(fid)}</td>
                  {#each planList as plan}
                    {@const feat = getFeature(plan, fid)}
                    <td class="td-cell"
                      style="background: {
                        feat?.isChanged               ? 'hsl(45, 100%, 82%)' :
                        plan.isBest                   ? 'hsl(152, 55%, 95%)' :
                        'white'}">
                      <div class="cell-val">{feat?.currentDisplay ?? '—'}</div>
                      {#if feat?.isChanged}
                        <div class="cell-from">from {feat.originalDisplay}</div>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            {/if}

            <!-- Unchanged features (collapsed by default) -->
            {#if unchangedFeatureIDs.length > 0}
              <!-- svelte-ignore a11y-click-events-have-key-events -->
              <tr class="sec-row sec-unchanged" on:click={() => unchangedOpen = !unchangedOpen}>
                <td colspan={planList.length + 1}>
                  UNCHANGED FEATURES (SAME ACROSS ALL PLANS)
                  <span class="toggle-arrow">{unchangedOpen ? '▲' : '▼'}</span>
                </td>
              </tr>
              {#if unchangedOpen}
                {#each unchangedFeatureIDs as fid}
                  <tr class="data-row data-row-dim">
                    <td class="td-name td-name-dim">{getFeatureName(fid)}</td>
                    {#each planList as plan}
                      {@const feat = getFeature(plan, fid)}
                      <td class="td-cell td-cell-dim">
                        <div class="cell-val cell-val-dim">{feat?.currentDisplay ?? '—'}</div>
                      </td>
                    {/each}
                  </tr>
                {/each}
              {/if}
            {/if}
          </tbody>
        </table>
      </div>

      <!-- ── Footer ───────────────────────────────────────────────── -->
      <div class="cmp-footer">
        <span class="footer-note">
          ★ Plan with the highest approval probability.
        </span>
        <button class="cmp-close-btn" on:click={() => compareOpenStore.set(false)}>Close</button>
      </div>

    </div>
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  /* ── Overlay ───────────────────────────────────────────────────── */
  .cmp-overlay {
    position: fixed;
    inset: 0;
    background: hsla(0, 0%, 0%, 0.48);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  /* ── Modal shell ───────────────────────────────────────────────── */
  .cmp-modal {
    background: white;
    border-radius: 10px;
    box-shadow: 0 8px 48px hsla(0, 0%, 0%, 0.24);
    max-width: 940px;
    width: 100%;
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ────────────────────────────────────────────────────── */
  .cmp-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid $gray-200;
    flex-shrink: 0;

    .cmp-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: $gray-900;
      margin-bottom: 3px;
    }

    .cmp-subtitle {
      font-size: 0.9rem;
      //color: $gray-500;
      color: gray;
    }

    .cmp-x {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 1rem;
      color: $gray-400;
      padding: 2px 6px;
      border-radius: 4px;
      line-height: 1;
      flex-shrink: 0;
      &:hover { background: $gray-100; color: $gray-700; }
    }
  }

  /* ── Legend ────────────────────────────────────────────────────── */
  .cmp-legend {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 7px 20px;
    background: $gray-50;
    border-bottom: 1px solid $gray-200;
    flex-shrink: 0;

    .leg {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.85rem;
      //color: $gray-600;
      color: black;

      &::before {
        content: '';
        display: inline-block;
        width: 13px;
        height: 13px;
        border-radius: 3px;
      }

      &.leg-best::before    { background: hsl(152, 55%, 91%); border: 1.5px solid hsl(152, 50%, 58%); }
      &.leg-changed::before { background: hsl(45,  100%, 91%); border: 1.5px solid hsl(45, 90%, 62%); }
      &.leg-same::before    { background: $gray-100;           border: 1.5px solid $gray-300; }
    }
  }

  /* ── Scrollable table area ─────────────────────────────────────── */
  .cmp-scroll {
    overflow-y: auto;
    overflow-x: auto;
    flex: 1 1 auto;
  }

  /* ── Table ─────────────────────────────────────────────────────── */
  .cmp-table {
    width: 100%;
    border-collapse: collapse;

    th, td { padding: 0; text-align: left; }
  }

  /* Sticky header */
  .cmp-head-row {
    position: sticky;
    top: 0;
    z-index: 2;
    background: white;
    box-shadow: 0 1px 0 $gray-200;
  }

  th.th-feature {
    width: 220px;
    min-width: 180px;
    padding: 10px 12px 2px 10px;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    //color: $gray-500;
    color: gray;
    vertical-align: bottom;
    border-bottom: 2px solid $gray-200;
  }

  .th-plan {
    min-width: 130px;
    padding: 10px 12px 8px;
    text-align: center;
    vertical-align: bottom;
    border-bottom: 2px solid $gray-200;
    border-left: 1px solid $gray-100;

    &.th-best {
      background: hsl(152, 55%, 95%);
      border-bottom-color: hsl(152, 50%, 50%);
    }

    .plan-name {
      font-size: 0.92rem;
      font-weight: 700;
      color: $gray-600;
      margin-bottom: 5px;
      .star { color: hsl(45, 88%, 42%); margin-right: 2px; }
    }

    .plan-pct {
      font-size: 1.45rem;
      font-weight: 800;
      color: $gray-800;
      line-height: 1;
      &.plan-pct-best { color: hsl(152, 48%, 32%); }
    }

    .plan-pct-label {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      //color: $gray-400;
      color: gray;
      margin: 3px 0 2px;
    }

    .plan-delta {
      font-size: 0.85rem;
      font-weight: 600;
      &.delta-pos { color: hsl(152, 48%, 36%); }
      &.delta-neg { color: hsl(4,   68%, 46%); }
    }
  }

  /* ── Section header rows ───────────────────────────────────────── */
  .sec-row td {
    padding: 5px 20px;
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: white;

    .toggle-arrow {
      float: right;
      font-size: 0.75rem;
      opacity: 0.75;
    }
  }

  .sec-changed td  { background: hsl(215, 28%, 26%); }
  .sec-unchanged td {
    background: hsl(215, 15%, 44%);
    cursor: pointer;
    user-select: none;
  }

  /* ── Data rows ─────────────────────────────────────────────────── */
  .data-row {
    border-bottom: 1px solid $gray-100;
    &:hover td { background: hsl(213, 100%, 97%) !important; }
  }

  .data-row-dim {
    &:hover td { background: $gray-50 !important; }
  }

  /* Feature name cell — td.td-name beats the .cmp-table td { padding:0 } reset */
  td.td-name {
    padding: 8px 12px 8px 20px;
    font-size: 0.92rem;
    font-weight: 600;
    color: $gray-700;
    white-space: nowrap;
  }

  td.td-name-dim {
    color: $gray-600;
    font-weight: 600;
  }

  /* Value cell */
  .td-cell {
    padding: 7px 12px;
    text-align: center;
    vertical-align: middle;
    border-left: 1px solid $gray-100;
    background: white;
  }

  /* Use !important so these beat the .cmp-table td reset regardless of specificity */
  .td-changed      { background: hsl(45, 100%, 82%) !important; }
  .td-best         { background: hsl(152, 55%, 95%) !important; }
  .td-changed-best { background: hsl(90, 55%, 91%) !important; }
  .td-cell-dim     { background: $gray-50 !important; }

  .cell-val {
    font-size: 0.82rem;
    font-weight: 700;
    color: $gray-800;
  }

  .cell-val-dim {
    color: $gray-600;
    font-weight: 600;
  }

  .cell-from {
    font-size: 0.8rem;
    color: $gray-500;
    margin-top: 2px;
  }

  /* ── Footer ────────────────────────────────────────────────────── */
  .cmp-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 20px;
    border-top: 1px solid $gray-200;
    flex-shrink: 0;
    background: $gray-50;

    .footer-note {
      font-size: 0.85rem;
      //color: $gray-400;
      color:black;
    }

    .cmp-close-btn {
      background: white;
      border: 1px solid $gray-300;
      color: $gray-700;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 600;
      padding: 6px 20px;
      border-radius: 6px;
      &:hover { background: $gray-100; }
    }
  }
</style>
