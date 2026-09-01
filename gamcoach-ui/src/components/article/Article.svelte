<script>
  //@ts-check
  import '../../typedef';
  import Coach from '../coach/Coach.svelte';
  import DiffPicker from '../DiffPicker.svelte';
  import ConfirmModal from '../confirm-modal/ConfirmModal.svelte';
  import BookmarkPanel from '../bookmark-panel/BookmarkPanel.svelte';
  import CheckModal from '../check-modal/CheckModal.svelte';
  import Tooltip from '../Tooltip.svelte';
  import BreakdownPopup from '../BreakdownPopup.svelte';
  import Youtube from './Youtube.svelte';

  import d3 from '../../utils/d3-import';
  import { onMount, onDestroy } from 'svelte';
  import { writable } from 'svelte/store';
  import { fade, fly } from 'svelte/transition';
  import {
    tooltipConfigStore,
    constraintsStore,
    bookmarkConfigStore,
    ebmStore
  } from '../../store';
  import { Constraints } from '../coach/Coach';
  import { random } from '../../utils/utils';

  import pointArrowSVG from '../../img/point-arrow.svg';
  import iconRefreshSVG from '../../img/icon-refresh3.svg';
  import iconGithub from '../../img/icon-github.svg';
  import iconVideo from '../../img/icon-youtube.svg';
  import iconGT from '../../img/icon-gt.svg';
  import iconMS from '../../img/icon-ms.svg';
  import iconCopy from '../../img/icon-copy-box.svg';
  import iconCheckBox from '../../img/icon-check-box.svg';
  import iconPdf from '../../img/icon-pdf.svg';

  import text from '../../config/article-text.yml';

  // Import samples
  import samplesLC from '../../config/data/lc-classifier-random-samples.json';
  import samplesAdult from '../../config/data/adult-classifier-random-samples.json';
  import samplesCredit from '../../config/data/credit-classifier-random-samples.json';
  import samplesGerman from '../../config/data/german-classifier-random-samples.json';
  import samplesCompas from '../../config/data/compas-classifier-random-samples.json';
  import samplesCrime from '../../config/data/crime-classifier-random-samples.json';
  import samplesCrimeFull from '../../config/data/crime-full-classifier-random-samples.json';

  export let modelName = 'lc';

  let curSamples = samplesLC;
  let curIndex = 126;

  let bibtexCopied = false;
  let bibtexHovering = false;

  const datasetOptions = [
    { name: 'lc', display: 'Lending Club' },
    { name: 'crime', display: 'Communities & Crime' },
    { name: 'adult', display: 'Adult Census Income' },
    { name: 'german', display: 'German Credit' },
    { name: 'compas', display: 'COMPAS' },
    { name: 'credit', display: 'Credit' }
  ];

  const initModelInfo = () => {
    switch (modelName) {
      case 'lc': {
        curSamples = samplesLC;
        curIndex = 126;
        break;
      }
      case 'adult': {
        curSamples = samplesAdult;
        curIndex = 322;
        break;
      }
      case 'credit': {
        curSamples = samplesCredit;
        curIndex = 333;
        break;
      }
      case 'german': {
        curSamples = samplesGerman;
        curIndex = 181;
        break;
      }
      case 'compas': {
        curSamples = samplesCompas;
        curIndex = 380;
        break;
      }
      case 'crime-full': {
        curSamples = samplesCrimeFull;
        curIndex = 347;
        break;
      }
      case 'crime': {
        curSamples = samplesCrime;
        // curIndex = 165;
        curIndex = 368;
        break;
      }
      default: {
        console.warn('Unknown model name');
        curSamples = samplesLC;
        modelName = 'lc';
        curIndex = 126;
      }
    }
  };

  const getAgencyName = (modelName) => {
    if (modelName === 'compas') {
      return 'court';
    } else if (modelName === 'crime-full' || modelName === 'crime') {
      return 'funding agency';
    } else {
      return 'bank';
    }
  };

  const getApplicantName = (modelName) => {
    if (modelName === 'compas') {
      return 'a bail applicant';
    } else if (modelName === 'crime-full' || modelName === 'crime') {
      return 'applying for grants for county';
    } else {
      return 'a loan applicant';
    }
  };

  // localhost:5005/?dataset=compas
  const urlParams = new URLSearchParams(window.location.search);
  const urlModelName = urlParams.get('dataset');
  const validModelNames = new Set([
    'lending',
    'adult',
    'credit',
    'german',
    'compas',
    'crime',
    'crime-full'
  ]);
  if (urlModelName !== null && validModelNames.has(urlModelName)) {
    modelName = urlModelName;
  }

  initModelInfo();

  const unsubscribes = [];
  let windowLoaded = false;
  let currentPlayer = null;

  const indexFormatter = d3.format('03d');

  let verificationCode = null;
  let buttonText = "I'm Done!";
  let updated = false;

  // Initialize the logger
  const logger = null;

  // curIndex = random(0, curSamples.length - 1);
  let curExample = curSamples[curIndex];

  // On first load the left panel is a BLANK input form (empty continuous fields,
  // categoricals defaulted to their first value, no difficulty) rather than a
  // dataset profile — Coach builds those blanks when blankStart is true, and the
  // applicant number shows "#XYZ". Clicking refresh loads a real dataset profile
  // (blankStart → false, real number). `coachRemountKey` forces the {#key} to
  // remount Coach on every load/refresh/model-change (curExample alone can repeat).
  let blankStart = true;
  let coachRemountKey = 0;

  const pointArrowSVGProcessed = pointArrowSVG.replaceAll(
    'white',
    'currentcolor'
  );

  // Set up tooltip
  let tooltip = null;
  let tooltipConfig = null;
  unsubscribes.push(
    tooltipConfigStore.subscribe((value) => {
      tooltipConfig = value;
    })
  );

  /** @type {Constraints} */
  let constraints = null;
  unsubscribes.push(
    constraintsStore.subscribe((value) => {
      constraints = value;
    })
  );

  /** @type {BookmarkConfig} */
  let bookmarkConfig = null;
  unsubscribes.push(
    bookmarkConfigStore.subscribe((value) => {
      bookmarkConfig = value;
    })
  );

  const refreshClicked = () => {
    // Resample the cur example — this loads a REAL dataset profile (leaves the blank
    // input-form state and shows the real applicant number).
    curIndex = random(0, curSamples.length - 1);
    const newExample = curSamples[curIndex];

    updated = false;
    blankStart = false;
    curExample = newExample;
    coachRemountKey += 1; // force Coach to remount even if the same index recurs

    // console.log(logger?.toJSON());
  };

  const optionClicked = (e, option) => {
    if (option.name === modelName) return;

    ebmStore.set({});
    bookmarkConfigStore.set({
      show: false,
      features: null,
      plans: new Map(),
      focusOutTime: 0,
      plansInfo: null
    });
    updated = false;

    modelName = option.name;
    initModelInfo();
    curExample = curSamples[curIndex];
    coachRemountKey += 1; // remount Coach for the new model
  };

  onMount(() => {
    // window.onload = () => { windowLoaded = true; };
    windowLoaded = true;
  });

  onDestroy(() => {
    unsubscribes.forEach((unsub) => unsub());
  });
