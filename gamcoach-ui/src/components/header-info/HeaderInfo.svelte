<script>
  // Reusable info ("i") icon with a hover popup, styled to match the left-panel
  // feature-card info icons (FeatureCard.scss .link-icon / .link-popup). Display
  // only. The popup anchors to the nearest positioned ancestor — give the header
  // that hosts this a `position: relative` so it right-aligns within the panel.
  /** One-line definition shown on hover. */
  export let text = '';
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
<span class="header-info" on:click|stopPropagation>
  <span class="hi-badge">i</span>
  <span class="hi-popup">{text}</span>
</span>

<style lang="scss">
  @import '../../define';

  .header-info {
    position: relative; // anchor the popup to the icon itself, so it sits right below
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: $blue-500;
    cursor: pointer;
    padding: 0 2px;
    transition: color 0.15s;

    .hi-badge {
      width: 18px;
      height: 18px;
      background: transparent;
      border: 2.5px solid $blue-500;
      border-radius: 50%;
      color: $blue-500;
      font-size: 12px;
      font-weight: 700;
      font-style: italic;
      font-family: Georgia, serif;
      -webkit-text-stroke: 0.4px currentColor;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
      pointer-events: none;
      transition: border-color 0.15s, color 0.15s;
    }

    // Anchored to the icon itself (.header-info is position:relative) so the popup
    // drops immediately below the "i", close to it — not way out at the header edge.
    .hi-popup {
      @include hover-tip;  // shared panel-wide tooltip look (size + frame)
      display: none;
      position: absolute;
      left: 0;
      top: 100%;
      margin-top: 4px;
      width: 240px;
      max-width: 90vw;
      font-style: normal;
      z-index: 500;
      white-space: normal;
      text-align: left;
      cursor: default;
    }

    &:hover {
      color: $blue-700;
      .hi-badge { border-color: $blue-700; color: $blue-700; }
      .hi-popup { display: block; }
    }
  }
</style>
