# Complete Flow of the "Check" Feature

This document explains the entire workflow of the Check button in GAM Coach, from clicking the button to displaying the prediction result.

---

## **Architecture Overview**

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER CLICKS "CHECK"                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: CoachPanel.svelte - checkClicked()                     │
│  • Updates checkModalConfigStore                                 │
│  • Passes ebm and modelData to the store                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: CheckModal.svelte - Modal Opens                        │
│  • Subscribes to checkModalConfigStore                          │
│  • Receives ebm and modelData                                   │
│  • Calls initializeFeatureValues()                              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: User Enters/Modifies Form Values                       │
│  • Form inputs bind to featureValues object                     │
│  • Continuous features: number inputs                           │
│  • Categorical features: select dropdowns                       │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: User Clicks "Check" Button                             │
│  • Calls handleCheck()                                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: Data Transformation & Encoding                         │
│  • buildSample() - creates sample array                         │
│  • Categorical: ID → Label String                               │
│  • Continuous with log10: value → Math.log10(value)             │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 6: EBM Prediction (gamcoach.js)                           │
│  • ebm.predict([sample], true) → rawScore                       │
│  • ebm.predictProb([sample]) → probability                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 7: Result Display                                         │
│  • Shows Decision (Approved/Rejected)                           │
│  • Shows Probability (%)                                        │
│  • Shows Raw Score (log-odds)                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## **Step-by-Step Code Flow**

### **Step 1: Opening the Check Modal**

**File:** `gamcoach-ui/src/components/coach-panel/CoachPanel.svelte`

**Location:** Lines 428-441

```javascript
const checkClicked = () => {
  // Update the Svelte store to open the modal
  checkModalConfigStore.update(value => {
    value.show = true;          // Show the modal
    value.ebm = ebm;             // Pass the EBM model instance
    value.modelData = modelData; // Pass the model metadata
    return value;
  });

  // Log the interaction for analytics
  logger?.addLog({
    eventName: 'check modal opened',
    elementName: 'check'
  });
};
```

**What happens:**
- User clicks the "Check" button (🔲 icon) in the top-right corner
- `checkClicked()` function is triggered
- Updates `checkModalConfigStore` (a Svelte writable store)
- Sets `show: true` to display the modal
- Passes two critical objects:
  - **`ebm`**: The EBM model instance (from `gamcoach.js`)
  - **`modelData`**: The model data loaded from `lc-classifier.json`

---

### **Step 2: Modal Initialization**

**File:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`

**Location:** Lines 14-25 (Store subscription)

```javascript
const unsubscribe = checkModalConfigStore.subscribe(value => {
  show = value.show;           // Controls modal visibility
  ebm = value.ebm;             // EBM model instance
  modelData = value.modelData; // Model metadata

  // Initialize feature values when modal opens
  if (show && ebm && modelData) {
    initializeFeatureValues();
    showResult = false;
    predictionResult = null;
  }
});
```

**What happens:**
- CheckModal subscribes to `checkModalConfigStore`
- When the store updates, the modal receives `ebm` and `modelData`
- Calls `initializeFeatureValues()` to populate default form values

---

**Location:** Lines 30-82 (Initialization)

```javascript
const initializeFeatureValues = () => {
  featureValues = {};

  if (!ebm || !ebm.featureNames || !modelData) return;

  // Default values for your loan application
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

  // Default categorical values (binLabel IDs)
  const categoricalDefaults = {
    'term': 1,                    // 36 months
    'emp_length': 2,              // 10+ years
    'home_ownership': 4,          // Rent
    'verification_status': 2,     // Source Verified
    'purpose': 3,                 // Debt Consolidation
    'delinq_2yrs': 1,            // 0 time
    'inq_last_6mths': 1,         // 0 time
    'pub_rec': 1,                // 0 time
    'application_type': 1,        // Individual
    'mort_acc': 1,               // 0 account
    'pub_rec_bankruptcies': 1    // 0 time
  };

  // Populate featureValues for each feature
  ebm.featureNames.forEach((name, index) => {
    const featureType = ebm.featureTypes[index];

    if (featureType === 'continuous') {
      featureValues[name] = reasonableDefaults[name] || 0;
    } else if (featureType === 'categorical') {
      if (categoricalDefaults[name] !== undefined) {
        featureValues[name] = categoricalDefaults[name];
      } else {
        // Use first category option
        const feature = modelData.features.find(f => f.name === name);
        if (feature && feature.binLabel && feature.binLabel.length > 0) {
          featureValues[name] = feature.binLabel[0];
        }
      }
    }
  });
};
```

**What happens:**
- Creates `featureValues` object to store form inputs
- Pre-fills with reasonable defaults for demonstration
- For **continuous features**: Uses numeric defaults (e.g., `loan_amnt: 20000`)
- For **categorical features**: Uses encoded IDs (e.g., `term: 1` for "36 months")

**Data Structure After Initialization:**
```javascript
featureValues = {
  loan_amnt: 20000,
  term: 1,                    // Maps to "36 months" via labelEncoder
  emp_length: 2,              // Maps to "10+ years"
  home_ownership: 4,          // Maps to "RENT"
  annual_inc: 61000,
  // ... etc
}
```

---

### **Step 3: Form Rendering and User Input**

**File:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`

