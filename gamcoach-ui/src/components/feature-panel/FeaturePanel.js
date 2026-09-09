import { Constraints } from '../coach/Coach';

/**
 * Each row in the feature masonry grid
 */
class FeatureBox {
  /** @type {Feature[]} Features to put in the left column */
  left;
  /** @type {Feature[]} Features to put in the middle column */
  mid;
  /** @type {Feature[]} Features to put in the right column */
  right;

  constructor() {
    this.left = [];
    this.mid = [];
    this.right = [];
  }
}

/**
 * The masonry grid of features
 */
export class FeatureGrid {
  /** @type {FeatureBox} Features that are changed */
  changed;
  /** @type {FeatureBox} Features that are configured */
  configured;
  /** @type {FeatureBox} Other features */
  other;

  /**
   * Initialize the feature grid with empty arrays
   */
  constructor() {
    // Initialize three row blocks
    this.changed = new FeatureBox();
    this.configured = new FeatureBox();
    this.other = new FeatureBox();
  }

  /**
   * Initialize the features to put into the grid.
   * @param {Feature[]} features The initial feature data initialized by the
   *  Plan object
   * @param {Constraints} constraints The global constraints object that
   *  contains the up-to-date constraint info about all the features
   */
  loadFeatures = (features, constraints) => {
    // First update the constraint information for all features
    for (let i = 0; i < features.length; i++) {
      const name = features[i].data.name;

      // Update the difficulty configuration
      if (constraints.difficulties.has(name)) {
        features[i].difficulty = constraints.difficulties.get(name);
      } else {
        features[i].difficulty = 'neutral';
      }

      // Update the acceptable range configuration
      if (constraints.acceptableRanges.has(name)) {
        features[i].acceptableRange = constraints.acceptableRanges.get(name);

        // If this feature is a categorical feature, we also need to encode the
        // acceptable range from edge names to edge ids
        if (features[i].data.type === 'categorical') {
          const labelDecoder = new Map();
          Object.entries(features[i].labelEncoder).forEach(
            ([level, levelName]) => {
              labelDecoder.set(levelName, parseInt(level));
            }
          );

          features[i].acceptableRange = features[i].acceptableRange.map((id) =>
            labelDecoder.get(id)
          );
        }
      } else {
        features[i].acceptableRange = null;
      }

      if (features[i].acceptableRange === null &&
        features[i].difficulty === 'neutral'
      ) {
        features[i].isConstrained = false;
      } else {
        features[i].isConstrained = true;
      }
    }

    // Fixed, type-based grouping. A feature's group is determined by its type
    // and never changes (this replaces the old dynamic placement based on
    // isChanged / isConstrained). The three FeatureBox members are repurposed:
    //   changed    -> Actionable Features
    //   configured -> Computed Features
    //   other      -> Profile Features
    // The member names are kept so the render sites in FeaturePanel.svelte don't
    // have to change; only the section header labels do.
    const GROUP_BY_NAME = {
      // Actionable Features
      loan_amnt: 'changed',
      term: 'changed',
      purpose: 'changed',
      application_type: 'changed',
      revol_bal: 'changed',
      annual_inc: 'changed',
      // Computed Features
      dti: 'configured',
      revol_util: 'configured',
      total_acc: 'configured',
      fico_score: 'configured',
      // Profile Features
      emp_length: 'other',
      home_ownership: 'other',
      verification_status: 'other',
      earliest_cr_line: 'other',
      inq_last_6mths: 'other',
      open_acc: 'other',
      mort_acc: 'other',
      pub_rec: 'other',
      pub_rec_bankruptcies: 'other',
      delinq_2yrs: 'other'
    };

    // Explicit display order for the Actionable Features (the `changed` group).
    // The panel stacks the three columns into ONE vertical list, so to guarantee this
    // exact top-to-bottom sequence the actionable cards all go into the left column in
    // this order (mid/right stay empty). Any actionable feature not listed here
    // (defensive) falls to the end in its importance order.
    const ACTIONABLE_ORDER = [
      'loan_amnt',        // Loan Amount ($)
      'purpose',          // Loan Purpose
      'term',             // Payment Period
      'application_type', // Application Type
      'annual_inc',       // Annual Income ($)
      'revol_bal'         // Unpaid Credit Card Balance ($)
    ];

    const nextKey = {
      changed: 0,
      configured: 0,
      other: 0
    };

    const keys = ['left', 'mid', 'right'];

    // Computed & Profile groups: fill the three columns round-robin in the features'
    // current (importance-ranked) order (Actionable is placed separately, below).
    features.forEach((f) => {
      const box = GROUP_BY_NAME[f.data.name] || 'other';
      if (box === 'changed') return;
      this[box][keys[nextKey[box]]].push(f);
      nextKey[box] = (nextKey[box] + 1) % 3;
    });

    // Actionable Features: one column, in the explicit ACTIONABLE_ORDER sequence.
    const orderIndex = (name) => {
      const i = ACTIONABLE_ORDER.indexOf(name);
      return i === -1 ? ACTIONABLE_ORDER.length : i;
    };
    features
      .filter((f) => GROUP_BY_NAME[f.data.name] === 'changed')
      .sort((a, b) => orderIndex(a.data.name) - orderIndex(b.data.name))
      .forEach((f) => this.changed.left.push(f));
  };
}

