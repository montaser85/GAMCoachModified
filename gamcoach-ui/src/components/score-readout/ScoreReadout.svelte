<script>
  // @ts-check
  import { onDestroy } from 'svelte';
  import { sigmoid } from '../../ebm/ebm';

  /** Active plan store (writable<Plan>) or null while loading. */
  export let planStore = null;

  const THRESHOLD = 50; // approval threshold, in points (0.5 → 50)

  let plan = null;
  let unsub = null;
  // Re-subscribe whenever the store prop changes (e.g. plan switch).
  $: resubscribe(planStore);
  function resubscribe(store) {
    if (unsub) { unsub(); unsub = null; }
    plan = null;
    if (store) unsub = store.subscribe((v) => { plan = v; });
  }
  onDestroy(() => { if (unsub) unsub(); });

  // Scores as "points" (probability × 100), matching ScorePanel's math.
  $: curProb = plan ? sigmoid(plan.ebmLocal.predScore) : null;
  $: origProb = plan ? sigmoid(plan.originalScore) : null;
  $: curPoints = curProb === null ? null : Math.round(curProb * 100);
  $: origPoints = origProb === null ? null : Math.round(origProb * 100);
  // Bar position (0–100), clamped.
  $: curPct = curPoints === null ? 0 : Math.max(0, Math.min(100, curPoints));
  $: approved = curPoints !== null && curPoints >= THRESHOLD;
</script>

<div class="score-readout">
  {#if curPoints !== null}
    <div class="sr-orig-label">Original score: <b>{origPoints}</b></div>

    <div class="sr-main">
      <div class="sr-bar-col">
        <!-- Approval label + green marker above the threshold -->
        <div class="sr-approval" style="left: {THRESHOLD}%">
          <span class="sr-approval-text">Approval</span>
          <span class="sr-approval-tri"></span>
        </div>

        <div class="sr-bar">
          <div class="sr-fill" style="width: {curPct}%"></div>
          <div class="sr-tick" style="left: {THRESHOLD}%"></div>
          <div class="sr-dot" style="left: {curPct}%"></div>
        </div>
      </div>

      <div class="sr-readout">
        <div class="sr-points">
          {#if approved}
            <span class="sr-num">{curPoints}</span>
            <span class="sr-unit">points</span>
          {:else}
            <span class="sr-num">{THRESHOLD - curPoints}</span>
            <span class="sr-unit">points to approval</span>
          {/if}
        </div>
        <div class="sr-status" class:approved class:rejected={!approved}>
          {#if approved}✓ Approved{:else}✗ Not approved{/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style lang="scss">
  @import '../../define';

  .score-readout {
    padding: 4px 2px;
  }

  .sr-orig-label {
    font-size: 0.85rem;
    color: $gray-700;
    margin-bottom: 12px;
    b { color: $gray-900; }
  }

  .sr-main {
    display: flex;
    align-items: flex-end;
    gap: 22px;
  }

  /* ── Bar ─────────────────────────────────────────────────────────── */
  .sr-bar-col {
    flex: 1 1 auto;
    min-width: 0;
    position: relative;
    padding-top: 22px; /* room for the Approval marker above the bar */
  }

  .sr-approval {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    line-height: 1;

    .sr-approval-text {
      font-size: 0.72rem;
      font-weight: 600;
      color: hsl(140, 45%, 34%);
      margin-bottom: 2px;
    }
    /* small green downward triangle pointing at the threshold */
    .sr-approval-tri {
      width: 0;
      height: 0;
      border-left: 5px solid transparent;
      border-right: 5px solid transparent;
      border-top: 6px solid hsl(140, 55%, 40%);
    }
  }

  .sr-bar {
    position: relative;
    height: 14px;
    border-radius: 7px;
    background: hsl(140, 55%, 90%); /* light-green destination track */
    overflow: visible;
  }

  .sr-fill {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    border-radius: 7px;
    background: hsl(140, 55%, 45%); /* filled green up to current score */
    transition: width 200ms ease-out;
  }

  .sr-tick {
    position: absolute;
    top: -3px;
    height: 20px;
    width: 2px;
    background: $gray-900; /* vertical black tick at the threshold */
    transform: translateX(-50%);
  }

  .sr-dot {
    position: absolute;
    top: 50%;
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: $blue-500;              /* blue dot at the current score */
    border: 2px solid white;
    box-shadow: 0 1px 3px hsla(0, 0%, 0%, 0.25);
    transform: translate(-50%, -50%);
    transition: left 200ms ease-out;
  }

  /* ── Right readout ───────────────────────────────────────────────── */
  .sr-readout {
    // Fixed width so the score bar to its left NEVER shrinks, regardless of the
    // readout text ("62 points" vs "28 points to approval"). The longer label
    // wraps within this width — using vertical space, not horizontal.
    flex: 0 0 118px;
    width: 118px;
    text-align: right;

    .sr-points {
      // Horizontal, single line (keeps the panel short). The short labels
      // ("50 points" / "5 pts to go") fit within the fixed readout width.
      display: flex;
      flex-direction: row;
      align-items: baseline;
      justify-content: flex-end;
      gap: 4px;
      white-space: nowrap;
      color: $gray-900;
      line-height: 1.1;

      .sr-num {
        font-size: 1.6rem;
        font-weight: 800;
      }
      .sr-unit {
        font-size: 0.9rem;
        font-weight: 600;
        color: $gray-700;
      }
    }
    .sr-status {
      margin-top: 4px;
      font-size: 0.9rem;
      font-weight: 700;
      &.approved { color: hsl(140, 55%, 34%); }
      &.rejected { color: $red-600; }
    }
  }
</style>