**Location:** Lines 240-277 (Form rendering)

```svelte
<div class="feature-inputs">
  {#each ebm.featureNames as featureName, index}
    {#if ebm.featureTypes[index] !== 'interaction'}
      <div class="input-group">
        <label for={`input-${featureName}`}>
          {getFeatureDisplayName(featureName)}
        </label>

        <!-- For CONTINUOUS features -->
        {#if ebm.featureTypes[index] === 'continuous'}
          <input
            id={`input-${featureName}`}
            type="number"
            bind:value={featureValues[featureName]}
            placeholder="Enter value"
            step="any"
          />

        <!-- For CATEGORICAL features -->
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

**What happens:**
- Loops through all features in `ebm.featureNames`
- For **continuous features**: Renders `<input type="number">`
- For **categorical features**: Renders `<select>` dropdown
- Uses Svelte's `bind:value` for two-way data binding
- User changes automatically update `featureValues` object

**Helper Function for Categorical Options:**

```javascript
const getCategoricalOptions = (featureName) => {
  if (!modelData) return [];

  const feature = modelData.features.find(f => f.name === featureName);
  if (!feature || !feature.binLabel) return [];

  const levelDescriptions = feature.description?.levelDescription || {};

  // Map binLabel IDs to display names
  return feature.binLabel.map(value => ({
    value: value,  // The encoded ID (e.g., 1)
    label: levelDescriptions[value]?.displayName || `Option ${value}`
  }));
};
```

**Example for `term` feature:**
```javascript
// Returns:
[
  { value: 1, label: "36 months" },
  { value: 2, label: "60 months" }
]
```

---

### **Step 4: User Clicks "Check" Button**

**File:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`

**Location:** Lines 125-199 (handleCheck function)

```javascript
const handleCheck = () => {
  if (!ebm || !modelData) return;

  // Build sample array in the correct order
  // CRITICAL: This is where transformation happens!
  const sample = ebm.featureNames.map((name, index) => {
    const value = featureValues[name];

    if (ebm.featureTypes[index] === 'categorical') {
      // CATEGORICAL: Convert ID to label string
      const labelDecoder = modelData.labelEncoder[name];
      if (labelDecoder && labelDecoder[value] !== undefined) {
        return labelDecoder[value];  // e.g., 1 → "36 months"
      }
      return value;
    } else {
      // CONTINUOUS: Apply transformations
      const feature = modelData.features.find(f => f.name === name);
      const transform = feature?.config?.usesTransform;

      if (transform === 'log10') {
        // Apply log10 transformation
        return value > 0 ? Math.log10(value) : 0;
      }

      return value;  // No transformation
    }
  });

  // ... rest of the function
};
```

---

### **Step 5: Data Transformation & Encoding**

This is the **CRITICAL** step where raw form values are converted into the format the EBM model expects.

#### **5a. Categorical Encoding**

**Example: `term` feature**

```javascript
// User sees in dropdown: "36 months"
// Form stores ID: 1
// EBM needs: "36 months" (string)

// Transformation:
featureValues['term'] = 1;  // Stored in form

// In handleCheck():
const labelDecoder = modelData.labelEncoder['term'];
// labelDecoder = { '1': '36 months', '2': '60 months' }

const encodedValue = labelDecoder[1];  // Returns: "36 months"
```

#### **5b. Continuous Features - No Transform**

**Example: `loan_amnt` feature**

```javascript
// User enters: 20000
// Form stores: 20000
// EBM needs: 20000

featureValues['loan_amnt'] = 20000;

// In handleCheck():
const transform = feature?.config?.usesTransform;  // undefined
return 20000;  // No transformation
```

