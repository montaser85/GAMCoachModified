import d3 from '../../utils/d3-import';
import { Logger } from '../../utils/logger';
import { config } from '../../config/config';
import { round } from '../../utils/utils';
import { Writable } from 'svelte/store';
import '../../typedef';
import { Plan } from '../coach/Coach';
import { sigmoid } from '../../ebm/ebm';
import { propagatedFeaturesStore, breakdownPopupStore } from '../../store';

const formatter = d3.format(',.2~f');

export class ScorePanel {
  width;
  // The bar band: the bar sits in the vertical MIDDLE of the 46px band
  // (padding.top/bottom balance it), and the ±pp chip renders in the strip
  // just ABOVE the bar — inside the band, clear of the toolbar buttons.
  height = 46;
  rectHeight = 8;
  rectRadius = 5;
  lineWidth = 2;
  planLabel;

  tooltipConfig;
  tooltipConfigStore;
  mouseoverTimeout;

  /** @type {Plan} */
  plan = null;
  unsubscribes = [];

  curValue = 0;
  originalValue = 0;
  minThreshold = 0;
  maxThreshold = 0;

  svg = null;
  svgInitialized = false;

  padding = {
    top: 18,   // bar sits in the band's lower half (bar spans y31–39) so the
    bottom: 7, // vertical lines (which rise above the bar) stay below the chip
    right: 8,
    left: 5
  };

  /** @type {HTMLElement} */
  component;
  xScale;

  /**
   * Initialize the score panel
   * @param {HTMLElement} component
   * @param {number} scoreWidth
   * @param {object} planLabel
   * @param {Writable<Plan>} planStore
   * @param {import('svelte/store').Writable} tooltipConfigStore
   * @param {(newValue: boolean) => void} updateInRange
   * @param {Logger | null} logger
   */
  constructor(
    component,
    scoreWidth,
    planLabel,
    planStore,
    tooltipConfigStore,
    updateInRange,
    logger,
    onDelta = null
  ) {
    this.component = component;
    this.planLabel = planLabel;
    this.updateInRange = updateInRange;
    /** @type {Logger} */
    this.logger = logger;
    this.onDelta = onDelta; // (delta|null) => void — publishes the ±pp label
    this.previousValue = undefined;

    // Track propagated features so breakdown labels are correct.
    this._propagatedFeatures = new Set();
    this.unsubscribes.push(
      propagatedFeaturesStore.subscribe(v => { this._propagatedFeatures = v; })
    );

    // Subscribe to the plan store
    this.unsubscribes.push(
      planStore.subscribe((value) => {
        this.plan = value;
        this.planUpdated();
      })
    );

    // Capture the original per-feature EBM scores computed from the original
    // input sample.  We must call countScore(curExample) rather than copying
    // the live countedScores object because countedScores may already reflect
    // user changes if ScorePanel is re-initialized after plan edits.
    this.originalCountedScores = this.plan
      ? this.plan.ebmLocal.countScore(this.plan.curExample)
      : {};

    // Subscribe to the tooltip store
    this.unsubscribes.push(
      tooltipConfigStore.subscribe((value) => {
        this.tooltipConfig = value;
      })
    );
    this.tooltipConfigStore = tooltipConfigStore;

    // To figure out the svg width, we need to consider the width of the text
    this.width = scoreWidth - planLabel.textWidth - 1;

    // Initialize scales and thresholds
    if (planLabel.isRegression) {
      // TODO
    } else {
      // If it is a classifier, then the bar range is from 0 to 1
      this.xScale = d3
        .scaleLinear()
        .domain([0, 1])
        .range([0, this.width - this.padding.right - this.padding.left]);

      this.minThreshold = 0.5;
      this.maxThreshold = 0.5;
      this.originalValue = sigmoid(this.plan.originalScore);
      this.curValue = sigmoid(this.plan.ebmLocal.predScore);
    }
  }

