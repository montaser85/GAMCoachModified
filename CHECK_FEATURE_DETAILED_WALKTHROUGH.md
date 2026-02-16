# Detailed Step-by-Step Walkthrough of the Check Feature

This document provides an **exhaustive, line-by-line** explanation of how the Check feature works in GAM Coach.

---

## **Table of Contents**

1. [Step 1: User Clicks the Check Button](#step-1-user-clicks-the-check-button)
2. [Step 2: Modal Store Update](#step-2-modal-store-update)
3. [Step 3: CheckModal Receives Data](#step-3-checkmodal-receives-data)
4. [Step 4: Initialize Feature Values](#step-4-initialize-feature-values)
5. [Step 5: Render the Form](#step-5-render-the-form)
6. [Step 6: User Modifies Values](#step-6-user-modifies-values)
7. [Step 7: User Clicks Check in Modal](#step-7-user-clicks-check-in-modal)
8. [Step 8: Build Sample Array](#step-8-build-sample-array)
9. [Step 9: EBM Prediction - predict()](#step-9-ebm-prediction---predict)
10. [Step 10: EBM Prediction - predictProb()](#step-10-ebm-prediction---predictprob)
11. [Step 11: Count Scores - Main Effects](#step-11-count-scores---main-effects)
12. [Step 12: Count Scores - Interaction Effects](#step-12-count-scores---interaction-effects)
13. [Step 13: Calculate Final Probability](#step-13-calculate-final-probability)
14. [Step 14: Display Results](#step-14-display-results)

---

## **Step 1: User Clicks the Check Button**

### **Where:** `gamcoach-ui/src/components/coach-panel/CoachPanel.svelte`

### **User Action:**
User clicks the "Check" button (🔲 icon) in the top-right corner of the GAM Coach interface.

### **HTML Element:**
```svelte
<div
  class="button-wrapper"
  on:click={checkClicked}
  on:keydown={e => e.key === 'Enter' && checkClicked()}
>
  <div class="icon-check-box"></div>
  <div class="text">Check</div>
</div>
```

**Breakdown:**
- `on:click={checkClicked}` - Attaches click event handler
- `on:keydown` - Allows keyboard activation (accessibility)
- When clicked, calls `checkClicked()` function

### **What Happens:**
The browser fires a click event → Svelte's event system calls `checkClicked()`

---

## **Step 2: Modal Store Update**

### **Where:** `gamcoach-ui/src/components/coach-panel/CoachPanel.svelte`, lines 428-441

### **Code:**
```javascript
const checkClicked = () => {
  // Update the Svelte store to open the modal
  checkModalConfigStore.update(value => {
    value.show = true;          // (1) Set modal visibility to true
    value.ebm = ebm;             // (2) Pass the EBM model instance
    value.modelData = modelData; // (3) Pass the model metadata
    return value;                // (4) Return updated store value
  });

  // Log the interaction for analytics
  logger?.addLog({
    eventName: 'check modal opened',
    elementName: 'check'
  });
};
```

### **Line-by-Line Breakdown:**

#### **Line 1: `checkModalConfigStore.update(value => {`**
- `checkModalConfigStore` is a Svelte **writable store** (from `store.js`)
- `.update()` is a Svelte store method that takes a callback function
- `value` is the current state of the store
- The callback receives current state, modifies it, and returns new state

**Current store state before update:**
```javascript
{
  show: false,
  ebm: null,
  modelData: null
}
```

#### **Line 2: `value.show = true;`**
- Sets the `show` property to `true`
- This will trigger the modal to become visible
- Any component subscribed to this store will re-render

#### **Line 3: `value.ebm = ebm;`**
- `ebm` is the EBM model instance created in `CoachPanel.svelte`
- This is an instance of the `EBM` class from `gamcoach.js`
- Contains all the methods needed for prediction: `predict()`, `predictProb()`, `countScore()`

**What `ebm` contains:**
```javascript
ebm = {
  featureNames: ['loan_amnt', 'term', 'emp_length', ...],
  featureTypes: ['continuous', 'categorical', 'categorical', ...],
  binEdges: [[0, 1000, 2000, ...], [1, 2], [1, 2, 3], ...],
  scores: [[0.7147, 0.7025, ...], [0.2201, -0.1337], ...],
  intercept: 0.002579,
  interactionIndexes: [[0, 13], [2, 17], ...],
  interactionScores: [[[...]], [[...]], ...],
  isClassifier: true,
  labelEncoder: {...},
  labelDecoder: {...}
}
```

#### **Line 4: `value.modelData = modelData;`**
- `modelData` is the JSON object loaded from `lc-classifier.json`
- Contains all feature metadata, binning information, scores, and configurations

**What `modelData` contains:**
```javascript
modelData = {
  intercept: 0.002579,
  isClassifier: true,
  modelInfo: { classes: ['loan rejection', 'loan approval'] },
  features: [
    {
      name: 'loan_amnt',
      type: 'continuous',
      importance: 0.1894,
      additive: [0.714723, 0.702525, ...],
      binEdge: [0, 1000, 2000, 3000, ...],
      config: { difficulty: 3, requiresInt: false, ... }
    },
    {
      name: 'term',
      type: 'categorical',
      importance: 0.0823,
      additive: [0.2201, -0.1337],
      binLabel: [1, 2],
      description: {
        displayName: 'Payment Period',
        levelDescription: {
          '1': { displayName: '36 months' },
          '2': { displayName: '60 months' }
        }
      }
    },
    // ... 17 more features
    {
      name: 'loan_amnt x revol_bal',
      type: 'interaction',
      // ... interaction data
    }
  ],
  featureNames: ['loan_amnt', 'term', 'emp_length', ...],
  featureTypes: ['continuous', 'categorical', 'categorical', ...],
  labelEncoder: {
    term: { '36 months': '1', '60 months': '2' },
    emp_length: { '< 1 year': '1', '10+ years': '2', ... }
  },
  contMads: { loan_amnt: 6000, annual_inc: 0.2134, ... },
  catDistances: { term: {'36 months': 0.45, '60 months': 0.55}, ... }
}
```

#### **Line 5: `return value;`**
- Returns the modified store value
- Triggers all subscribers to receive the updated state

**Store state after update:**
```javascript
{
  show: true,
  ebm: <EBM instance>,
  modelData: <Model JSON object>
}
```

#### **Lines 7-10: Logger**
```javascript
logger?.addLog({
  eventName: 'check modal opened',
  elementName: 'check'
});
```
- `?.` is optional chaining (only calls if logger exists)
- Logs user interaction for research/analytics purposes
- Not critical to functionality

---

## **Step 3: CheckModal Receives Data**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, lines 14-25

### **Code:**
```javascript
let component = null;
let show = false;
let ebm = null;
let modelData = null;
let featureValues = {};
let predictionResult = null;
let showResult = false;

const unsubscribe = checkModalConfigStore.subscribe(value => {
  show = value.show;           // (1) Update local show variable
  ebm = value.ebm;             // (2) Receive EBM instance
  modelData = value.modelData; // (3) Receive model data

  // Initialize feature values when modal opens
  if (show && ebm && modelData) {  // (4) Check all required data exists
    initializeFeatureValues();     // (5) Call initialization
    showResult = false;             // (6) Hide previous results
    predictionResult = null;        // (7) Clear previous prediction
  }
});
```

### **Line-by-Line Breakdown:**

#### **Lines 1-7: Variable Declarations**
```javascript
let component = null;         // Reference to modal DOM element
let show = false;            // Controls modal visibility
let ebm = null;              // Will hold EBM instance
let modelData = null;        // Will hold model metadata
let featureValues = {};      // Stores user input for each feature
let predictionResult = null; // Stores prediction output
let showResult = false;      // Controls result panel visibility
```

**Purpose of each variable:**
- **`component`**: Used for DOM manipulation if needed
- **`show`**: Reactively controls whether modal is displayed
- **`ebm`**: The prediction engine
- **`modelData`**: Feature metadata and configuration
- **`featureValues`**: The form data (user inputs)
- **`predictionResult`**: Stores final prediction to display
- **`showResult`**: Whether to show the result panel

#### **Line 9: `checkModalConfigStore.subscribe(value => {`**
- **`.subscribe()`** is a Svelte store method
- Registers a callback that runs whenever the store changes
- `value` is the current store state
- Returns an `unsubscribe` function (to clean up when component unmounts)

**How Svelte subscriptions work:**
```javascript
// When CoachPanel updates the store:
checkModalConfigStore.update(v => { v.show = true; return v; });

// This callback immediately fires:
value => {
  // value = { show: true, ebm: <instance>, modelData: <data> }
  show = value.show;  // show becomes true → modal appears
  ebm = value.ebm;    // ebm receives instance
  // ...
}
```

#### **Lines 10-12: Update Local Variables**
```javascript
show = value.show;
ebm = value.ebm;
modelData = value.modelData;
```

- **Direct assignment** from store to component variables
- These are **reactive** variables in Svelte
- When they change, Svelte automatically re-renders affected parts of the UI

**Before subscription fires:**
```javascript
show = false       → Modal is hidden
ebm = null         → No model available
modelData = null   → No metadata
```

**After subscription fires:**
```javascript
show = true        → Modal becomes visible
ebm = <instance>   → Model ready for predictions
modelData = <data> → Metadata loaded
```

#### **Line 15: `if (show && ebm && modelData) {`**
- **Guard clause** to ensure all required data exists
- Only initializes if:
  - Modal should be shown (`show === true`)
  - EBM instance is available (`ebm !== null`)
  - Model data is loaded (`modelData !== null`)

**Why this check is necessary:**
- First time component loads: all are null
- User closes modal: `show` becomes false
- Store updates partially: might only have `ebm` but not `modelData` yet

#### **Line 16: `initializeFeatureValues();`**
- Calls function to populate the form with default values
- We'll explore this in detail in Step 4

#### **Lines 17-18: Reset Result State**
```javascript
showResult = false;
predictionResult = null;
```

- **Clears previous prediction** if user opens modal again
- Ensures old results don't show when modal reopens
- User must click "Check" again to see new results

---

## **Step 4: Initialize Feature Values**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, lines 30-82

This function pre-fills the form with reasonable default values based on the loan application data you provided.

### **Code:**
```javascript
const initializeFeatureValues = () => {
  featureValues = {};  // (1) Reset to empty object

  if (!ebm || !ebm.featureNames || !modelData) return;  // (2) Safety check

  // (3) Default values for continuous features
  const reasonableDefaults = {
    'loan_amnt': 20000,
    'annual_inc': 61000,
    'dti': 20.47,
    'earliest_cr_line': 16,
    'open_acc': 11,
    'revol_bal': 11000,
    'revol_util': 57.7,
    'total_acc': 21,
    'fico_score': 677
  };

  // (4) Default categorical values (as binLabel IDs)
  const categoricalDefaults = {
    'term': 1,                    // Maps to '36 months'
    'emp_length': 2,              // Maps to '10+ years'
    'home_ownership': 4,          // Maps to 'RENT'
    'verification_status': 2,     // Maps to 'Source Verified'
    'purpose': 3,                 // Maps to 'debt_consolidation'
    'delinq_2yrs': 1,            // Maps to '0'
    'inq_last_6mths': 1,         // Maps to '0'
    'pub_rec': 1,                // Maps to '0'
    'application_type': 1,        // Maps to 'Individual'
    'mort_acc': 1,               // Maps to '0'
    'pub_rec_bankruptcies': 1    // Maps to '0'
  };

  // (5) Loop through all features and populate defaults
  ebm.featureNames.forEach((name, index) => {
    const featureType = ebm.featureTypes[index];

    if (featureType === 'continuous') {
      // (6) Use provided default or 0
      featureValues[name] = reasonableDefaults[name] || 0;
    } else if (featureType === 'categorical') {
      // (7) Use provided categorical default
      if (categoricalDefaults[name] !== undefined) {
        featureValues[name] = categoricalDefaults[name];
      } else {
        // (8) Fallback: use first option
        const feature = modelData.features.find(f => f.name === name);
        if (feature && feature.binLabel && feature.binLabel.length > 0) {
          featureValues[name] = feature.binLabel[0];
        }
      }
    }
  });
};
```

### **Line-by-Line Breakdown:**

#### **Line 1: `featureValues = {};`**
- Initializes empty object to store form values
- Clears any previous values if modal was opened before

#### **Line 3: Guard Clause**
```javascript
if (!ebm || !ebm.featureNames || !modelData) return;
```
- **Safety check** before proceeding
- Returns early if required data is missing
- Prevents errors from accessing undefined properties

#### **Lines 5-16: Continuous Feature Defaults**
```javascript
const reasonableDefaults = {
  'loan_amnt': 20000,
  'annual_inc': 61000,
  // ... etc
};
```

**Important Notes:**
- These are **raw values** (not transformed)
- For `annual_inc`: we store `61000`, NOT `log10(61000)`
- For `revol_bal`: we store `11000`, NOT `log10(11000)`
- Transformation happens later in Step 8

**Why store raw values?**
- User sees and edits raw values in the form
- More intuitive: user enters "61000" for income, not "4.7853"
- Transform only when sending to model

#### **Lines 18-30: Categorical Feature Defaults**
```javascript
const categoricalDefaults = {
  'term': 1,
  'emp_length': 2,
  // ... etc
};
```

**Critical Understanding:**
- We store the **binLabel ID** (integer), not the display string
- `term: 1` → Will display as "36 months" in dropdown
- `emp_length: 2` → Will display as "10+ years" in dropdown

**Why store IDs instead of strings?**
- Dropdown `<option value={ID}>` uses IDs
- Easier to match with `binLabel` array
- Conversion to string happens in Step 8

**Mapping Table Example:**
```javascript
// For 'term' feature:
binLabel: [1, 2]
labelEncoder: { '36 months': '1', '60 months': '2' }
labelDecoder: { '1': '36 months', '2': '60 months' }

// Stored in form:     1
// Displayed to user:  "36 months"
// Sent to model:      "36 months"
```

#### **Line 33: Loop Through Features**
```javascript
ebm.featureNames.forEach((name, index) => {
```

- **`ebm.featureNames`** = `['loan_amnt', 'term', 'emp_length', ...]`
- Loops through each feature in order
- `name` = feature name (string)
- `index` = position in array (number)

**Iteration example:**
```javascript
// Iteration 1:
name = 'loan_amnt'
index = 0
featureType = ebm.featureTypes[0] = 'continuous'

// Iteration 2:
name = 'term'
index = 1
featureType = ebm.featureTypes[1] = 'categorical'

// ... continues for all 19 features
```

#### **Line 34: Get Feature Type**
```javascript
const featureType = ebm.featureTypes[index];
```

- Looks up whether feature is 'continuous' or 'categorical'
- Used to determine how to populate default value

**Example values:**
```javascript
ebm.featureTypes = [
  'continuous',    // loan_amnt
  'categorical',   // term
  'categorical',   // emp_length
  'categorical',   // home_ownership
  'continuous',    // annual_inc
  // ... etc
]
```

#### **Lines 36-38: Handle Continuous Features**
```javascript
if (featureType === 'continuous') {
  featureValues[name] = reasonableDefaults[name] || 0;
}
```

**Breakdown:**
- `reasonableDefaults[name]` - Look up default for this feature
- `|| 0` - If not found in defaults, use 0 as fallback

**Example executions:**

**Iteration 1: `loan_amnt`**
```javascript
name = 'loan_amnt'
featureType = 'continuous'
reasonableDefaults['loan_amnt'] = 20000
featureValues['loan_amnt'] = 20000
```

**Iteration 5: `annual_inc`**
```javascript
name = 'annual_inc'
featureType = 'continuous'
reasonableDefaults['annual_inc'] = 61000
featureValues['annual_inc'] = 61000
```

**Hypothetical feature not in defaults:**
```javascript
name = 'some_feature'
featureType = 'continuous'
reasonableDefaults['some_feature'] = undefined
featureValues['some_feature'] = 0  // Fallback
```

#### **Lines 39-51: Handle Categorical Features**
```javascript
else if (featureType === 'categorical') {
  if (categoricalDefaults[name] !== undefined) {
    featureValues[name] = categoricalDefaults[name];
  } else {
    // Fallback: use first option
    const feature = modelData.features.find(f => f.name === name);
    if (feature && feature.binLabel && feature.binLabel.length > 0) {
      featureValues[name] = feature.binLabel[0];
    }
  }
}
```

**Two paths:**

**Path 1: Feature has defined default**
```javascript
name = 'term'
featureType = 'categorical'
categoricalDefaults['term'] = 1
featureValues['term'] = 1
```

**Path 2: Feature not in defaults (fallback)**
```javascript
name = 'unknown_category'
featureType = 'categorical'
categoricalDefaults['unknown_category'] = undefined

// Find feature metadata:
feature = modelData.features.find(f => f.name === 'unknown_category')
// feature = { binLabel: [1, 2, 3, 4], ... }

// Use first option:
featureValues['unknown_category'] = feature.binLabel[0]  // = 1
```

**Why this fallback is needed:**
- Future-proofs the code for new features
- Ensures every feature has a value (no empty inputs)
- Prevents errors when form renders

### **Final State After Initialization:**

After `initializeFeatureValues()` completes, `featureValues` contains:

```javascript
featureValues = {
  loan_amnt: 20000,              // Continuous (raw value)
  term: 1,                       // Categorical (ID)
  emp_length: 2,                 // Categorical (ID)
  home_ownership: 4,             // Categorical (ID)
  annual_inc: 61000,             // Continuous (raw value, NOT log10)
  verification_status: 2,        // Categorical (ID)
  purpose: 3,                    // Categorical (ID)
  dti: 20.47,                    // Continuous (raw value)
  delinq_2yrs: 1,               // Categorical (ID)
  earliest_cr_line: 16,          // Continuous (raw value)
  inq_last_6mths: 1,            // Categorical (ID)
  open_acc: 11,                  // Continuous (raw value)
  pub_rec: 1,                    // Categorical (ID)
  revol_bal: 11000,              // Continuous (raw value, NOT log10)
  revol_util: 57.7,              // Continuous (raw value)
  total_acc: 21,                 // Continuous (raw value)
  application_type: 1,           // Categorical (ID)
  mort_acc: 1,                   // Categorical (ID)
  pub_rec_bankruptcies: 1,      // Categorical (ID)
  fico_score: 677                // Continuous (raw value)
}
```

**Key Observations:**
- All 19 features have values
- Continuous: actual numbers user will see/edit
- Categorical: IDs that map to display strings
- NO transformations applied yet (annual_inc is 61000, not 4.7853)

---

## **Step 5: Render the Form**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, lines 240-277

This step renders the HTML form with inputs for each feature.

### **Code:**
```svelte
<div class="feature-inputs">
  {#each ebm.featureNames as featureName, index}
    {#if ebm.featureTypes[index] !== 'interaction'}
      <div class="input-group">
        <label
          for={`input-${featureName}`}
          title={getFeatureDescription(featureName)}
        >
          {getFeatureDisplayName(featureName)}
          {#if getFeatureDescription(featureName)}
            <span class="info-icon">ℹ️</span>
          {/if}
        </label>

        {#if ebm.featureTypes[index] === 'continuous'}
          <input
            id={`input-${featureName}`}
            type="number"
            bind:value={featureValues[featureName]}
            placeholder="Enter value"
            step="any"
          />
        {:else if ebm.featureTypes[index] === 'categorical'}
          <select
            id={`input-${featureName}`}
            bind:value={featureValues[featureName]}
          >
            {#each getCategoricalOptions(featureName) as option}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        {/if}
      </div>
    {/if}
  {/each}
</div>
```

### **Line-by-Line Breakdown:**

#### **Line 2: Loop Through Features**
```svelte
{#each ebm.featureNames as featureName, index}
```

**Svelte syntax:**
- `{#each array as item, index}` - Svelte's loop syntax
- Iterates through `ebm.featureNames` array
- `featureName` = current feature name
- `index` = current position (0, 1, 2, ...)

**Iteration example:**
```javascript
// Iteration 0:
featureName = 'loan_amnt'
index = 0

// Iteration 1:
featureName = 'term'
index = 1

// ... continues for all 19 features
```

#### **Line 3: Skip Interaction Features**
```svelte
{#if ebm.featureTypes[index] !== 'interaction'}
```

**Why skip interactions?**
- Interaction features are computed from main features
- User doesn't input interactions directly
- Example: `loan_amnt x revol_bal` is derived from `loan_amnt` and `revol_bal`

**Feature types:**
```javascript
ebm.featureTypes = [
  'continuous',    // loan_amnt ✓ Show input
  'categorical',   // term ✓ Show input
  'interaction',   // loan_amnt x revol_bal ✗ Skip
  // ...
]
```

#### **Lines 4-13: Label Rendering**
```svelte
<label
  for={`input-${featureName}`}
  title={getFeatureDescription(featureName)}
>
  {getFeatureDisplayName(featureName)}
  {#if getFeatureDescription(featureName)}
    <span class="info-icon">ℹ️</span>
  {/if}
</label>
```

**Breakdown:**

**`for` attribute:**
```svelte
for={`input-${featureName}`}
```
- Links label to input element
- Example: `for="input-loan_amnt"`
- Clicking label focuses the input

**`title` attribute:**
```svelte
title={getFeatureDescription(featureName)}
```
- Shows tooltip on hover
- Calls helper function to get description

**Display name:**
```svelte
{getFeatureDisplayName(featureName)}
```
- Shows user-friendly name instead of code name
- Example: `loan_amnt` → "Loan Amount"

**Info icon:**
```svelte
{#if getFeatureDescription(featureName)}
  <span class="info-icon">ℹ️</span>
{/if}
```
- Only shows if description exists
- Visual indicator that more info is available

**Helper function: `getFeatureDisplayName()`**
```javascript
const getFeatureDisplayName = (featureName) => {
  if (!modelData) return featureName;

  const feature = modelData.features.find(f => f.name === featureName);
  return feature?.description?.displayName || featureName;
};
```

**Example executions:**

**For `loan_amnt`:**
```javascript
featureName = 'loan_amnt'
feature = modelData.features.find(f => f.name === 'loan_amnt')
// feature = { description: { displayName: 'Loan Amount' }, ... }
return 'Loan Amount'
```

**For `term`:**
```javascript
featureName = 'term'
feature = modelData.features.find(f => f.name === 'term')
// feature = { description: { displayName: 'Payment Period' }, ... }
return 'Payment Period'
```

#### **Lines 15-22: Continuous Feature Input**
```svelte
{#if ebm.featureTypes[index] === 'continuous'}
  <input
    id={`input-${featureName}`}
    type="number"
    bind:value={featureValues[featureName]}
    placeholder="Enter value"
    step="any"
  />
```

**Key attributes:**

**`id`:**
```svelte
id={`input-${featureName}`}
```
- Example: `id="input-loan_amnt"`
- Matches `for` attribute in label

**`type="number"`:**
- HTML5 number input
- Shows number keyboard on mobile
- Validates numeric input

**`bind:value={featureValues[featureName]}`:**
- **Most important line!**
- **Two-way data binding** in Svelte
- Changes in input → updates `featureValues`
- Changes in `featureValues` → updates input display

**How `bind:value` works:**

**Initial state:**
```javascript
featureValues['loan_amnt'] = 20000
```

**HTML rendered:**
```html
<input type="number" value="20000" />
```

**User types "25000":**
```javascript
// Svelte automatically updates:
featureValues['loan_amnt'] = 25000
```

**Programmatic change:**
```javascript
// If code changes featureValues:
featureValues['loan_amnt'] = 30000

// Input automatically updates:
<input type="number" value="30000" />
```

**`step="any"`:**
- Allows decimal values
- Example: user can enter `20.47` for DTI

**Example rendered HTML for `loan_amnt`:**
```html
<div class="input-group">
  <label for="input-loan_amnt" title="">
    Loan Amount
  </label>
  <input
    id="input-loan_amnt"
    type="number"
    value="20000"
    placeholder="Enter value"
    step="any"
  />
</div>
```

#### **Lines 23-32: Categorical Feature Select**
```svelte
{:else if ebm.featureTypes[index] === 'categorical'}
  <select
    id={`input-${featureName}`}
    bind:value={featureValues[featureName]}
  >
    {#each getCategoricalOptions(featureName) as option}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
```

**Key parts:**

**`<select>` element:**
- Dropdown menu for categorical features
- Also uses `bind:value` for two-way binding

**Loop through options:**
```svelte
{#each getCategoricalOptions(featureName) as option}
  <option value={option.value}>{option.label}</option>
{/each}
```

**Helper function: `getCategoricalOptions()`**
```javascript
const getCategoricalOptions = (featureName) => {
  if (!modelData) return [];

  // (1) Find feature metadata
  const feature = modelData.features.find(f => f.name === featureName);
  if (!feature || !feature.binLabel) return [];

  // (2) Get level descriptions
  const levelDescriptions = feature.description?.levelDescription || {};

  // (3) Map each binLabel to {value, label}
  return feature.binLabel.map(value => ({
    value: value,  // The ID (1, 2, 3, ...)
    label: levelDescriptions[value]?.displayName || `Option ${value}`
  }));
};
```

**Example execution for `term` feature:**

**Step 1: Find feature**
```javascript
featureName = 'term'
feature = modelData.features.find(f => f.name === 'term')
// Returns:
{
  name: 'term',
  binLabel: [1, 2],
  description: {
    displayName: 'Payment Period',
    levelDescription: {
      '1': { displayName: '36 months' },
      '2': { displayName: '60 months' }
    }
  }
}
```

**Step 2: Get descriptions**
```javascript
levelDescriptions = {
  '1': { displayName: '36 months' },
  '2': { displayName: '60 months' }
}
```

**Step 3: Map binLabels**
```javascript
feature.binLabel = [1, 2]

// Map iteration 1:
value = 1
label = levelDescriptions['1']?.displayName = '36 months'
return { value: 1, label: '36 months' }

// Map iteration 2:
value = 2
label = levelDescriptions['2']?.displayName = '60 months'
return { value: 2, label: '60 months' }

// Final result:
[
  { value: 1, label: '36 months' },
  { value: 2, label: '60 months' }
]
```

**Rendered HTML for `term`:**
```html
<div class="input-group">
  <label for="input-term" title="">
    Payment Period
  </label>
  <select id="input-term">
    <option value="1">36 months</option>
    <option value="2">60 months</option>
  </select>
</div>
```

**When user selects "60 months":**
```javascript
// HTML shows: "60 months"
// But featureValues stores the ID:
featureValues['term'] = 2
```

### **Complete Rendered Form Example:**

After Step 5 completes, the user sees a form like this:

```
┌──────────────────────────────────────┐
│  Loan Amount                         │
│  [20000__________________________]   │
├──────────────────────────────────────┤
│  Payment Period                      │
│  [36 months            ▼]           │
├──────────────────────────────────────┤
│  Employment Length                   │
│  [10+ years            ▼]           │
├──────────────────────────────────────┤
│  Home Ownership                      │
│  [RENT                 ▼]           │
├──────────────────────────────────────┤
│  Annual Income                       │
│  [61000__________________________]   │
├──────────────────────────────────────┤
│  ... (14 more fields)                │
└──────────────────────────────────────┘
```

---

## **Step 6: User Modifies Values**

### **What Happens:**
User interacts with the form, changing values as needed.

### **Example Interactions:**

#### **Continuous Feature Change:**

**User changes Loan Amount from 20000 to 25000:**

**Before:**
```javascript
featureValues['loan_amnt'] = 20000
```

**User types in input:**
```
Input: 20000 → 2000 → 200 → 20 → 2 → 25 → 250 → 2500 → 25000
```

**After:**
```javascript
featureValues['loan_amnt'] = 25000
```

**Svelte's `bind:value` automatically updates** `featureValues` as user types.

#### **Categorical Feature Change:**

**User changes Term from "36 months" to "60 months":**

**Before:**
```javascript
featureValues['term'] = 1  // Currently "36 months"
```

**User clicks dropdown:**
```html
<select>
  <option value="1">36 months</option>  <!-- Currently selected -->
  <option value="2">60 months</option>
</select>
```

**User selects "60 months":**
```javascript
featureValues['term'] = 2  // Now "60 months"
```

**Display shows:** "60 months"
**Stored value is:** `2`

### **Real-Time Reactivity:**

**Svelte's reactive system:**
```javascript
// Original value
featureValues['annual_inc'] = 61000

// User changes to 75000
featureValues['annual_inc'] = 75000

// Svelte automatically:
// 1. Updates the bound variable
// 2. Re-renders any dependent UI
// 3. No manual event listeners needed!
```

**No explicit event handlers needed:**
```javascript
// Traditional JavaScript requires:
input.addEventListener('change', (e) => {
  featureValues['annual_inc'] = e.target.value;
});

// Svelte handles this automatically with:
bind:value={featureValues['annual_inc']}
```

---

## **Step 7: User Clicks Check in Modal**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, line 304

### **HTML:**
```svelte
<div class="modal-footer">
  <button class="btn-cancel" on:click={closeModal}>Close</button>
  <button class="btn-check" on:click={handleCheck}>Check</button>
</div>
```

**When user clicks "Check" button:**
- Browser fires click event
- Svelte calls `handleCheck()` function
- This is where the **prediction process** begins

### **Current State Before Click:**

```javascript
featureValues = {
  loan_amnt: 20000,        // Or whatever user entered
  term: 1,                 // Or user's selection
  annual_inc: 61000,       // Raw value (not transformed yet)
  revol_bal: 11000,        // Raw value (not transformed yet)
  // ... all 19 features
}
```

---

## **Step 8: Build Sample Array**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, lines 125-154

This is the **MOST CRITICAL** step where form data is transformed into the format the EBM model expects.

### **Full Code:**
```javascript
const handleCheck = () => {
  if (!ebm || !modelData) return;  // (1) Safety check

  // (2) Build sample array in the correct order
  const sample = ebm.featureNames.map((name, index) => {
    const value = featureValues[name];  // (3) Get form value

    if (ebm.featureTypes[index] === 'categorical') {  // (4) Check type
      // (5) CATEGORICAL ENCODING
      const labelDecoder = modelData.labelEncoder[name];
      if (labelDecoder && labelDecoder[value] !== undefined) {
        return labelDecoder[value];  // Convert ID → String
      }
      return value;
    } else {
      // (6) CONTINUOUS TRANSFORMATION
      const feature = modelData.features.find(f => f.name === name);
      const transform = feature?.config?.usesTransform;

      if (transform === 'log10') {
        // (7) Apply log10 transformation
        return value > 0 ? Math.log10(value) : 0;
      }

      return value;  // (8) No transformation
    }
  });

  // ... rest of function (prediction calls)
};
```

### **Line-by-Line Breakdown:**

#### **Line 1: Function Declaration**
```javascript
const handleCheck = () => {
```
- Arrow function assigned to `handleCheck`
- Called when user clicks "Check" button
- No parameters (uses component state)

#### **Line 2: Safety Check**
```javascript
if (!ebm || !modelData) return;
```
- **Guard clause** prevents errors
- Returns early if required data missing
- Should never happen (button disabled if data missing)

#### **Line 5: Map Over Feature Names**
```javascript
const sample = ebm.featureNames.map((name, index) => {
```

**What `.map()` does:**
- Creates new array by transforming each element
- Input: `ebm.featureNames` (array of 19 feature names)
- Output: `sample` (array of 19 transformed values)

**Iteration details:**
```javascript
ebm.featureNames = ['loan_amnt', 'term', 'emp_length', ..., 'fico_score']

// Map iteration 1:
name = 'loan_amnt'
index = 0
// ... transformation logic ...
// returns: 20000

// Map iteration 2:
name = 'term'
index = 1
// ... transformation logic ...
// returns: '36 months'

// ... continues for all 19 features

// Final sample array:
sample = [20000, '36 months', '10+ years', ..., 677]
```

#### **Line 6: Get Form Value**
```javascript
const value = featureValues[name];
```

**Example values:**
```javascript
// Iteration 1:
name = 'loan_amnt'
value = featureValues['loan_amnt'] = 20000

// Iteration 2:
name = 'term'
value = featureValues['term'] = 1  // ID, not string yet

// Iteration 5:
name = 'annual_inc'
value = featureValues['annual_inc'] = 61000  // Raw, not log10 yet
```

#### **Line 8: Check Feature Type**
```javascript
if (ebm.featureTypes[index] === 'categorical') {
```

**Determines processing path:**
- Categorical → Decode ID to string
- Continuous → Check for transformations

**Example:**
```javascript
// Iteration 2 (term):
ebm.featureTypes[1] = 'categorical'
// Takes categorical path

// Iteration 5 (annual_inc):
ebm.featureTypes[4] = 'continuous'
// Takes continuous path
```

---

### **CATEGORICAL ENCODING (Lines 10-15)**

For categorical features, we need to convert the stored ID back to the original string.

#### **Code:**
```javascript
const labelDecoder = modelData.labelEncoder[name];
if (labelDecoder && labelDecoder[value] !== undefined) {
  return labelDecoder[value];
}
return value;
```

#### **Detailed Example: `term` feature**

**Starting state:**
```javascript
name = 'term'
value = 1  // Stored ID from dropdown
```

**Step 1: Get decoder**
```javascript
labelDecoder = modelData.labelEncoder['term']
// Returns:
{
  '1': '36 months',
  '2': '60 months'
}
```

**Step 2: Check if decoder exists and has this value**
```javascript
labelDecoder !== null  // ✓ true
labelDecoder[1] !== undefined  // ✓ true (labelDecoder['1'] = '36 months')
```

**Step 3: Return decoded value**
```javascript
return labelDecoder[1]
// Returns: '36 months'
```

**Complete transformation:**
```javascript
// Input:
value = 1

// Process:
labelDecoder = { '1': '36 months', '2': '60 months' }
result = labelDecoder['1']

// Output:
'36 months'
```

#### **Example: `emp_length` feature**

**Starting state:**
```javascript
name = 'emp_length'
value = 2
```

**Process:**
```javascript
labelDecoder = modelData.labelEncoder['emp_length']
// Returns:
{
  '1': '< 1 year',
  '2': '10+ years',
  '3': '2 years',
  '4': '3 years',
  // ... more options
}

result = labelDecoder[2]
// Returns: '10+ years'
```

**Output:** `'10+ years'`

#### **Edge case: Unseen value**
```javascript
name = 'term'
value = 999  // Invalid ID (doesn't exist)

labelDecoder = { '1': '36 months', '2': '60 months' }
labelDecoder[999] = undefined

// Condition fails:
labelDecoder[999] !== undefined  // false

// Falls through to:
return value;  // Returns: 999
```

---

### **CONTINUOUS TRANSFORMATION (Lines 16-24)**

For continuous features, we check if transformation is needed.

#### **Code:**
```javascript
const feature = modelData.features.find(f => f.name === name);
const transform = feature?.config?.usesTransform;

if (transform === 'log10') {
  return value > 0 ? Math.log10(value) : 0;
}

return value;
```

#### **Example 1: `loan_amnt` (No Transform)**

**Starting state:**
```javascript
name = 'loan_amnt'
value = 20000
```

**Step 1: Find feature metadata**
```javascript
feature = modelData.features.find(f => f.name === 'loan_amnt')
// Returns:
{
  name: 'loan_amnt',
  type: 'continuous',
  config: {
    difficulty: 3,
    requiresInt: false,
    usesTransform: null  // ← No transformation!
  },
  // ... other properties
}
```

**Step 2: Get transform type**
```javascript
transform = feature?.config?.usesTransform
// Returns: null
```

**Step 3: Check if log10**
```javascript
if (null === 'log10') {  // false
  // Not executed
}
```

**Step 4: Return original value**
```javascript
return value;
// Returns: 20000
```

**Output:** `20000` (unchanged)

#### **Example 2: `annual_inc` (Log10 Transform)**

**Starting state:**
```javascript
name = 'annual_inc'
value = 61000
```

**Step 1: Find feature metadata**
```javascript
feature = modelData.features.find(f => f.name === 'annual_inc')
// Returns:
{
  name: 'annual_inc',
  type: 'continuous',
  config: {
    difficulty: 3,
    requiresInt: false,
    usesTransform: 'log10'  // ← Has log10 transform!
  },
  // ... other properties
}
```

**Step 2: Get transform type**
```javascript
transform = feature?.config?.usesTransform
// Returns: 'log10'
```

**Step 3: Check if log10**
```javascript
if ('log10' === 'log10') {  // ✓ true
  return value > 0 ? Math.log10(value) : 0;
}
```

**Step 4: Apply Math.log10**
```javascript
value = 61000
value > 0  // ✓ true

Math.log10(61000)
// Calculation:
// log₁₀(61000) = log(61000) / log(10)
//               = 10.9857 / 2.3026
//               = 4.7853

// Returns: 4.7853298350874
```

**Output:** `4.7853298350874`

#### **Example 3: `revol_bal` (Log10 Transform)**

**Starting state:**
```javascript
name = 'revol_bal'
value = 11000
```

**Process:**
```javascript
feature = modelData.features.find(f => f.name === 'revol_bal')
transform = feature?.config?.usesTransform  // 'log10'

if ('log10' === 'log10') {  // ✓ true
  return Math.log10(11000);
}

Math.log10(11000)
// Calculation:
// log₁₀(11000) = 4.0413926851582
```

**Output:** `4.0413926851582`

#### **Edge Case: Zero or Negative Value**
```javascript
name = 'annual_inc'
value = 0  // Edge case

transform = 'log10'

if (transform === 'log10') {
  return value > 0 ? Math.log10(value) : 0;
  //     0 > 0 ? ... : 0
  //     false  ? ... : 0
  // Returns: 0
}
```

**Why check `value > 0`?**
- `Math.log10(0)` = `-Infinity`
- `Math.log10(-5)` = `NaN`
- Both would break the model
- Fallback to 0 prevents errors

---

### **Complete Sample Array Building**

Let's trace through building the **entire** sample array:

```javascript
ebm.featureNames = [
  'loan_amnt',           // 0
  'term',                // 1
  'emp_length',          // 2
  'home_ownership',      // 3
  'annual_inc',          // 4
  'verification_status', // 5
  'purpose',             // 6
  'dti',                 // 7
  'delinq_2yrs',        // 8
  'earliest_cr_line',    // 9
  'inq_last_6mths',     // 10
  'open_acc',            // 11
  'pub_rec',            // 12
  'revol_bal',          // 13
  'revol_util',          // 14
  'total_acc',           // 15
  'application_type',    // 16
  'mort_acc',           // 17
  'pub_rec_bankruptcies',// 18
  'fico_score'          // 19
]
```

**Map iteration by iteration:**

**Iteration 0: `loan_amnt`**
```javascript
name = 'loan_amnt'
value = 20000
type = 'continuous'
transform = null
→ Returns: 20000
```

**Iteration 1: `term`**
```javascript
name = 'term'
value = 1
type = 'categorical'
labelDecoder = { '1': '36 months', '2': '60 months' }
→ Returns: '36 months'
```

**Iteration 2: `emp_length`**
```javascript
name = 'emp_length'
value = 2
type = 'categorical'
labelDecoder = { '1': '< 1 year', '2': '10+ years', ... }
→ Returns: '10+ years'
```

**Iteration 3: `home_ownership`**
```javascript
name = 'home_ownership'
value = 4
type = 'categorical'
labelDecoder = { ..., '4': 'RENT', ... }
→ Returns: 'RENT'
```

**Iteration 4: `annual_inc`**
```javascript
name = 'annual_inc'
value = 61000
type = 'continuous'
transform = 'log10'
→ Returns: 4.7853298350874
```

**Iteration 5: `verification_status`**
```javascript
name = 'verification_status'
value = 2
type = 'categorical'
labelDecoder = { ..., '2': 'Source Verified', ... }
→ Returns: 'Source Verified'
```

**Iteration 6: `purpose`**
```javascript
name = 'purpose'
value = 3
type = 'categorical'
labelDecoder = { ..., '3': 'debt_consolidation', ... }
→ Returns: 'debt_consolidation'
```

**Iteration 7: `dti`**
```javascript
name = 'dti'
value = 20.47
type = 'continuous'
transform = null
→ Returns: 20.47
```

**Iteration 8: `delinq_2yrs`**
```javascript
name = 'delinq_2yrs'
value = 1
type = 'categorical'
labelDecoder = { '1': '0', '2': '1', '3': '2', ... }
→ Returns: '0'
```

**Iteration 9: `earliest_cr_line`**
```javascript
name = 'earliest_cr_line'
value = 16
type = 'continuous'
transform = null
→ Returns: 16
```

**Iteration 10: `inq_last_6mths`**
```javascript
name = 'inq_last_6mths'
value = 1
type = 'categorical'
labelDecoder = { '1': '0', '2': '1', '3': '2', ... }
→ Returns: '0'
```

**Iteration 11: `open_acc`**
```javascript
name = 'open_acc'
value = 11
type = 'continuous'
transform = null
→ Returns: 11
```

**Iteration 12: `pub_rec`**
```javascript
name = 'pub_rec'
value = 1
type = 'categorical'
labelDecoder = { '1': '0', '2': '1', ... }
→ Returns: '0'
```

**Iteration 13: `revol_bal`**
```javascript
name = 'revol_bal'
value = 11000
type = 'continuous'
transform = 'log10'
→ Returns: 4.0413926851582
```

**Iteration 14: `revol_util`**
```javascript
name = 'revol_util'
value = 57.7
type = 'continuous'
transform = null
→ Returns: 57.7
```

**Iteration 15: `total_acc`**
```javascript
name = 'total_acc'
value = 21
type = 'continuous'
transform = null
→ Returns: 21
```

**Iteration 16: `application_type`**
```javascript
name = 'application_type'
value = 1
type = 'categorical'
labelDecoder = { '1': 'Individual', '2': 'Joint App' }
→ Returns: 'Individual'
```

**Iteration 17: `mort_acc`**
```javascript
name = 'mort_acc'
value = 1
type = 'categorical'
labelDecoder = { '1': '0', '2': '1', ... }
→ Returns: '0'
```

**Iteration 18: `pub_rec_bankruptcies`**
```javascript
name = 'pub_rec_bankruptcies'
value = 1
type = 'categorical'
labelDecoder = { '1': '0', '2': '1', ... }
→ Returns: '0'
```

**Iteration 19: `fico_score`**
```javascript
name = 'fico_score'
value = 677
type = 'continuous'
transform = null
→ Returns: 677
```

### **Final Sample Array:**

```javascript
sample = [
  20000,                // loan_amnt (no transform)
  '36 months',          // term (decoded)
  '10+ years',          // emp_length (decoded)
  'RENT',               // home_ownership (decoded)
  4.7853298350874,      // annual_inc (log10 transformed)
  'Source Verified',    // verification_status (decoded)
  'debt_consolidation', // purpose (decoded)
  20.47,                // dti (no transform)
  '0',                  // delinq_2yrs (decoded)
  16,                   // earliest_cr_line (no transform)
  '0',                  // inq_last_6mths (decoded)
  11,                   // open_acc (no transform)
  '0',                  // pub_rec (decoded)
  4.0413926851582,      // revol_bal (log10 transformed)
  57.7,                 // revol_util (no transform)
  21,                   // total_acc (no transform)
  'Individual',         // application_type (decoded)
  '0',                  // mort_acc (decoded)
  '0',                  // pub_rec_bankruptcies (decoded)
  677                   // fico_score (no transform)
]
```

**This sample array is now ready to be sent to the EBM model for prediction!**

---

I'll continue with Steps 9-14 in the next response due to length constraints. Would you like me to continue with the detailed explanation of the EBM prediction calculations?