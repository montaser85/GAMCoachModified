<script>
  // @ts-check
  import d3 from '../../utils/d3-import';
  import { Logger } from '../../utils/logger';
  import { bindInlineSVG, downloadText } from '../../utils/utils';
  import { onMount } from 'svelte';
  import { bookmarkConfigStore } from '../../store';
  import { downloadReceipt } from './BookmarkPanel';
  import { PLAN_NOTE_FIELDS } from '../coach/Coach';
  import { loanCostFromExample } from '../../engine/index.mjs';

  /** True when a frozen note object has at least one answered question. */
  const hasSavedNote = (note) =>
    !!note && Object.values(note).some((v) => v && String(v).trim());

  // ── Loan-cost box (frozen snapshot) ─────────────────────────────────────────
  // The total the borrower will actually repay, computed from the SAVED plan's
  // frozen sample (loan amount / term / purpose-APR) via the same amortization the
  // DTI fold uses — never the live plan. Display-only.
  const money = (x) => Math.round(x).toLocaleString('en-US');
  const moneyApprox = (x) => (Math.round(x / 100) * 100).toLocaleString('en-US');

  /** Amortized cost of a saved plan's frozen loan, or null if it can't be resolved. */
  const getLoanCost = (savedPlan) => {
    if (!bookmarkConfig.features || !savedPlan) return null;
    // sample is indexed by featureID; build a name-by-index lookup to match.
    const names = [];
    bookmarkConfig.features.forEach((f) => {
      names[f.featureID] = f.data.name;
    });
    const cost = loanCostFromExample(savedPlan.sample, names);
    if (!cost || !(cost.termMonths > 0)) return null;
    return cost;
  };
  import { privateKey, publicKey } from '../../config/key';
  import {
    readKey,
    createCleartextMessage,
    decryptKey,
    sign,
    readPrivateKey
  } from 'openpgp';

  import receiptIcon from '../../img/icon-receipt.svg';
  import trashIcon from '../../img/icon-trash2.svg';
  import closeIcon from '../../img/icon-close-outline.svg';

  export let windowLoaded = false;

  /** @type {Logger} */
  export let logger = null;

  // Component bindings
  let component = null;
  let dlAnchor = null;
  let initialized = false;

  const formatter = d3.format(',.2~f');

  // Set up the stores
  let bookmarkConfig = {
    show: false,
    features: null,
    plans: new Map(),
    focusOutTime: 0,
    plansInfo: null
  };

  bookmarkConfigStore.subscribe((value) => {
    if (value.show) {
      d3.select(component).node()?.focus();
    }
    bookmarkConfig = value;
  });

  const closeClicked = () => {
    bookmarkConfig.show = false;
    bookmarkConfig.focusOutTime = Date.now();
    bookmarkConfigStore.set(bookmarkConfig);
  };

  /**
   * Remove the plan from the bookmark
   * @param {number} planIndex
   */
  const deleteClicked = (planIndex) => {
    bookmarkConfig.plans.delete(planIndex);
    bookmarkConfig.action = 'delete';
    bookmarkConfigStore.set(bookmarkConfig);
  };

  const downloadClicked = async () => {
    const receiptText = await downloadReceipt(bookmarkConfig);
    // const pgpPublicKey = await readKey({ armoredKey: publicKey });

    const pgpPrivateKey = await decryptKey({
      privateKey: await readPrivateKey({ armoredKey: privateKey }),
      passphrase: 'gamcoach!'
    });

    const unsignedMessage = await createCleartextMessage({ text: receiptText });
    const cleartextMessage = await sign({
      message: unsignedMessage,
      signingKeys: pgpPrivateKey
    });

    downloadText(cleartextMessage, dlAnchor, 'gamcoach-receipt.txt');

    // Log the interaction
    logger?.addLog({
      eventName: 'receipt downloaded',
      elementName: 'bookmark',
      valueName: 'receipt',
      oldValue: null,
      newValue: cleartextMessage
    });
  };

  /**
   * @param {BookmarkConfig} bookmarkConfig
   */
  const getGoal = (bookmarkConfig) => {
    if (bookmarkConfig.plansInfo === null) {
      return '...';
    }

    if (bookmarkConfig.plansInfo.isRegression) {
      // TODO
    } else {
      const goal =
        bookmarkConfig.plansInfo.classes[
          bookmarkConfig.plansInfo.classTarget[0]
        ];
      return goal;
    }
  };

  /**
   * Position the panel under bookmarks and generate buttons
   */
  const initPanel = () => {
    initialized = true;
    const controlBBox = d3
      .select('.coach-panel-wrapper')
      .select('.coach-controls')
      .node()
      .getBoundingClientRect();

    d3.select(component)
      .style('left', `${controlBBox.left}px`)
      .style('width', `${controlBBox.width}px`);
  };

  onMount(() => {
    const iconList = [
      { class: 'icon-receipt', svg: receiptIcon },
      { class: 'icon-close', svg: closeIcon }
    ];
    bindInlineSVG(component, iconList);

    // Register the focusout event
    d3.select(component).on('focusout', () => {
      if (bookmarkConfig.show) {
        bookmarkConfig.show = false;
        bookmarkConfig.focusOutTime = Date.now();
        bookmarkConfigStore.set(bookmarkConfig);
      }
    });
  });

  $: windowLoaded && !initialized && initPanel();
