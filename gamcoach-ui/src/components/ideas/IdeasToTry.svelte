<script>
  // @ts-check
  // "Ideas to try" — right-panel section (below "What's driving this score").
  // Display-only: renders the directional suggestions computed by FeaturePanel's
  // isolated speculative what-if evaluation. Verb + feature name only — no target
  // values and no magnitudes (users engage their own reasoning; a specific number
  // would imply precision the model can't guarantee).
  import { onDestroy } from 'svelte';
  import { ideasStore } from '../../store';

  /** @type {Array<{name:string, displayName:string, verb:string, direction:string}>} */
  let ideas = [];
  const unsub = ideasStore.subscribe((v) => (ideas = v));
  onDestroy(unsub);
</script>

{#if ideas.length > 0}
  <div class="ideas-to-try">
    <div class="it-title">
      Ideas to try
      <span
        class="it-info"
        title="Directional next steps our what-if analysis suggests, strongest first. We show a direction only — the amount is up to you."
        >i</span
      >
    </div>

    <div class="it-chips">
      {#each ideas as idea (idea.name)}
        <span class="it-chip" title="{idea.verb} {idea.displayName}">
          <span class="it-verb">{idea.verb}</span>
          <span class="it-feat">{idea.displayName}</span>
        </span>
      {/each}
    </div>
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  .ideas-to-try {
    margin-top: 22px;
    padding-top: 18px;
    border-top: 1px solid $gray-200;
  }

  .it-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 1rem;
    font-weight: 700;
    color: $gray-900;
    margin-bottom: 10px;
  }

  .it-info {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    border: 1px solid $gray-400;
    color: $gray-500;
    font-size: 0.68rem;
    font-weight: 700;
    font-style: italic;
    cursor: default;
    flex: 0 0 auto;
  }

  .it-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 10px;
  }

  /* Amber lever chips (finalized style). */
  .it-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    background: #fbf0da;
    border: 1px solid #e8d3a0;
    border-radius: 18px;
    color: #000;
    font-size: 0.88rem;
    line-height: 1.2;
    cursor: default;

    .it-verb {
      font-weight: 700;
    }

    .it-feat {
      font-weight: 500;
    }
  }
</style>