#### **5c. Continuous Features - Log10 Transform**

**Example: `annual_inc` feature**

```javascript
// User enters: 61000
// Form stores: 61000
// EBM needs: log10(61000) = 4.7853

featureValues['annual_inc'] = 61000;

// In handleCheck():
const transform = feature?.config?.usesTransform;  // "log10"
return Math.log10(61000);  // Returns: 4.7853
```

**Another Example: `revol_bal` feature**

```javascript
// User enters: 11000
// Form stores: 11000
// EBM needs: log10(11000) = 4.0414

featureValues['revol_bal'] = 11000;

// In handleCheck():
return Math.log10(11000);  // Returns: 4.0414
```

#### **Final Sample Array**

After all transformations, the `sample` array looks like:

```javascript
sample = [
  20000,           // loan_amnt (no transform)
  "36 months",     // term (categorical decoded)
  "10+ years",     // emp_length (categorical decoded)
  "RENT",          // home_ownership (categorical decoded)
  4.7853,          // annual_inc (log10 transformed)
  "Source Verified", // verification_status (categorical decoded)
  "debt_consolidation", // purpose (categorical decoded)
  20.47,           // dti (no transform)
  "0",             // delinq_2yrs (categorical decoded)
  16,              // earliest_cr_line (no transform)
  "0",             // inq_last_6mths (categorical decoded)
  11,              // open_acc (no transform)
  "0",             // pub_rec (categorical decoded)
  4.0414,          // revol_bal (log10 transformed)
  57.7,            // revol_util (no transform)
  21,              // total_acc (no transform)
  "Individual",    // application_type (categorical decoded)
  "0",             // mort_acc (categorical decoded)
  "0",             // pub_rec_bankruptcies (categorical decoded)
  677              // fico_score (no transform)
];
```

---

### **Step 6: EBM Prediction Calculation**

**File:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`

**Location:** Lines 181-189

```javascript
// Get prediction
const rawScore = ebm.predict([sample], true)[0];
const probability = ebm.predictProb([sample])[0];
const prediction = probability >= 0.5 ? 1 : 0;

