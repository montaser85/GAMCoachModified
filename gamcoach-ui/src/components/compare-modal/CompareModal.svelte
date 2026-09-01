<script>
  import { onDestroy } from 'svelte';
  import { compareOpenStore, constraintsStore, ideaApplyStore } from '../../store';
  import { planSuggestedIdeas, computeIdeasForPlan } from '../ideas/planIdeas';
  import { appliedLoanDtiContribution } from '../../engine/index.mjs';

  /** @type {import('../coach/Coach').Plans} */
  export let plans = null;
  export let planLabels = [];
  /** @type {Map<number, import('../coach/Coach').Plan>} */
  export let localPlans = null;
  /** Incremented by CoachPanel whenever any plan store updates — triggers reactive rebuild. */
  export let localPlansVersion = 0;
  /** Called with a plan index when the user clicks a plan name — switches the
   *  active plan (like the main dropdown) and closes the modal. */
  export let onSelectPlan = null;

  const selectPlan = (planIndex) => {
    if (onSelectPlan) onSelectPlan(planIndex);
  };

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

  // Whether the modal is open — the directional-filler ideas run a small
  // speculative propagation per plan, so they're only computed while open.
  let modalOpen = false;

  /**
   * The idea set shown for one plan in Compare Plans — built to MATCH the "Ideas
   * to try" panel: the plan's suggested changes WITH amounts first (blue, clickable),
   * then DIRECTIONAL fillers (amber) up to three. Each plan is filtered by ITS OWN
   * applied/dismissed set (persisted on the plan object as `dismissedIdeaNames`), so
   * acting on one plan never changes another plan's suggestions. Directional fillers
   * (a speculative what-if per feature) are computed only while the modal is open.
   */
  function buildPlanIdeas(plan) {
    const dismissed = plan.dismissedIdeaNames instanceof Set ? plan.dismissedIdeaNames : new Set();
    const amounts = planSuggestedIdeas(plan, constraints)
      .filter((i) => !dismissed.has(i.name))
      .slice(0, 3);
    const needed = Math.max(0, 3 - amounts.length);
    if (needed === 0 || !modalOpen) return amounts;
    const exclude = new Set([...amounts.map((i) => i.name), ...dismissed]);
    const directional = computeIdeasForPlan(plan, constraints)
      .filter((i) => !exclude.has(i.name))
      .slice(0, needed)
      .map((i) => ({ ...i, mode: 'direction' }));
    return [...amounts, ...directional];
  }

  /** Apply a clickable (amount) idea: same channel as the panel's chips, then
   *  return to the main view. FeaturePanel enacts it on the active plan and marks
   *  the feature dismissed, so it drops out of both surfaces. */
  function applyIdeaFromCompare(idea) {
    if (!idea || idea.mode !== 'amount' || idea.applyValue === undefined) return;
    ideaApplyStore.set({ name: idea.name, value: idea.applyValue });
    compareOpenStore.set(false);
  }

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

  /**
   * The applicant's ORIGINAL profile DTI (model units), used as the "before" for
   * the DTI row. The generation baseline (plan.curExample) folds the applied-for
   * loan's monthly payment into DTI, so plan.curExample[dti] is the loan-inclusive
   * value (e.g. 30.22), not the profile value the applicant entered (e.g. 20.47).
   * Subtract that same contribution back out — matching the main-panel DTI card,
   * whose left value is likewise the raw profile DTI. A no-op when the fold is off.
   */
  function rawProfileDtiValue(plan, dtiFeatureID) {
    const names = plan.features.map((f) => f.data.name);
    const example = plan.features.map((f) => plan.curExample[f.featureID]);
    const contribution = appliedLoanDtiContribution(example, names);
    return (plan.curExample[dtiFeatureID] || 0) - contribution;
  }

  /** The display "before" value for a feature: the raw profile DTI for `dti`,
   *  otherwise the plan's baseline example value. */
  function originalValueFor(plan, feature) {
    if (feature.data?.name === 'dti') {
      return rawProfileDtiValue(plan, feature.featureID);
    }
    return plan.curExample[feature.featureID];
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
            // "before" = raw profile DTI for `dti` (baseline folds the applied
            // loan into DTI); the plan's baseline example value otherwise.
            const originalDisplay = formatVal(originalValueFor(plan, f), f);
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

        // RE-BASELINE: every plan's live state is the same user baseline now, so
        // the old applied-value comparison is degenerate. Compare Plans instead
        // shows each plan's distinct IDEA SET (its suggested changes, with
        // amounts) — that is what differs between plans.
        return {
          planIndex: idx,
          name: label?.name ?? `Plan ${idx}`,
          approvalPoints: pts,
          approved,
          isHighest: false,
          ideas: buildPlanIdeas(p)
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
    modalOpen = isOpen;
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

      <!-- RE-BASELINE: Compare Plans now shows each plan's idea set (its suggested
           changes). The old side-by-side applied-value comparison is degenerate
           (every plan's live state is the same user baseline), so the view toggle
           and the detailed matrix below are no longer shown. -->

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
                  <!-- svelte-ignore a11y-click-events-have-key-events -->
                  <div
                    class="plan-name plan-name-link"
                    role="button"
                    tabindex="0"
                    title="Open {plan.name} in the main view"
                    on:click={() => selectPlan(plan.planIndex)}
                    on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPlan(plan.planIndex); } }}
                  >
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
          Each plan suggests a different set of changes that would reach approval.
          Try any idea by editing that feature yourself.
        </div>
      </div>

      {#if summaryPlans.length === 0}
        <!-- Ideas depend on generation (the ~70s solve) — show a loading state
             rather than an empty/stale grid. -->
        <div class="sum-loading">
          <div class="plan-loading-spinner" />
          <div class="sum-loading-text">Generating ideas…</div>
          <div class="sum-loading-sub">This can take a few moments.</div>
        </div>
      {:else}
      <div class="sum-scroll">
        <div
          class="sum-grid"
          style="grid-template-columns: 92px repeat({summaryPlans.length}, minmax(0, 1fr));"
        >
          <!-- Header row: plan names (click to open that plan in the main view) -->
          <div class="sg-corner"></div>
          {#each summaryPlans as p (p.planIndex)}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <div
              class="sg-planhead sg-planhead-link"
              role="button"
              tabindex="0"
              title="Open {p.name} in the main view"
              on:click={() => selectPlan(p.planIndex)}
              on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectPlan(p.planIndex); } }}
            >{p.name}</div>
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

          <!-- IDEAS TO TRY — each plan's suggested changes (with amounts) + directional
               fillers, matching the "Ideas to try" panel: light-blue clickable chips
               for the exact-amount suggestions (click to apply + return to the main
               view), amber chips for the directional ideas. -->
          <div class="sg-rowlabel">IDEAS TO TRY</div>
          {#each summaryPlans as p (p.planIndex)}
            <div class="sg-cell sg-ideas-cell">
              <div class="sg-chips">
                {#each p.ideas as idea (idea.name)}
                  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
                  <span
                    class="sg-chip"
                    class:sg-chip-apply={idea.mode === 'amount'}
                    role={idea.mode === 'amount' ? 'button' : undefined}
                    tabindex={idea.mode === 'amount' ? 0 : undefined}
                    title={idea.mode === 'amount'
                      ? `Click to apply: ${idea.verb} ${idea.displayName} to ${idea.targetDisplay}`
                      : ''}
                    on:click={() => applyIdeaFromCompare(idea)}
                    on:keydown={(e) => {
                      if (idea.mode === 'amount' && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault();
                        applyIdeaFromCompare(idea);
                      }
                    }}
                    >{idea.verb} {idea.displayName}{idea.mode === 'amount' &&
                    idea.targetDisplay
                      ? ` to ${idea.targetDisplay}`
                      : ''}</span
                  >
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </div>
      {/if}
    {/if}

    </div>
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  // Loading state shown while plans/ideas are still generating.
  .sum-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 60px 20px;

    .plan-loading-spinner {
      width: 34px;
      height: 34px;
      border: 3px solid $gray-200;
      border-top-color: $blue-500;
      border-radius: 50%;
      animation: cmp-spin 0.9s linear infinite;
    }
    .sum-loading-text {
      font-size: 1.15rem;
      font-weight: 600;
      color: $gray-800;
    }
    .sum-loading-sub {
      font-size: 0.95rem;
      color: $gray-500;
    }
  }
  @keyframes cmp-spin {
    to { transform: rotate(360deg); }
  }

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
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-top: 12px;

    .sum-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    // Explanation shown inline to the right of each pill (no hover needed here).
    .sum-legend-desc {
      font-size: 0.72rem;
      font-weight: 500;
      color: $gray-600;
      line-height: 1.3;
    }
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

    &.suggested {
      color: #000;
      background: transparent; // white
      border: 1px solid #000;
    }

    &.you-changed {
      color: #000;
      background: #dcdcdc; // light gray — distinct from the white "suggested" pill
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

  /* Clickable plan names (both views) — open that plan in the main view. */
  .sg-planhead-link,
  .plan-name-link {
    cursor: pointer;
    transition: color 100ms ease-in-out;

    &:hover { color: $blue-600; text-decoration: underline; }
    &:focus-visible { outline: 2px solid $blue-500; outline-offset: 1px; border-radius: 3px; }
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
    // Directional ideas — amber lever chips (matches the panel's .it-chip).
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

    // Exact-amount suggestions — very light blue, clickable to apply (matches the
    // panel's .it-chip-apply).
    .sg-chip-apply {
      background: #eaf4fd;
      border-color: #bcdcf5;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease;

      &:hover {
        background: #d8ebfb;
        border-color: #93c6ef;
      }
      &:focus-visible {
        outline: 2px solid #93c6ef;
        outline-offset: 1px;
      }
    }
  }
</style>