  /**
   * Update the graph based on the new score
   */
  planUpdated() {
    this.curValue = sigmoid(this.plan.ebmLocal.predScore);

    if (this.svgInitialized) {
      const widthTransition = d3
        .transition('width')
        .duration(this.planLabel.isRegression ? 0 : 200)
        .ease(d3.easeLinear);

      this.svg
        .select('.top-rect')
        .classed('in-range', this.isInRange)
        .transition(widthTransition)
        .attr('width', this.xScale(this.curValue));

      // Update delta highlight rect (blue when score increased, red when it
      // decreased) spanning original→current.
      const deltaClass = this.curValue > this.originalValue
        ? 'delta-up'
        : this.curValue < this.originalValue
          ? 'delta-down'
          : 'delta-hidden';
      this.svg
        .select('.delta-rect')
        .attr('class', `delta-rect ${deltaClass}`)
        .transition(widthTransition)
        .attr('x', this.xScale(Math.min(this.curValue, this.originalValue)))
        .attr('width', Math.abs(this.xScale(this.curValue) - this.xScale(this.originalValue)));

      // Update current value indicator
      this.svg
        .select('.current-value')
        .attr('class', `current-value${this.curValue === this.originalValue ? ' current-hidden' : ''}`)
        .transition(widthTransition)
        .attr('x', this.xScale(this.curValue) - (this.lineWidth + 1) / 2);

      // Update isInRange from the score panel svelte
      this.updateInRange(this.isInRange);
    }

    // If the breakdown popup is pinned, refresh its data live so it stays
    // in sync with whatever slider the user just moved.
    breakdownPopupStore.update(v => {
      if (!v.pinned) return v;
      const data = this.computeBreakdown(this._propagatedFeatures);
      return { ...v, data };
    });

    // ── Settled score change → ±pp label above the bar ───────────────────────
    // The score fires many times during a drag/propagation, so we debounce and
    // act once it settles. `previousValue` only DETECTS that a user change
    // occurred (so nothing shows at load); the published delta is always
    // measured from the ORIGINAL score.
    if (this.previousValue === undefined) {
      this.previousValue = this.curValue; // baseline (first score seen)
    }
    clearTimeout(this._deltaLogTimer);
    this._deltaLogTimer = setTimeout(() => {
      const prev = this.previousValue;
      const cur = this.curValue;
      const settledStep = Math.round(cur * 100) - Math.round(prev * 100);
      this.previousValue = cur;
      if (settledStep === 0) return; // no real change settled — keep current label

      const deltaPP = Math.round(cur * 100) - Math.round(this.originalValue * 100);
      console.log(
        `[DELTA] Plan ${this.planLabel?.planIndex}: original ` +
        `${Math.round(this.originalValue * 100)}% → ${Math.round(cur * 100)}%  =  ` +
        `${deltaPP > 0 ? '+' : ''}${deltaPP}pp`
      );

      if (!this.onDelta) return;
      if (deltaPP === 0) { this.onDelta(null); return; } // back at the original
      const thrPP = Math.round(this.maxThreshold * 100); // 50 for the classifier
      this.onDelta({
        deltaPP,
        direction: deltaPP > 0 ? 'up' : 'down',
        distancePP: Math.max(0, thrPP - Math.round(cur * 100)),
        thresholdMet: cur >= this.maxThreshold,
        ...(this.getDeltaLabelPos() || { screenX: 0, screenY: 0 })
      });
    }, 600);
  }

  /**
   * Viewport position for the ±pp label: centered over the original→current
   * segment, just ABOVE the bar (the label is bottom-anchored via CSS
   * translate(-50%,-100%)), inside the band's upper strip — clear of the
   * toolbar buttons. Computed from the SVG's LIVE screen rect (so callers can
   * re-invoke it on window resize / scroll / tab changes). Returns null when
   * the bar is not laid out (e.g. hidden tab).
   */
  getDeltaLabelPos() {
    if (!this.svgInitialized) return null;
    const svgNode = this.svg.node();
    if (!svgNode) return null;
    const sr = svgNode.getBoundingClientRect();
    if (sr.width < 5 || sr.height < 5) return null; // collapsed / hidden tab
    const midVB =
      this.padding.left +
      (this.xScale(this.originalValue) + this.xScale(this.curValue)) / 2;
    const frac = Math.max(0.06, Math.min(0.94, midVB / this.width));
    // The label's bottom edge lands just above the TOPS of the vertical lines
    // (the lines start at the content area's top, padding.top), not merely
    // above the bar — so the ±pp text never overlaps the score/threshold lines.
    const yFrac = (this.padding.top - 2) / this.height;
    return {
      screenX: sr.left + frac * sr.width,
      screenY: sr.top + yFrac * sr.height
    };
  }

  /**
   * Open the score-change breakdown popup anchored under `rect` — the same
   * popup the bar's delta segment triggers. `pinned` mirrors the segment's
   * click-to-pin behavior. Used by the ±pp chip.
   * @param {DOMRect} rect
   * @param {boolean} [pinned]
   */
  showBreakdownForRect(rect, pinned = false) {
    clearTimeout(this._hidePopupTimer);
    const data = this.computeBreakdown(this._propagatedFeatures);
    if (!data) return;
    const next = { show: true, x: rect.left, y: rect.bottom + 6, data, pinned };
    if (pinned) breakdownPopupStore.set(next);
    else breakdownPopupStore.update((v) => (v.pinned ? v : next));
  }