console.log('Raw Score:', rawScore);
console.log('Probability:', probability);
console.log('Decision:', prediction === 1 ? 'Approved' : 'Rejected');
```

This calls the EBM class methods. Let's dive into those:

---

**File:** `gamcoach-ui/src/ebm/gamcoach.js`

#### **6a. EBM.predict() - Get Raw Score**

**Location:** Lines 286-307

```javascript
predict(samples, rawScore = false) {
  let predictions = [];

  for (let i = 0; i < samples.length; i++) {
    let curSample = samples[i];

    // Step 1: Count scores for all features (main + interaction)
    let binScores = this.countScore(curSample);

    // Step 2: Sum all scores + intercept
    let predScore = Object.values(binScores).reduce((a, b) => a + b);
    predScore += this.intercept;

    // Step 3: Convert to probability if classifier
    if (this.isClassifier && !rawScore) {
      predScore = sigmoid(predScore) >= 0.5 ? 1 : 0;
    }

    predictions.push(predScore);
  }

  return predictions;
}
```

#### **6b. EBM.predictProb() - Get Probability**

**Location:** Lines 313-335

```javascript
predictProb(samples) {
  let predictions = [];

  for (let i = 0; i < samples.length; i++) {
    let curSample = samples[i];

    // Get scores
    let binScores = this.countScore(curSample);

    // Sum scores + intercept
    let predScore = Object.values(binScores).reduce((a, b) => a + b);
    predScore += this.intercept;

    // Convert to probability using sigmoid
    if (this.isClassifier) {
      predScore = sigmoid(predScore);
    }

    predictions.push(predScore);
  }

  return predictions;
}
```

#### **6c. EBM.countScore() - Calculate Feature Scores**

**Location:** Lines 176-278

This is the **CORE** of the EBM prediction logic. It calculates scores for:
1. **Main effects** (individual features)
2. **Interaction effects** (feature pairs)

```javascript
countScore(sample) {
  let binScores = {};

  // STEP 1: Encode categorical strings to integers
  let encodedSample = sample.slice();
  for (let j = 0; j < sample.length; j++) {
    if (this.featureTypes[j] === 'categorical') {
      let curEncoder = this.labelEncoder[this.featureNames[j]];

      if (curEncoder[sample[j]] !== undefined) {
        // Convert string to integer ID
        encodedSample[j] = parseInt(curEncoder[sample[j]], 10);
      } else {
        // Unseen level → score = 0
        encodedSample[j] = 0;
      }
    }
  }

  // STEP 2: Calculate MAIN EFFECT scores
  for (let j = 0; j < encodedSample.length; j++) {
    let curFeatureName = this.featureNames[j];
    let curFeatureType = this.featureTypes[j];
    let curFeature = encodedSample[j];

    let binIndex = -1;
    let binScore = 0;

    if (curFeatureType === 'continuous') {
      // Find which bin this continuous value falls into
      binIndex = searchSortedLowerIndex(this.binEdges[j], curFeature);
      binScore = this.scores[j][binIndex];
    } else {
      // Find matching categorical bin
      binIndex = this.binEdges[j].indexOf(curFeature);

      if (binIndex < 0) {
        binScore = 0;  // Unseen level
      } else {
        binScore = this.scores[j][binIndex];
      }
    }

    binScores[curFeatureName] = binScore;
  }

  // STEP 3: Calculate INTERACTION EFFECT scores
  for (let j = 0; j < this.interactionIndexes.length; j++) {
    let curIndexes = this.interactionIndexes[j];

    let name1 = this.featureNames[curIndexes[0]];
    let name2 = this.featureNames[curIndexes[1]];

    let type1 = this.featureTypes[curIndexes[0]];
    let type2 = this.featureTypes[curIndexes[1]];

    let value1 = encodedSample[curIndexes[0]];
    let value2 = encodedSample[curIndexes[1]];

    // Find bin indices for both features
    let binIndex1 = -1;
    let binIndex2 = -1;

    if (type1 === 'continuous') {
      binIndex1 = searchSortedLowerIndex(
        this.interactionBinEdges[j][0],
        value1
      );
    } else {
      binIndex1 = this.interactionBinEdges[j][0].indexOf(value1);
    }

    if (type2 === 'continuous') {
      binIndex2 = searchSortedLowerIndex(
        this.interactionBinEdges[j][1],
        value2
      );
    } else {
      binIndex2 = this.interactionBinEdges[j][1].indexOf(value2);
    }

    // Get interaction score
    let binScore = 0;

    if (binIndex1 < 0 || binIndex2 < 0) {
      binScore = 0;
    } else {
      binScore = this.interactionScores[j][binIndex1][binIndex2];
    }

    binScores[`${name1} x ${name2}`] = binScore;
  }

  return binScores;
}
```

**What `countScore()` returns:**

```javascript
binScores = {
  // Main effects
  'loan_amnt': -0.1663,
  'term': 0.2201,
  'emp_length': -0.0508,
  'home_ownership': -0.1447,
  'annual_inc': -0.0330,
  // ... more main effects ...

  // Interaction effects
  'loan_amnt x revol_bal': -0.0433,
  'home_ownership x mort_acc': 0.0163,
  'pub_rec x revol_bal': 0.0114,
  // ... more interactions ...
}
```

#### **6d. Sigmoid Function**

**Location:** Lines 44-49

```javascript
function sigmoid(logit) {
  let odd = Math.exp(logit);
  return round(odd / (1 + odd), 5);
}
```

**Example Calculation:**

```javascript
// Given:
rawScore = -0.3774  // Sum of all feature scores + intercept

// Calculate probability:
odd = Math.exp(-0.3774)  // = 0.6856
probability = 0.6856 / (1 + 0.6856)  // = 0.6856 / 1.6856 = 0.407
// = 40.7%
```

#### **6e. Binary Search for Continuous Features**

**Location:** Lines 14-38

```javascript
function searchSortedLowerIndex(sorted, value) {
  let left = 0;
  let right = sorted.length - 1;

  while (right - left > 1) {
    let i = left + Math.floor((right - left) / 2);

    if (value > sorted[i]) {
      left = i;
    } else if (value < sorted[i]) {
      right = i;
    } else {
      return i;
    }
  }

  // Handle out of bound issue
  if (value >= sorted[right]) {
    return right;
  }
  if (value < sorted[left]) {
    return left;
  }
  return right - 1;
}
```

**Example for `annual_inc`:**

```javascript
// After log10 transform: 4.7853
// binEdges for annual_inc: [3.477, 4.146, 4.203, 4.254, ...]

// searchSortedLowerIndex([3.477, 4.146, 4.203, 4.254, ...], 4.7853)
// Returns: bin index where 4.7853 falls
// Then looks up score: scores[binIndex]
```

---

### **Step 7: Display Results**

**File:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`