</script>

<div class="page">
  <Tooltip bind:this={tooltip} />
  <BreakdownPopup />

  <div class="top" id="top">
    <div class="top-fill" />

    <div class="top-empty" />

    <div class="coach-left">
      <!-- <div class='help-arrow'>{@html pointArrowSVGProcessed}</div> -->
      <div class="help-note">
        <div class="arrow" />
        <div class="title-top">Imagine...</div>
        <div class="title">
          You're {getApplicantName(modelName)}
        </div>
        <div class="input-number">
          <!-- The "Edit Input Values" form option was removed; users enter their
               values directly in the feature cards during first-time setup. -->
          <div
            class="svg-icon"
            title="Try a random input sample"
            on:click={() => refreshClicked()}
          >
            {@html iconRefreshSVG}
          </div>
          <div class="number">
            {#if blankStart}#XYZ{:else}#{indexFormatter(curIndex)}{updated ? '*' : ''}{/if}
          </div>
        </div>
        <div class="description">
          <span class="line"> Your application is rejected </span>
          <div class="help-arrow">{@html pointArrowSVGProcessed}</div>
          <span class="line">
            The {getAgencyName(modelName)} points you to
          </span>
          <span class="line">
            <strong>GAM Coach</strong> to help you
          </span>
          <span class="line"> succeed in next application </span>
        </div>
        {#if modelName === 'compas'}
          <div class="description">
            <span class="line" style="margin-top: 30px;">
              *We don't expect one to use COMPAS to evaluate GAM Coach; we use
              it to demonstrate the generalizability of GAM Coach.
            </span>
          </div>
        {:else if modelName === 'crime'}
          <div class="description">
            <span class="line" style="margin-top: 30px;">
              *Before training this model, we removed sensitive features (e.g.,
              Black Population) and features with many missing values.
              <a
                href="javascript:"
                on:click={(e) =>
                  optionClicked(e, {
                    name: 'crime-full',
                    display: 'Communities & Crime'
                  })}>Try full model</a
              >
            </span>
          </div>
        {:else if modelName === 'crime-full'}
          <div class="description">
            <span class="line" style="margin-top: 30px;">
              *This model was trained on sensitive features (e.g., Black
              Population) and features with many missing values.
              <a
                href="javascript:"
                on:click={(e) =>
                  optionClicked(e, {
                    name: 'crime',
                    display: 'Communities & Crime'
                  })}>Try sanitized model</a
              >
            </span>
          </div>
        {/if}
      </div>
    </div>

    {#key coachRemountKey}
      <div class="coach-wrapper">
        <Coach {windowLoaded} {curExample} {logger} {modelName} {blankStart} />
      </div>
    {/key}

    <DiffPicker {logger} />
    <ConfirmModal />
    <CheckModal />

    {#key modelName}
      <BookmarkPanel {windowLoaded} {logger} />
    {/key}
  </div>

  <div class="article appeal-article">
    <h2 id="tool">What is <span class="teal">GAM Coach</span>?</h2>
    {#each text.tool.pre as p}
      <p>{@html p}</p>
    {/each}
  </div>
</div>

<style lang="scss">
  @import './Article.scss';
</style>