  /** Schedule the popup to auto-hide (unless pinned) — same delay as the bar. */
  hideBreakdownSoon() {
    this._hidePopupTimer = setTimeout(() => {
      breakdownPopupStore.update((v) => (v.pinned ? v : { ...v, show: false }));
    }, 150);
  }

  destroy() {
    if (this.svg !== null) {
      this.svg.selectAll('*').remove();
    }
    // Hide popup when this panel is destroyed / re-initialized
    clearTimeout(this._hidePopupTimer);
    breakdownPopupStore.set({ show: false, x: 0, y: 0, data: null, pinned: false });
    this.unsubscribes.forEach((d) => d());
  }

  /** @type {boolean} */
  get isInRange() {
    // Binary classification
    if (this.minThreshold === this.maxThreshold) {
      return this.curValue >= this.minThreshold;
    } else {
      // Regression
      return (
        this.curValue >= this.minThreshold && this.curValue <= this.maxThreshold
      );
    }
  }

  /**
   * Handler for mouse enter event
   * @param {MouseEvent} e
   * @param {string} message
   * @param {number} width
   * @param {number} yOffset
   * @param {string} direction
   */
  mouseenterHandler(e, message, width, yOffset, direction) {
    e.preventDefault();
    e.stopPropagation();

    // Log the interaction
    const eventName = 'annotation shown';
    let elementName = 'score annotation original';

    if (message.includes('current')) {
      elementName = 'score annotation current';
    }

    if (message.includes('needed')) {
      elementName = 'score annotation threshold';
    }

    this.logger?.addLog({
      eventName,
      elementName
    });

    const node = e.currentTarget;
    this.mouseoverTimeout = setTimeout(() => {
      const position = node.getBoundingClientRect();
      const curWidth = position.width;
      const tooltipCenterX = position.x + curWidth / 2;
      const tooltipCenterY = position.y - yOffset;
      this.tooltipConfig.html = `
        <div class='tooltip-content' style='display: flex; flex-direction:
          column; justify-content: center;'>
          ${message}
        </div>
      `;
      this.tooltipConfig.width = width;
      this.tooltipConfig.maxWidth = width;
      this.tooltipConfig.left = tooltipCenterX - this.tooltipConfig.width / 2;
      this.tooltipConfig.top = tooltipCenterY;
      this.tooltipConfig.fontSize = '0.8rem';
      this.tooltipConfig.show = true;
      this.tooltipConfig.orientation = direction;
      this.tooltipConfigStore.set(this.tooltipConfig);
    }, 200);
  }

  mouseleaveHandler() {
    clearTimeout(this.mouseoverTimeout);
    this.mouseoverTimeout = null;
    this.tooltipConfig.show = false;
    this.tooltipConfigStore.set(this.tooltipConfig);
  }

  /**
   * Format a raw feature value for display in the breakdown popup.
   * Handles log10 transforms and categorical label encoding.
   * @param {number} val      Raw value (may be in log space)
   * @param {object} feature  Feature object from plan.features
   * @returns {string}
   */
  formatVal(val, feature) {
    // Categorical feature — map level ID to label
    if (!feature.isCont && feature.labelEncoder) {
      return feature.labelEncoder[Math.round(val)] ?? String(val);
    }
    // Continuous — apply inverse transform if needed.
    // feature.transform is set from config.usesTransform in Coach.js.
    const transform = feature.transform;
    const displayVal = transform === 'log10'
      ? Math.pow(10, val)
      : val;
    if (typeof displayVal !== 'number') return String(displayVal);
    if (feature.requiresInt || Math.abs(displayVal) >= 1000) {
      return Math.round(displayVal).toLocaleString();
    }
    return d3.format(',.2~f')(displayVal);
  }

