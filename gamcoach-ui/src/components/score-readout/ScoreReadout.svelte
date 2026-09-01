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
  // Approval keys off the TRUE probability (0.5 threshold), never the rounded
  // points — otherwise a score in [0.495, 0.50) would round to 50 and falsely read
  // "Approved". A plan below 0.5 must read "Not approved."
  $: approved = curProb !== null && curProb >= 0.5;
</script>

<div class="score-readout">
  {#if curPoints !== null}
    <!-- Compact top row above the bar: approval status on the left, original score
         on the right — moved out of the right readout column to save vertical space. -->
    <div class="sr-top">
      <div class="sr-status" class:approved class:rejected={!approved}>
        {#if approved}✓ Approved{:else}✗ Not approved{/if}
      </div>
      <div class="sr-orig-label">Original score: <b>{origPoints}</b></div>
    </div>

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
        <!-- Always the CURRENT score as "# points". Gray while below approval
             (curProb < 0.5), black once approval is reached — keyed off `approved`
             so the color matches the ✓/✗ status shown above the bar. -->
        <div class="sr-points" class:sr-below={!approved}>
          <span class="sr-num">{curPoints}</span>
          <span class="sr-unit">points</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style lang="scss">
  @import '../../define';

  .score-readout {
    padding: 1px 2px;
  }

  // Top row above the bar: status (left) + original score (right), on one line.
  .sr-top {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 4px;
  }

  .sr-orig-label {
    font-size: 1.02rem;
    color: $gray-700;
    b { color: $gray-900; }
  }

  // Approval status — now top-left, above the bar.
  .sr-status {
    font-size: 1.08rem;
    font-weight: 700;
    white-space: nowrap;
    &.approved { color: hsl(140, 55%, 34%); }
    &.rejected { color: $red-600; }
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
    padding-top: 15px; /* room for the Approval marker above the bar */
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
      font-size: 0.77rem;
      font-weight: 600;
      color: hsl(140, 45%, 34%);
      margin-bottom: 1px;
    }
    /* small green downward triangle pointing at the threshold */
    .sr-approval-tri {
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid hsl(140, 55%, 40%);
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
    // WRAPS within this width (using vertical space, not horizontal) so it can never
    // overflow left onto the bar.
    flex: 0 0 156px;
    width: 156px;
    text-align: right;

    .sr-points {
      // The number and its unit sit on a line; when the unit is long ("points to
      // approval") it wraps to the next line within the readout width instead of
      // overrunning the bar. flex-wrap + normal white-space enable that wrap.
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: flex-end;
      gap: 0 4px;
      white-space: normal;
      color: $gray-900;
      line-height: 1.15;

      .sr-num {
        font-size: 1.92rem;
        font-weight: 800;
      }
      .sr-unit {
        font-size: 1.08rem;
        font-weight: 600;
        color: $gray-700;
      }

      // Below approval (< 50 / not approved): render the whole score gray. At or
      // above approval it keeps the default black (.sr-num inherits $gray-900).
      &.sr-below {
        .sr-num { color: $gray-500; }
        .sr-unit { color: $gray-500; }
      }
    }
  }
</style>