</script>

<div
  class="bookmark"
  tabIndex="0"
  bind:this={component}
  class:show={bookmarkConfig.show}
>
  <a bind:this={dlAnchor} id="download-anchor" style="display:none" />
  <div class="header">
    <div class="title-line">
      <span class="title">Your Saved Plans</span>
      <span class="svg-icon icon-close" on:click={() => closeClicked()} />
    </div>
    <span class="description">
      Once you have accomplished any one of the plans, we will guarantee you a {getGoal(
        bookmarkConfig
      )}.
    </span>
  </div>

  <div class="plan-list">
    {#if bookmarkConfig.plans.size === 0}
      <div class="description">
        To save a plan you like, click the star next to the plan name
      </div>
    {:else}
      {#each [...bookmarkConfig.plans] as [planIndex, savedPlan]}
        {@const cost = getLoanCost(savedPlan)}
        <div class="plan-row">
          <div class="plan-title">
            <span class="plan-title-name">Plan {planIndex}</span>
            <span
              class="svg-icon delete"
              on:click={() => deleteClicked(planIndex)}
              title="Remove this plan">{@html trashIcon}</span
            >
          </div>
          <div class="plan-body">
            <div class="plan-features">
              {#each savedPlan.getChangeList(bookmarkConfig.features) as item}
                <div class="plan-feature">
                  <div class="feature-name">{item.featureDisplayName}</div>
                  <div class="values">
                    {item.isCont
                      ? formatter(item.originalValue)
                      : item.originalValue}
                    <div class="feature-arrow" class:user={false}>
                      {#if item.isCont}
                        <span class="value-change">
                          {`${item.changeValue < 0 ? '' : '+'}${formatter(
                            item.changeValue
                          )}`}
                        </span>
                        <div class="arrow-right" />
                      {:else}
                        <div class="arrow-right-cat" />
                      {/if}
                    </div>
                    {item.isCont ? formatter(item.newValue) : item.newValue}
                  </div>
                </div>
              {/each}
            </div>

            <!-- Loan-cost box: fills the empty right-side space. Frozen snapshot. -->
            {#if cost}
              <div class="loan-cost-box">
                <div class="lc-total">
                  <span class="lc-total-label">Total you'll repay</span>
                  <span class="lc-total-amt">~${moneyApprox(cost.total)}</span>
                </div>
                <div class="lc-split">
                  Your ${money(cost.loanAmount)} loan
                  + ~${moneyApprox(cost.interest)} interest
                </div>
                <div class="lc-monthly">
                  ${money(cost.monthly)}/month for {cost.termMonths} months
                  ({(cost.apr * 100).toFixed(2)}% APR)
                </div>
              </div>
            {/if}
          </div>
          {#if hasSavedNote(savedPlan.rationale)}
            <div class="plan-rationale">
              <span class="plan-rationale-label">Your notes</span>
              {#each PLAN_NOTE_FIELDS as f (f.key)}
                {#if savedPlan.rationale[f.key] && savedPlan.rationale[f.key].trim()}
                  <div class="plan-note-item">
                    <span class="pn-q">{f.label}</span>
                    <span class="pn-a">{savedPlan.rationale[f.key]}</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>

  <div class="download" on:click={() => downloadClicked()}>
    <span class="text">Download Receipt</span>
    <span class="svg-icon icon-receipt" />
  </div>
</div>

<style lang="scss">
  @import './BookmarkPanel.scss';
</style>
