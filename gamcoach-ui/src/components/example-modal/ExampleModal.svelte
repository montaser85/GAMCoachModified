<script>
  /** Whether the modal is shown. Only ever opened by the user's click. */
  export let open = false;
  /** Callback to close the modal. */
  export let onClose = () => {};

  // Esc dismisses (only while open).
  const onKeydown = (e) => {
    if (open && e.key === 'Escape') onClose();
  };
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="ex-overlay" on:click|self={onClose} role="dialog" aria-modal="true">
    <div class="ex-modal">

      <div class="ex-header">
        <div class="ex-title">How Joe improved his approval</div>
        <button class="ex-x" on:click={onClose} title="Close">✕</button>
      </div>

      <div class="ex-subtitle">
        A short walkthrough of a sample applicant (Joe, #89) working through the
        same task you're doing now.
      </div>

      <!-- Video area: swap the placeholder <div> for a <video> element when the
           real walkthrough is ready — the surrounding layout stays unchanged. -->
      <div class="ex-video-area">
        <div class="ex-video-placeholder">
          <svg class="ex-play" viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
            <circle cx="24" cy="24" r="22" fill="white" stroke="currentColor" stroke-width="2"/>
            <polygon points="19,15 35,24 19,33" fill="currentColor"/>
          </svg>
          <span class="ex-coming">Example video coming soon</span>
        </div>
      </div>

      <div class="ex-footer">
        <button class="ex-close-btn" on:click={onClose}>Close</button>
      </div>

    </div>
  </div>
{/if}

<style lang="scss">
  @import '../../define';

  .ex-overlay {
    position: fixed;
    inset: 0;
    background: hsla(0, 0%, 0%, 0.48);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }

  .ex-modal {
    background: white;
    border-radius: 10px;
    box-shadow: 0 8px 48px hsla(0, 0%, 0%, 0.24);
    width: 100%;
    max-width: 640px;
    padding: 16px 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .ex-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;

    .ex-title {
      font-size: 1.15rem;
      font-weight: 700;
      color: $gray-900;
    }

    .ex-x {
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

  .ex-subtitle {
    font-size: 0.9rem;
    color: $gray-600;
    line-height: 1.4;
    margin-top: -6px;
  }

  .ex-video-area {
    width: 100%;
    aspect-ratio: 16 / 9;
    border-radius: 8px;
    overflow: hidden;
    background: $gray-100; /* surface for the (future) video */
  }

  .ex-video-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: $gray-500;

    .ex-play { color: $gray-400; }
    .ex-coming {
      font-size: 0.9rem;
      font-weight: 600;
    }
  }

  .ex-footer {
    display: flex;
    justify-content: flex-end;

    .ex-close-btn {
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