**Location:** Lines 191-198

```javascript
predictionResult = {
  prediction: prediction,     // 0 or 1
  probability: probability,   // 0.407
  rawScore: rawScore,        // -0.3774
  decision: prediction === 1 ? 'Approved' : 'Rejected'
};

showResult = true;
```

**Location:** Lines 280-298 (HTML rendering)

```svelte
{#if showResult && predictionResult}
  <div class="result-panel"
       class:approved={predictionResult.prediction === 1}
       class:rejected={predictionResult.prediction === 0}>

    <div class="result-header">Prediction Result</div>

    <div class="result-content">
      <div class="result-decision">
        <span class="label">Decision:</span>
        <span class="value decision-text">
          {predictionResult.decision}
        </span>
      </div>

      <div class="result-probability">
        <span class="label">Probability:</span>
        <span class="value">
          {(predictionResult.probability * 100).toFixed(1)}%
        </span>
      </div>

      <div class="result-score">
        <span class="label">Raw Score:</span>
        <span class="value">
          {predictionResult.rawScore.toFixed(3)}
        </span>
      </div>
    </div>
  </div>
{/if}
```

**What the user sees:**

```
┌─────────────────────────────────┐
│      Prediction Result          │
│                                 │
│  Decision:     REJECTED         │
│  Probability:  40.7%            │
│  Raw Score:    -0.377           │
└─────────────────────────────────┘
```

---

## **Complete Data Flow Summary**

### **Input Data (Form)**
```javascript
{
  loan_amnt: 20000,
  term: 1,                    // Category ID
  emp_length: 2,              // Category ID
  annual_inc: 61000,          // Raw value
  revol_bal: 11000,           // Raw value
  // ... etc
}
```

### **Transformed Sample (Sent to EBM)**
```javascript
[
  20000,              // loan_amnt (no transform)
  "36 months",        // term (decoded: 1 → "36 months")
  "10+ years",        // emp_length (decoded: 2 → "10+ years")
  4.7853,             // annual_inc (log10 transformed)
  4.0414,             // revol_bal (log10 transformed)
  // ... etc
]
```

### **Feature Scores (from countScore)**
```javascript
{
  // Main effects
  loan_amnt: -0.1663,
  term: 0.2201,
  annual_inc: -0.0330,
  revol_bal: 0.0050,
  fico_score: -0.1748,
  // ... 15 more main effects

  // Interaction effects
  'loan_amnt x revol_bal': -0.0433,
  'annual_inc x revol_bal': 0.0145,
  // ... 8 more interactions
}
```

### **Final Calculation**
```
Raw Score = intercept + Σ(all feature scores)
          = 0.002579 + (-0.1663 + 0.2201 - 0.0330 + ... + -0.0433 + ...)
          = -0.3774

Probability = sigmoid(-0.3774)
            = 1 / (1 + exp(0.3774))
            = 0.407
            = 40.7%

Decision = (0.407 >= 0.5) ? "Approved" : "Rejected"
         = "Rejected"
```

---

## **Key Takeaways**

1. **Two-stage encoding:**
   - Form stores categorical IDs (1, 2, 3...)
   - Before prediction, IDs are decoded to strings ("36 months", "RENT", ...)

2. **Log10 transformations:**
   - Applied ONLY to `annual_inc` and `revol_bal`
   - Happens during sample building, NOT in form storage

3. **EBM scoring:**
   - Looks up scores from pre-computed bins
   - Adds main effects + interaction effects
   - Uses binary search for continuous features

4. **Probability calculation:**
   - Sigmoid function converts log-odds to probability
   - Threshold of 0.5 (50%) determines approval/rejection

5. **Model Data Structure:**
   - `lc-classifier.json` contains all pre-trained scores
   - No actual "training" happens at runtime
   - Prediction is just table lookups + summation

---

## **Debug Tips**

Open browser console (F12) when clicking Check to see:

```
=== CheckModal Prediction ===
Input values by feature:
  Loan Amount: 20000
  Payment Period: 36 months (ID: 1, Encoded: "36 months")
  Annual Income: 61000 (log10: 4.7853)
  Revolving Balance: 11000 (log10: 4.0414)
  ...

Sample array sent to EBM: [20000, "36 months", ..., 4.7853, ...]

Raw Score: -0.3774
Probability: 0.407
Decision: Rejected
```

This shows the exact transformations applied and helps verify correctness!