  /**
   * Compute the per-feature score-change breakdown for the popup.
   * @param {Set<string>} [propagatedFeatures]  Names of features changed via propagation
   * @returns {object|null}  Breakdown data, or null if no changes
   */
  computeBreakdown(propagatedFeatures = new Set()) {
    if (!this.plan) return null;

    const currentScores = this.plan.ebmLocal.countedScores;
    const features = this.plan.features;
    const changed = [];

    features.forEach(f => {
      const name = f.data.name;
      const origScore = this.originalCountedScores[name] ?? 0;
      const curScore  = currentScores[name] ?? 0;
      const delta     = curScore - origScore;

      if (Math.abs(delta) > 1e-6) {
        // Original display value
        const origValStr = this.formatVal(f.originalValue, f);

        // Current display value — read from ebmLocal.sample (updated by
        // updateFeature) so propagated changes are reflected correctly.
        const curRaw    = (this.plan.ebmLocal.sample && f.featureID !== undefined)
          ? this.plan.ebmLocal.sample[f.featureID]
          : (f.myValue ?? f.originalValue);
        const curValStr = this.formatVal(curRaw, f);

        // Human-readable display name
        const displayName = f.data.description?.displayName
          || f.data.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        changed.push({
          name,
          displayName,
          delta,
          direction: delta > 0 ? 'up' : 'down',
          origValStr,
          curValStr,
          isPropagated: propagatedFeatures.has(name),
          proportion: 0  // filled in below
        });
      }
    });

    if (changed.length === 0) return null;

    const maxAbsDelta       = Math.max(...changed.map(d => Math.abs(d.delta)));
    const totalAbsDelta     = changed.reduce((s, d) => s + Math.abs(d.delta), 0);
    const totalLogOddsDelta = changed.reduce((s, d) => s + d.delta, 0); // net (signed)
    const totalPPChange     = (this.curValue - this.originalValue) * 100;

    changed.forEach(d => {
      // Bar width: signed fraction of largest contributor (fills ±1 half)
      d.proportion = maxAbsDelta > 0 ? d.delta / maxAbsDelta : 0;

      // Actual pp contribution: each feature's share of the net log-odds shift,
      // scaled to the total pp change.  Values add up to totalPPChange exactly.
      d.actualPP = totalLogOddsDelta !== 0
        ? parseFloat((d.delta / totalLogOddsDelta * totalPPChange).toFixed(1))
        : 0;

      // Percentage share of total absolute log-odds movement (with sign).
      d.pctOfTotal = totalAbsDelta > 0
        ? Math.round(d.delta / totalAbsDelta * 100)
        : 0;
    });
    changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    // Header delta = the sum of the per-row contributions (each already rounded
    // to 1 decimal), so the breakdown rows + rollup reconcile EXACTLY with the
    // header total change (the "rows must sum" discipline). Kept at 1-decimal so
    // a tiny net (e.g. −0.2 from near-cancelling contributions) isn't rounded to
    // 0 and rendered inconsistent with the rows.
    const netActualPP = changed.reduce((s, d) => s + d.actualPP, 0);
    const rawDelta = Math.round(netActualPP * 10) / 10;
    return {
      origPct:   Math.round(this.originalValue * 100),
      curPct:    Math.round(this.curValue * 100),
      deltaSign: rawDelta > 0 ? '+' : '',
      deltaPP:   rawDelta,
      features:  changed
    };
  }

