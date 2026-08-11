<script>
  import { onDestroy } from 'svelte';
  import { compareOpenStore, constraintsStore } from '../../store';
  import { computeIdeasForPlan } from '../ideas/planIdeas';

  /** @type {import('../coach/Coach').Plans} */
  export let plans = null;
  export let planLabels = [];
  /** @type {Map<number, import('../coach/Coach').Plan>} */
  export let localPlans = null;
  /** Incremented by CoachPanel whenever any plan store updates — triggers reactive rebuild. */
  export let localPlansVersion = 0;

  let unchangedOpen = false;

  // View toggle — Summarized (default) or Detailed (the existing matrix).
  let viewMode = 'summarized';

  // Hover explanations for the provenance tags (legend + per-row).
  const provTip = (prov) =>
    prov === 'suggested'
      ? 'GAM Coach suggested this change'
      : 'You changed this feature, or it changed because of another change you made';

  // Summarized-view data (per plan) + shared constraints for its Ideas-to-try.
  let summaryPlans = [];
  let summaryScoresDiffer = false;
  let constraints = null;
  const _constraintsUnsub = constraintsStore.subscribe((v) => (constraints = v));
  onDestroy(() => _constraintsUnsub());

  const APPROVAL_POINTS = 50; // approval threshold in points

  // A change whose per-feature score contribution is within ±this (log-odds) is
  // treated as neutral — the value moved but the score didn't.
  const CONTRIB_EPS = 1e-6;

  // ─── Helpers ──────────────────────────────────────────────────────────────

  const sigmoid = x => 1 / (1 + Math.exp(-x));

  /** "debt_consolidation" → "Debt consolidation", "MORTGAGE" → "Mortgage". */
  function prettifyLabel(s) {
    const t = String(s).replace(/_/g, ' ').toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  /**
   * Format a raw feature value for display, ALWAYS decoding categoricals to their
   * human-readable label (never a raw index). The stored value may be a category
   * CODE (f.originalValue) or an already-decoded LABEL (ebmLocal.sample), so we
   * accept both directions of the feature's {code: label} encoder.
   */
  function formatVal(val, feature) {
    if (val === null || val === undefined) return '—';

    if (feature.data?.type === 'categorical') {
      const enc = feature.labelEncoder; // {code: label}
      if (enc) {
        if (enc[val] !== undefined) return prettifyLabel(enc[val]);        // code → label
        if (Object.values(enc).includes(val)) return prettifyLabel(val);   // already a label
      }
      return prettifyLabel(val);
    }

    if (feature.transform === 'log10') val = Math.pow(10, val);
    if (val >= 1000) return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (feature.requiresInt) return Math.round(val).toString();
    return parseFloat(val.toFixed(2)).toString();
  }

  /** Color bucket for a changed cell, from the model's per-feature contribution. */
  function colorOf(changedInPlan, contribution) {
    if (!changedInPlan) return 'empty';
    if (contribution > CONTRIB_EPS) return 'up';    // raised approval prob
    if (contribution < -CONTRIB_EPS) return 'down'; // lowered it
    return 'neutral';                               // changed, ~zero contribution
  }

  // ─── Comparison data ──────────────────────────────────────────────────────

  let planList = [];
  let changedRows = [];
  let unchangedList = [];
  let originalProbPct = 0;

  function rebuildComparison() {
    if (!plans || !localPlans || localPlans.size === 0) {
      planList = [];
      changedRows = [];
      unchangedList = [];
      return;
    }

    const origProb = sigmoid(plans.originalScore) * 100;
    originalProbPct = Math.round(origProb);

    // Build sorted plan list with per-feature current value + score contribution.
    const newList = Array.from(localPlans.keys())
      .sort((a, b) => a - b)
      .map(idx => {
        const plan = localPlans.get(idx);
        if (!plan) return null;

        const probPct = sigmoid(plan.ebmLocal.predScore) * 100;
        const label = planLabels.find(l => l.planIndex === idx);

        // Per-feature contribution: current per-feature score minus the original
        // per-feature score (log-odds). Same values that feed the score breakdown.
        const origScores = plan.ebmLocal.countScore(plan.curExample);
        const curScores  = plan.ebmLocal.countScore(plan.ebmLocal.sample);

        return {
          planIndex: idx,
          name: label?.name ?? `Plan ${idx}`,
          approvalPct: Math.round(probPct),
          deltaPP: parseFloat((probPct - origProb).toFixed(1)),
          isBest: false,
          features: plan.features.map(f => {
            const name = f.data?.name;
            const currentVal = plan.ebmLocal.sample[f.featureID];
            const currentDisplay = formatVal(currentVal, f);
            const originalDisplay = formatVal(f.originalValue, f);
            const contribution = (curScores[name] ?? 0) - (origScores[name] ?? 0);
            return {
              featureID: f.featureID,
              displayName: f.data?.description?.displayName ?? f.data?.name ?? `Feature ${f.featureID}`,
              currentDisplay,
              originalDisplay,
              contribution,
              changedInPlan: currentDisplay !== originalDisplay
            };
          })
        };
      })
      .filter(Boolean);

    // Mark best (highest approval probability) — may be a tie.
    if (newList.length > 0) {
      const maxPct = Math.max(...newList.map(p => p.approvalPct));
      newList.forEach(p => { p.isBest = p.approvalPct === maxPct; });
    }

    // Split features: identical across ALL plans → collapsed; varies → changed.
    const first = newList[0]?.features ?? [];
    const changed = [];
    const unchanged = [];

    for (const feat of first) {
      const fid = feat.featureID;
      const cells = newList.map(p => p.features.find(f => f.featureID === fid));
      const values = cells.map(c => c?.currentDisplay);
      const identical = values.every(v => v === values[0]);

      if (identical) {
        unchanged.push({ featureID: fid, displayName: feat.displayName, sharedValue: values[0] });
      } else {
        changed.push({
          featureID: fid,
          displayName: feat.displayName,
          originalDisplay: feat.originalDisplay,
          // Discriminating power: how many distinct values appear across plans.
          spread: new Set(values).size,
          cells: cells.map((c, i) => ({
            display: c && c.changedInPlan ? c.currentDisplay : '—',
            color: colorOf(c?.changedInPlan, c?.contribution ?? 0),
            isBest: newList[i].isBest
          }))
        });
      }
    }

    // Widest spread (most discriminating) first.
    changed.sort((a, b) => b.spread - a.spread);

    planList = newList;
    changedRows = changed;
    unchangedList = unchanged;

    buildSummary();
  }

  /**
   * Summarized-view data. Per plan, a merged list of ALL changes (from its own
   * per-plan state) with provenance (suggested vs you-changed), the approval
   * score, and (only when below approval) its own Ideas-to-try chips.
   */
  function buildSummary() {
    const points = (p) => Math.round(sigmoid(p.ebmLocal.predScore) * 100);
    const list = Array.from(localPlans.keys())
      .sort((a, b) => a - b)
      .map((idx) => {
        const p = localPlans.get(idx);
        if (!p) return null;
        const label = planLabels.find((l) => l.planIndex === idx);
        const pts = points(p);
        const approved = pts >= APPROVAL_POINTS;

        const changes = [];
        p.features.forEach((f) => {
          const i = f.featureID;
          const curD = formatVal(p.ebmLocal.sample[i], f);
          const origD = formatVal(p.curExample[i], f);
          if (curD === origD) return; // unchanged from the applicant's original
          const coachD = formatVal(p.coachSample[i], f);
          changes.push({
            featureID: i,
            displayName: f.data?.description?.displayName ?? f.data?.name ?? `Feature ${i}`,
            // Suggested if the current value is exactly the system's suggestion;
            // otherwise the user moved it (or changed a feature the coach didn't).
            provenance: curD === coachD ? 'suggested' : 'you-changed',
            before: origD,
            after: curD,
            importance: f.data?.importance ?? 0
          });
        });
        changes.sort((a, b) => b.importance - a.importance);

        return {
          planIndex: idx,
          name: label?.name ?? `Plan ${idx}`,
          approvalPoints: pts,
          approved,
          isHighest: false,
          // "Ideas to try" chips for every plan — including approved ones, where
          // they're further tweaks the user could still make.
          ideas: computeIdeasForPlan(p, constraints),
          changes
        };
      })
      .filter(Boolean);

    // "Highest" tag only when scores actually differ (omit on an all-tie).
    const maxPts = list.length ? Math.max(...list.map((p) => p.approvalPoints)) : 0;
    summaryScoresDiffer = new Set(list.map((p) => p.approvalPoints)).size > 1;
    list.forEach((p) => { p.isHighest = p.approvalPoints === maxPts; });
    summaryPlans = list;
  }

  // ── Direct store subscription for modal-open trigger ─────────────────────
  const _compareUnsub = compareOpenStore.subscribe(isOpen => {
    if (isOpen) {
      viewMode = 'summarized'; // Summarized is the default each time it opens.
      rebuildComparison();
      setTimeout(() => rebuildComparison(), 0);
    }
  });
  onDestroy(() => _compareUnsub());

  // Rebuild whenever a plan store emits (slider changes, plan load).
  $: localPlansVersion && rebuildComparison();
</script>

{#if $compareOpenStore}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="cmp-overlay" on:click|self={() => compareOpenStore.set(false)} role="dialog" aria-modal="true">
    <div class="cmp-modal">

      <!-- ── View toggle (Summarized · Detailed) ──────────────────── -->
      <div class="cmp-view-toggle">
        <div class="cvt-tabs" role="tablist">
          <button
            class="cvt-tab"
            class:active={viewMode === 'summarized'}
            on:click={() => (viewMode = 'summarized')}
          >Summarized</button>
          <button
            class="cvt-tab"
            class:active={viewMode === 'detailed'}
            on:click={() => (viewMode = 'detailed')}
          >Detailed</button>
        </div>
      </div>

    {#if viewMode === 'detailed'}
      <!-- ══ DETAILED VIEW — unchanged existing matrix ══════════════ -->

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
        <span class="leg"><span class="leg-tag leg-tag-up">Blue</span> &mdash; raised approval probability</span>
        <span class="leg"><span class="leg-tag leg-tag-down">Red</span> &mdash; lowered it</span>
        <span class="leg"><span class="leg-bar leg-unchanged"></span> Unchanged from original</span>
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
            {#if changedRows.length > 0}
              {#each changedRows as row (row.featureID)}
                <tr class="data-row">
                  <td class="td-name">
                    <div class="td-name-main">{row.displayName}</div>
                    <div class="td-name-orig"><span class="orig-tag">Original</span> {row.originalDisplay}</div>
                  </td>
                  {#each row.cells as cell}
                    <td class="td-cell td-{cell.color}" class:td-best={cell.isBest}>
                      {#if cell.color === 'empty'}
                        <span class="cell-empty">&mdash;</span>
                      {:else}
                        <span class="cell-val">{cell.display}</span>
                      {/if}
                    </td>
                  {/each}
                </tr>
              {/each}
            {:else}
              <tr><td class="td-none" colspan={planList.length + 1}>No plans differ on any feature.</td></tr>
            {/if}
          </tbody>
        </table>

        <!-- ── Unchanged features (collapsed by default) ──────────── -->
        {#if unchangedList.length > 0}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <button class="uc-toggle" on:click={() => unchangedOpen = !unchangedOpen}>
            <span class="uc-arrow">{unchangedOpen ? '▾' : '▸'}</span>
            {unchangedList.length} feature{unchangedList.length !== 1 ? 's are' : ' is'} the same across all plans
          </button>
          {#if unchangedOpen}
            <div class="uc-grid">
              {#each unchangedList as u (u.featureID)}
                <div class="uc-name">{u.displayName}</div>
                <div class="uc-val">{u.sharedValue}</div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>

      <!-- ── Footer ───────────────────────────────────────────────── -->
      <div class="cmp-footer">
        <span class="footer-note">
          ★ Plan with the highest approval probability.
        </span>
        <button class="cmp-close-btn" on:click={() => compareOpenStore.set(false)}>Close</button>
      </div>

    {:else}
      <!-- ══ SUMMARIZED VIEW ═══════════════════════════════════════ -->
      <div class="sum-header">
        <div class="sum-titlebar">
          <div class="sum-title">Compare plans</div>
          <button class="cmp-x" on:click={() => compareOpenStore.set(false)} title="Close">✕</button>
        </div>
        <div class="sum-subtitle">
          Each plan reaches approval a different way. You can adjust any plan to
          fit your situation.
        </div>
        <div class="sum-legend">
          <span class="sum-prov suggested" title={provTip('suggested')}>suggested</span>
          <span class="sum-prov you-changed" title={provTip('you-changed')}>you changed</span>
        </div>
      </div>

      <div class="sum-scroll">
        <div
          class="sum-grid"
          style="grid-template-columns: 92px repeat({summaryPlans.length}, minmax(0, 1fr));"
        >
          <!-- Header row: plan names -->
          <div class="sg-corner"></div>
          {#each summaryPlans as p (p.planIndex)}
            <div class="sg-planhead">{p.name}</div>
          {/each}

          <!-- APPROVAL SCORE -->
          <div class="sg-rowlabel">APPROVAL SCORE</div>
          {#each summaryPlans as p (p.planIndex)}
            <div class="sg-cell sg-approval-cell">
              <div class="sg-score" class:below={!p.approved}>{p.approvalPoints}</div>
              <div class="sg-approve-label">{p.approved ? 'approved' : 'not yet approved'}</div>
              {#if p.isHighest && summaryScoresDiffer}
                <span class="sg-highest">Highest</span>
              {/if}
            </div>
          {/each}

          <!-- CHANGED FEATURES -->
          <div class="sg-rowlabel">CHANGED FEATURES</div>
          {#each summaryPlans as p (p.planIndex)}
            <div class="sg-cell sg-changes-cell">
              {#each p.changes as c (c.featureID)}
                <div class="sg-change">
                  <div class="sg-feat-line">
                    <span class="sg-feat-name">{c.displayName}</span>
                    <span class="sum-prov {c.provenance}" title={provTip(c.provenance)}
                      >{c.provenance === 'suggested' ? 'suggested' : 'you changed'}</span
                    >
                  </div>
                  <div class="sg-vals">{c.before} &rarr; {c.after}</div>
                </div>
              {/each}
            </div>
          {/each}

          <!-- IDEAS TO TRY -->
          <div class="sg-rowlabel">IDEAS TO TRY</div>
          {#each summaryPlans as p (p.planIndex)}
            <div class="sg-cell sg-ideas-cell">
              <div class="sg-chips">
                {#each p.ideas as idea (idea.name)}
                  <span class="sg-chip">{idea.verb} {idea.displayName}</span>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    </div>
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  $c-up-text: #185FA5;
  $c-up-bar: #185FA5;
  $c-down-text: #A32D2D;
  $c-down-bar: #E24B4A;

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

  .cmp-modal {
    background: white;
    border-radius: 10px;
    box-shadow: 0 8px 48px hsla(0, 0%, 0%, 0.24);
    max-width: 1040px;
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

    .cmp-title { font-size: 1.15rem; font-weight: 700; color: $gray-900; margin-bottom: 3px; }
    .cmp-subtitle { font-size: 0.9rem; color: gray; }

    .cmp-x {
      background: none; border: none; cursor: pointer; font-size: 1rem;
      color: $gray-400; padding: 2px 6px; border-radius: 4px; line-height: 1; flex-shrink: 0;
      &:hover { background: $gray-100; color: $gray-700; }
    }
  }

  /* ── Legend ────────────────────────────────────────────────────── */
  .cmp-legend {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 7px 20px;
    background: $gray-50;
    border-bottom: 1px solid $gray-200;
    flex-shrink: 0;

    .leg {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: $gray-600;
    }
    .leg-tag {
      font-weight: 700;
      &.leg-tag-up { color: $c-up-text; }
      &.leg-tag-down { color: $c-down-text; }
    }
    .leg-bar {
      display: inline-block;
      border-radius: 2px;
    }
    /* Unchanged marker: a thick horizontal gray bar (a bold em-dash). */
    .leg-unchanged {
      width: 16px;
      height: 5px;
      background: $gray-400;
    }
  }

  /* ── Scrollable area ───────────────────────────────────────────── */
  .cmp-scroll { overflow: auto; flex: 1 1 auto; }

  /* ── Table ─────────────────────────────────────────────────────── */
  .cmp-table {
    width: 100%;
    border-collapse: collapse;
    th, td { padding: 0; text-align: left; }
  }

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
    padding: 10px 12px 8px 20px;
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.06em;
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

    &.th-best { background: hsl(152, 55%, 95%); border-bottom-color: hsl(152, 50%, 50%); }

    .plan-name {
      font-size: 0.92rem; font-weight: 700; color: $gray-600; margin-bottom: 5px;
      .star { color: hsl(45, 88%, 42%); margin-right: 2px; }
    }
    .plan-pct {
      font-size: 1.45rem; font-weight: 800; color: $gray-800; line-height: 1;
      &.plan-pct-best { color: hsl(152, 48%, 32%); }
    }
    .plan-pct-label {
      font-size: 0.75rem; font-weight: 600; letter-spacing: 0.05em; color: gray; margin: 3px 0 2px;
    }
    .plan-delta {
      font-size: 0.85rem; font-weight: 600;
      &.delta-pos { color: $c-up-text; }   /* increase → blue, matching the cells */
      &.delta-neg { color: $c-down-text; } /* decrease → red */
    }
  }

  /* ── Data rows ─────────────────────────────────────────────────── */
  .data-row {
    border-bottom: 1px solid $gray-100;
    &:hover td { background: hsl(213, 100%, 98%); }
  }

  td.td-name {
    padding: 8px 12px 8px 20px;
    white-space: nowrap;

    .td-name-main { font-size: 0.92rem; font-weight: 600; color: $gray-800; }
    .td-name-orig { font-size: 0.8rem; color: $gray-500; margin-top: 1px;
      .orig-tag {
        font-size: 0.68rem; font-weight: 700; letter-spacing: 0.03em;
        text-transform: uppercase; color: $gray-400; margin-right: 3px;
      }
    }
  }

  .td-none { padding: 16px 20px; color: $gray-500; font-size: 0.9rem; }

  /* Value cells — text colored strictly by the model's per-feature contribution
     (no left bar). Neutral = value in default color; empty = muted em-dash. */
  .td-cell {
    padding: 9px 12px;
    text-align: center;
    vertical-align: middle;
    border-left: 1px solid $gray-100;
    background: white;

    .cell-val { font-size: 1rem; font-weight: 700; color: $gray-800; }
    .cell-empty { color: $gray-400; font-weight: 600; }
  }

  .td-up   { .cell-val { color: $c-up-text; } }
  .td-down { .cell-val { color: $c-down-text; } }

  /* Subtle tint on starred (best) plan columns — kept from the old design. */
  .td-best { background: hsl(152, 55%, 96%); }

  /* ── Unchanged (collapsed) ─────────────────────────────────────── */
  .uc-toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 9px 20px;
    background: $gray-50;
    border: none;
    border-top: 1px solid $gray-200;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    color: $gray-700;
    text-align: left;
    &:hover { background: $gray-100; }
    .uc-arrow { color: $gray-500; width: 10px; }
  }

  .uc-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px 24px;
    padding: 10px 20px 14px 34px;

    .uc-name { font-size: 0.88rem; color: $gray-700; }
    .uc-val  { font-size: 0.88rem; font-weight: 600; color: $gray-800; text-align: right; }
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

    .footer-note { font-size: 0.85rem; color: black; }

    .cmp-close-btn {
      background: white; border: 1px solid $gray-300; color: $gray-700;
      cursor: pointer; font-size: 0.9rem; font-weight: 600; padding: 6px 20px; border-radius: 6px;
      &:hover { background: $gray-100; }
    }
  }

  /* ══ View toggle ═══════════════════════════════════════════════════ */
  .cmp-view-toggle {
    display: flex;
    justify-content: center;
    padding: 12px 20px 10px;
    border-bottom: 1px solid $gray-200;
    flex-shrink: 0;

    .cvt-tabs {
      display: inline-flex;
      background: $gray-100;
      border: 1px solid $gray-200;
      border-radius: 8px;
      padding: 2px;
    }
    .cvt-tab {
      border: none;
      background: transparent;
      cursor: pointer;
      font-size: 0.9rem;
      font-weight: 600;
      color: $gray-600;
      padding: 6px 20px;
      border-radius: 6px;
      transition: background 120ms, color 120ms;

      &:hover:not(.active) { color: $gray-800; }
      &.active {
        background: white;
        color: $gray-900;
        box-shadow: 0 1px 3px hsla(0, 0%, 0%, 0.12);
      }
    }
  }

  /* ══ Summarized view ═══════════════════════════════════════════════ */
  .sum-header {
    padding: 16px 20px 12px;
    border-bottom: 1px solid $gray-200;
    flex-shrink: 0;

    .sum-titlebar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
    }
    .sum-title { font-size: 1.15rem; font-weight: 700; color: $gray-900; }
    .sum-subtitle { font-size: 0.9rem; color: gray; margin-top: 3px; max-width: 640px; }
  }

  .sum-legend {
    display: flex;
    gap: 10px;
    margin-top: 12px;
  }

  /* Provenance pills — reused in the legend and per-change. */
  .sum-prov {
    display: inline-flex;
    align-items: center;
    font-size: 0.68rem;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 10px;
    line-height: 1.3;
    white-space: nowrap;

    &.suggested,
    &.you-changed {
      color: #000;
      background: transparent;
      border: 1px solid #000;
    }
  }

  .sum-scroll {
    overflow-y: auto;
    overflow-x: hidden; // all plans must fit — never scroll sideways
    flex: 1 1 auto;
    padding: 4px 16px 18px;
  }

  .sum-grid {
    display: grid;
    // Stretch every cell to fill its grid row so each row's bottom border lines
    // up across all plans — one straight separator, not one per column at a
    // different height. Cell CONTENT still sits at the top (see .sg-cell).
    align-items: stretch;
    column-gap: 0; // columns touch so the vertical separators are continuous
    width: 100%;
  }

  .sg-corner { }

  /* Vertical separators between columns — a left border on every plan-column
     cell (the label column, column 1, has none). */
  .sg-planhead,
  .sg-cell {
    border-left: 1px solid $gray-200;
  }

  .sg-planhead {
    font-size: 0.85rem;
    font-weight: 700;
    color: $gray-800;
    padding: 8px 10px 6px;
    text-align: center;
    border-bottom: 2px solid $gray-200;
    min-width: 0;
  }

  .sg-rowlabel {
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: gray;
    padding: 14px 10px 0 0;
    align-self: start;
  }

  .sg-cell {
    padding: 12px 10px;
    border-bottom: 1px solid $gray-100;
    text-align: center;
    min-width: 0; // allow the column to shrink; content wraps instead of overflowing
  }

  /* Thicker separators at the two section boundaries: APPROVAL SCORE | CHANGED
     FEATURES, and CHANGED FEATURES | IDEAS TO TRY. */
  .sg-approval-cell,
  .sg-changes-cell {
    border-bottom-width: 2px;
    border-bottom-color: $gray-300;
  }

  /* APPROVAL SCORE */
  .sg-approval-cell {
    .sg-score {
      font-size: 1.55rem;
      font-weight: 800;
      line-height: 1;
      color: var(--text-primary, #000); // at/above approval → black
      &.below { color: #888780; }        // below approval → gray
    }
    .sg-approve-label {
      font-size: 0.74rem;
      color: $gray-600;
      margin-top: 4px;
    }
    .sg-highest {
      display: inline-block;
      margin-top: 7px;
      font-size: 0.64rem;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: hsl(45, 90%, 30%);
      background: hsl(45, 90%, 92%);
      border: 1px solid hsl(45, 80%, 78%);
      border-radius: 10px;
      padding: 2px 7px;
    }
  }

  /* CHANGED FEATURES */
  .sg-changes-cell {
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 11px;

    .sg-change { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; min-width: 0; }
    /* Name + provenance tag on one row — tag stays to the RIGHT of the name,
       never below it. A long name uses vertical space, wrapping onto up to TWO
       lines (kept in full), while the tag holds its place on the right. */
    .sg-feat-line {
      display: flex;
      flex-direction: row;
      flex-wrap: nowrap;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
    }
    .sg-feat-name {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.78rem;
      font-weight: 600;
      color: $gray-800;
      line-height: 1.2;
      overflow-wrap: anywhere;
      // up to two lines, then it stops (names here fit within two)
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .sum-prov { flex: 0 0 auto; }
    .sg-vals {
      font-size: 0.76rem;
      font-weight: 600;
      color: $gray-700;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
  }

  /* IDEAS TO TRY */
  .sg-ideas-cell {
    text-align: left;

    .sg-chips {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
    }
    .sg-chip {
      display: inline-flex;
      align-items: center;
      padding: 4px 9px;
      background: #fbf0da;
      border: 1px solid #e8d3a0;
      border-radius: 14px;
      color: #000;
      font-size: 0.76rem;
      font-weight: 600;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }
  }
</style>
