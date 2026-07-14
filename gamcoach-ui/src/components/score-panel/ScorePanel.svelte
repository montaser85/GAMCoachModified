<script>
  // @ts-check
  import '../../typedef';
  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { onMount, onDestroy, tick } from 'svelte';
  import { tooltipConfigStore } from '../../store';
  import { ScorePanel } from './ScorePanel';

  export let scoreWidth = 0;
  export let planLabel = null;
  export let planStore = null;
  export let isFailed = false;

  /** @type {Logger} */
  export let logger = null;

  const unsubscribes = [];
  let isInRange = false;
  let initialized = false;
  let mounted = false;
  let plan = null;

  let tooltipConfig = null;
  unsubscribes.push(
    tooltipConfigStore.subscribe((value) => {
      tooltipConfig = value;
    })
  );

  /** @type {HTMLElement} */
  let component = null;

  /** @type {HTMLElement} */
  let decision = null;

  /** @type {ScorePanel} */
  let scorePanel = null;

  // Settled score change (±pp, always vs the ORIGINAL score) published by
  // ScorePanel; null = no label.
  let delta = null;

  // Live label position, tracked with a rAF loop that runs only while a delta
  // exists. Continuously reading the bar's rect (instead of one-shot resize /
  // intersection events) self-heals through tab width animations, tab switches,
  // window resizes, and scrolling: whenever the bar is laid out, `pos` is valid
  // and the label shows at the right spot; whenever it isn't (collapsed tab),
  // `pos` is null and the label hides — then reappears on its own.
  let pos = null;
  let rafId = null;
  let panelHover = false; // hide the label while the bar's hover tooltips show

  const trackLabelPos = () => {
    pos = scorePanel ? scorePanel.getDeltaLabelPos() : null;
    rafId = requestAnimationFrame(trackLabelPos);
  };
  const stopTracking = () => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    pos = null;
  };

  const handleDelta = (d) => {
    delta = d;
    if (d && rafId === null) trackLabelPos();
    else if (!d) stopTracking();
  };

  $: showLabel = delta && pos && !panelHover;

  // Move the label to <body>: an ancestor with a CSS transform (e.g. tab
  // animations) would otherwise re-anchor position:fixed and misplace it.
  const portal = (node) => {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  };

  const updateInRange = (newValue) => {
    if (isInRange !== newValue) {
      let parentNode = d3.select(component).node();
      while (!parentNode.classList.contains('tab') && parentNode !== null) {
        parentNode = parentNode.parentElement;
      }
      d3.select(parentNode)
        .select('.star-wrapper')
        .classed('disabled', !newValue)
        .attr('title', newValue
          ? 'Click to save this plan'
          : 'You can only save plans that give you desired outcomes'
        );
    }
    isInRange = newValue;
  };

  const initScorePanel = async () => {
    initialized = true;
    isInRange = !isFailed;

    unsubscribes.push(
      planStore.subscribe(value => { plan = value; })
    );

    await tick();

    scorePanel = new ScorePanel(
      component, scoreWidth, planLabel, planStore,
      tooltipConfigStore, updateInRange, logger, handleDelta
    );

    d3.select(decision).style('width', `${planLabel.textWidth}px`);
    scorePanel.initSVG();
  };

  const planLabelUpdated = () => {
    scorePanel?.destroy();
    delta = null; // stale after re-init
    stopTracking();
    initialized = false;
  };

  onMount(() => { mounted = true; });

  onDestroy(() => {
    unsubscribes.forEach((unsub) => unsub());
    stopTracking();
    scorePanel?.destroy();
  });

  $: mounted && !initialized && scoreWidth > 0 && planLabel.textWidth > 0 &&
    planStore && initScorePanel();
  $: planLabel && planLabelUpdated();
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div
  class="score-panel"
  bind:this={component}
  on:mouseenter={() => { panelHover = true; }}
  on:mouseleave={() => { panelHover = false; }}
>
  <svg class="score-svg" width="10" height="10"/>
  {#if showLabel}
    <span
      class="delta-label"
      class:met={delta.thresholdMet}
      class:up={!delta.thresholdMet && delta.direction === 'up'}
      class:down={!delta.thresholdMet && delta.direction === 'down'}
      style="left: {pos.screenX}px; top: {pos.screenY}px"
      use:portal
    >
      <span
        class="dl-pp"
        class:pp-up={delta.deltaPP > 0}
        class:pp-down={delta.deltaPP < 0}
      >{delta.deltaPP > 0 ? '+' : '−'}{Math.abs(delta.deltaPP)}pp</span>
      <span class="dl-sep">|</span>
      {#if delta.thresholdMet}
        <span class="dl-dist">approval reached</span>
      {:else}
        <span class="dl-dist">{delta.distancePP}pp to approval</span>
      {/if}
    </span>
  {/if}
  {#if plan}
    <span class='decision'
      class:regression={planLabel.isRegression}
      class:isInRange={isInRange}
      bind:this={decision}
    >
      {#if planLabel.isRegression}
        {planLabel.score}
      {:else}
        {#if isInRange}
          {planLabel.classes[planLabel.score]}
        {:else}
          {planLabel.classes[planLabel.failTarget]}
        {/if}
      {/if}
    </span>
  {/if}
</div>

<style lang="scss">
  @import './ScorePanel.scss';

  /* Settled score change (±Xpp), floating just above the bar over the changed
     region. position:fixed with viewport coords so the compact tab can't clip
     it; pointer-events off so it never blocks the bar's hover targets. */
  .delta-label {
    position: fixed;
    transform: translate(-50%, -100%);
    font-size: 0.9rem;
    font-weight: 700;
    line-height: 1.35;
    white-space: nowrap;
    pointer-events: none;
    z-index: 9500;
    padding: 2px 10px;
    border-radius: 11px;
    box-shadow: 0 1px 4px hsla(0, 0%, 0%, 0.12);

    /* The ±pp number uses the SAME colors as the bar's delta highlight
       ($blue-500 / $red-500); the distance / "approval reached" text is black. */
    .dl-pp.pp-up   { color: $blue-500; }
    .dl-pp.pp-down { color: $red-500; }
    .dl-sep { margin: 0 4px; color: black; opacity: 0.45; font-weight: 500; }
    .dl-dist { font-weight: 600; color: black; }

    &.up   { background: #E7F1FB; }
    &.down { background: #FBE9E8; }
    &.met  { background: #E4F5EA; }
  }
</style>