  initSVG = () => {
    // Set the SVG height to fit its container
    this.svg = d3
      .select(this.component)
      .select('.score-svg')
      .attr('height', this.height)
      .attr('width', this.width)
      .attr('viewBox', `0 0 ${this.width} ${this.height}`)
      .attr('preserveAspectRatio', 'none');

    const content = this.svg
      .append('g')
      .attr('class', 'content')
      .attr(
        'transform',
        `translate(${this.padding.left},
        ${this.padding.top})`
      );

    const contentWidth = this.width - this.padding.right - this.padding.left;
    const contentHeight = this.height - this.padding.top - this.padding.bottom;

    const botLayer = content.append('g').attr('class', 'bot-layer');
    const midLayer = content.append('g').attr('class', 'mid-layer');
    const topLayer = content.append('g').attr('class', 'top-layer');

    // Draw the bottom score bar
    const botRect = botLayer
      .append('rect')
      .attr('class', 'back-rect')
      .attr('y', contentHeight - this.rectHeight)
      .attr('width', contentWidth)
      .attr('height', this.rectHeight)
      .attr('rx', this.rectRadius)
      .attr('ry', this.rectRadius);

    // Draw the top score bar
    // Prepare for a clip path
    const clip = content
      .append('clipPath')
      .attr('id', `score-bar-clip-${this.planLabel.planIndex}`);

    clip.node().appendChild(botRect.clone().classed('back-rect', false).node());

    // Draw the top rect
    midLayer
      .append('rect')
      .attr('class', 'top-rect')
      .attr('y', contentHeight - this.rectHeight)
      .attr('width', this.xScale(this.curValue))
      .attr('height', this.rectHeight)
      .attr('clip-path', `url(#score-bar-clip-${this.planLabel.planIndex})`)
      .classed('in-range', this.isInRange)
      .on('mouseenter', (e) =>
        this.mouseenterHandler(
          e,
          `Your current score ${formatter(this.curValue)}`,
          125,
          -10,
          'n'
        )
      )
      .on('mouseleave', () => this.mouseleaveHandler());

    // Draw the delta highlight between original score and current score.
    // Delta highlight between original and current score (blue up / red down),
    // and the hover trigger for the score-change breakdown popup.
    const deltaClass = this.curValue > this.originalValue
      ? 'delta-up'
      : this.curValue < this.originalValue
        ? 'delta-down'
        : 'delta-hidden';
    midLayer
      .append('rect')
      .attr('class', `delta-rect ${deltaClass}`)
      .attr('y', contentHeight - this.rectHeight)
      .attr('x', this.xScale(Math.min(this.curValue, this.originalValue)))
      .attr('width', Math.abs(this.xScale(this.curValue) - this.xScale(this.originalValue)))
      .attr('height', this.rectHeight)
      .attr('clip-path', `url(#score-bar-clip-${this.planLabel.planIndex})`)
      .attr('cursor', 'pointer')
      .on('mouseenter', (e) => {
        clearTimeout(this._hidePopupTimer);
        const rect = e.currentTarget.getBoundingClientRect();
        const data = this.computeBreakdown(this._propagatedFeatures);
        breakdownPopupStore.update(v =>
          v.pinned ? v : { show: true, x: rect.left, y: rect.bottom + 6, data, pinned: false }
        );
      })
      .on('click', (e) => {
        // Click pins the popup — it stays open until the X button is clicked.
        clearTimeout(this._hidePopupTimer);
        const rect = e.currentTarget.getBoundingClientRect();
        const data = this.computeBreakdown(this._propagatedFeatures);
        breakdownPopupStore.set({ show: true, x: rect.left, y: rect.bottom + 6, data, pinned: true });
      })
      .on('mouseleave', () => {
        // Only auto-hide when not pinned; delay lets pointer reach the popup.
        this._hidePopupTimer = setTimeout(() => {
          breakdownPopupStore.update(v =>
            v.pinned ? v : { ...v, show: false }
          );
        }, 150);
      });

    // Draw the bottom lines
    topLayer
      .append('rect')
      .attr('class', 'original-value')
      .attr('x', this.xScale(this.originalValue) - this.lineWidth / 2)
      .attr('width', this.lineWidth)
      .attr('y', 5)
      .attr('height', contentHeight - 5)
      .on('mouseenter', (e) =>
        this.mouseenterHandler(
          e,
          `Your original score ${formatter(this.originalValue)}`,
          130,
          15,
          's'
        )
      )
      .on('mouseleave', () => this.mouseleaveHandler());

    topLayer
      .append('rect')
      .attr('class', 'max-threshold')
      .attr('x', this.xScale(this.maxThreshold) - this.lineWidth / 2)
      .attr('width', this.lineWidth)
      .attr('height', contentHeight)
      .on('mouseenter', (e) =>
        this.mouseenterHandler(
          e,
          `Score needed to obtain your desired decision <br> <= ${formatter(
            this.maxThreshold
          )}`,
          170,
          0,
          's'
        )
      )
      .on('mouseleave', () => this.mouseleaveHandler());

    topLayer
      .append('rect')
      .attr('class', 'min-threshold')
      .attr('x', this.xScale(this.minThreshold) - this.lineWidth / 2)
      .attr('width', this.lineWidth)
      .attr('height', contentHeight)
      .on('mouseenter', (e) =>
        this.mouseenterHandler(
          e,
          `Score needed to obtain your desired decision <br> >= ${formatter(
            this.minThreshold
          )}`,
          170,
          20,
          's'
        )
      )
      .on('mouseleave', () => this.mouseleaveHandler());

    // Current score indicator — darker and slightly thicker than the original
    // value indicator so it is visually distinct and clearly "the live position".
    // Only rendered when curValue differs from originalValue.
    topLayer
      .append('rect')
      .attr('class', `current-value${this.curValue === this.originalValue ? ' current-hidden' : ''}`)
      .attr('x', this.xScale(this.curValue) - (this.lineWidth + 1) / 2)
      .attr('width', this.lineWidth + 1)
      .attr('y', 5)
      .attr('height', contentHeight - 5)
      .on('mouseenter', (e) =>
        this.mouseenterHandler(
          e,
          `Current score: ${formatter(this.curValue)}`,
          140,
          15,
          's'
        )
      )
      .on('mouseleave', () => this.mouseleaveHandler());

    this.svgInitialized = true;
  };
}
