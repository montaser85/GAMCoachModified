# Detailed Step-by-Step Walkthrough of the Check Feature (Part 2)

This is **Part 2** of the detailed walkthrough, covering the EBM prediction calculations (Steps 9-14).

**Part 1** covers Steps 1-8 (form initialization and sample array building).

---

## **Recap: Where We Are**

After Step 8, we have built the sample array:

```javascript
sample = [
  20000,                // loan_amnt
  '36 months',          // term
  '10+ years',          // emp_length
  'RENT',               // home_ownership
  4.7853,               // annual_inc (log10 transformed!)
  'Source Verified',    // verification_status
  'debt_consolidation', // purpose
  20.47,                // dti
  '0',                  // delinq_2yrs
  16,                   // earliest_cr_line
  '0',                  // inq_last_6mths
  11,                   // open_acc
  '0',                  // pub_rec
  4.0414,               // revol_bal (log10 transformed!)
  57.7,                 // revol_util
  21,                   // total_acc
  'Individual',         // application_type
  '0',                  // mort_acc
  '0',                  // pub_rec_bankruptcies
  677                   // fico_score
]
```

Now we call the EBM model to get predictions.

---

## **Step 9: EBM Prediction - predict()**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, line 182

### **Code:**
```javascript
const rawScore = ebm.predict([sample], true)[0];
```

### **Breakdown:**

**Function call:**
- `ebm` - The EBM instance (from `gamcoach.js`)
- `.predict()` - Method to get predictions
- `[sample]` - Array of samples (we're predicting for 1 sample)
- `true` - Return raw score (log-odds), not binary 0/1
- `[0]` - Get first element (we only have 1 sample)

**Why wrap in array?**
```javascript
// EBM.predict() expects 2D array:
// [[sample1], [sample2], [sample3]]

// Even for 1 sample, must wrap:
[sample]  // Correct
sample    // Wrong!
```

**This calls:** `gamcoach-ui/src/ebm/gamcoach.js` → `EBM.predict()`

---

### **EBM.predict() Implementation**

**File:** `gamcoach-ui/src/ebm/gamcoach.js`, lines 286-307

```javascript
predict(samples, rawScore = false) {
  console.assert(samples.length > 0 && samples[0].length > 0);

  let predictions = [];

  for (let i = 0; i < samples.length; i++) {
    let curSample = samples[i];

    // (1) Get all feature scores
    let binScores = this.countScore(curSample);

    // (2) Sum all scores + intercept
    let predScore = Object.values(binScores).reduce((a, b) => a + b);
    predScore += this.intercept;

    // (3) Convert to probability if classifier and rawScore=false
    if (this.isClassifier && !rawScore) {
      predScore = sigmoid(predScore) >= 0.5 ? 1 : 0;
    }

    predictions.push(predScore);
  }

  return predictions;
}
```

### **Line-by-Line:**

#### **Line 2: Assertion**
```javascript
console.assert(samples.length > 0 && samples[0].length > 0);
```
- Checks that input is valid
- `samples.length > 0` - At least one sample
- `samples[0].length > 0` - Sample has features
- Only logs error in dev tools if fails (doesn't stop execution)

#### **Line 4: Initialize Results**
```javascript
let predictions = [];
```
- Will store prediction for each sample
- For us: will have 1 element

#### **Line 6: Loop Through Samples**
```javascript
for (let i = 0; i < samples.length; i++) {
```
- In our case: `samples.length = 1`
- Loop runs once (i=0)

#### **Line 7: Get Current Sample**
```javascript
let curSample = samples[i];
// curSample = samples[0] = sample
// curSample = [20000, '36 months', ..., 677]
```

#### **Line 10: Count Feature Scores**
```javascript
let binScores = this.countScore(curSample);
```

**THIS IS THE HEART OF THE PREDICTION!**

- Calls `countScore()` method (we'll detail in Step 11)
- Returns object with scores for each feature

**What `countScore()` returns:**
```javascript
binScores = {
  // Main effects
  'loan_amnt': -0.1663,
  'term': 0.2201,
  'emp_length': -0.0508,
  'home_ownership': -0.1447,
  'annual_inc': -0.0330,
  'verification_status': -0.0515,
  'purpose': -0.0018,
  'dti': -0.0281,
  'delinq_2yrs': 0.0107,
  'earliest_cr_line': -0.0059,
  'inq_last_6mths': 0.1358,
  'open_acc': -0.0227,
  'pub_rec': 0.0157,
  'revol_bal': 0.0050,
  'revol_util': 0.0060,
  'total_acc': 0.0162,
  'application_type': -0.0008,
  'mort_acc': -0.0938,
  'pub_rec_bankruptcies': 0.0052,
  'fico_score': -0.1748,

  // Interaction effects
  'loan_amnt x revol_bal': -0.0433,
  'home_ownership x mort_acc': 0.0163,
  'pub_rec x revol_bal': 0.0114,
  'inq_last_6mths x fico_score': -0.0165,
  'emp_length x earliest_cr_line': -0.0159,
  'revol_bal x fico_score': -0.0014,
  'term x home_ownership': 0.0187,
  'loan_amnt x fico_score': -0.0113,
  'revol_bal x pub_rec_bankruptcies': 0.0072,
  'annual_inc x revol_bal': 0.0145
}
```

#### **Line 13: Sum All Scores**
```javascript
let predScore = Object.values(binScores).reduce((a, b) => a + b);
```

**Breakdown:**

**`Object.values(binScores)`:**
- Extracts just the values (scores)
- Ignores the keys (feature names)

```javascript
Object.values(binScores) = [
  -0.1663,  // loan_amnt
  0.2201,   // term
  -0.0508,  // emp_length
  // ... all 20 main effects
  -0.0433,  // loan_amnt x revol_bal
  0.0163,   // home_ownership x mort_acc
  // ... all 10 interactions
]
```

**`.reduce((a, b) => a + b)`:**
- Sums all values in the array
- `a` = accumulator (running sum)
- `b` = current value

**Step-by-step reduction:**
```javascript
// Start:
a = -0.1663  // First value
b = 0.2201   // Second value
a + b = 0.0538

// Next:
a = 0.0538
b = -0.0508
a + b = 0.0030

// ... continues for all 30 values

// Final sum:
predScore = -0.3800  // Approximate (before adding intercept)
```

#### **Line 14: Add Intercept**
```javascript
predScore += this.intercept;
// predScore = -0.3800 + 0.002579
// predScore = -0.3774
```

**What is the intercept?**
- Baseline score when all features are 0
- Shifts the overall prediction
- Comes from model training

#### **Lines 17-19: Convert to Binary (Skipped in our case)**
```javascript
if (this.isClassifier && !rawScore) {
  predScore = sigmoid(predScore) >= 0.5 ? 1 : 0;
}
```

**In our call:**
- `this.isClassifier = true` ✓
- `!rawScore = !true = false` ✗

**Condition:** `true && false = false`

**Result:** This block is skipped!

**Why skip?**
- We passed `rawScore = true` in the call
- We want the log-odds value (-0.3774), not binary 0/1

#### **Line 21: Store Prediction**
```javascript
predictions.push(predScore);
// predictions = [-0.3774]
```

#### **Line 24: Return Results**
```javascript
return predictions;
// Returns: [-0.3774]
```

### **Back to CheckModal:**

```javascript
const rawScore = ebm.predict([sample], true)[0];
//               └──────────────────────────┘
//                Returns: [-0.3774]
//                                           └─┘
//                                         Get first element

// rawScore = -0.3774
```

---

## **Step 10: EBM Prediction - predictProb()**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, line 183

### **Code:**
```javascript
const probability = ebm.predictProb([sample])[0];
```

**Similar to `predict()` but:**
- Always returns probability (0 to 1)
- Doesn't have `rawScore` parameter
- Applies sigmoid transformation

---

### **EBM.predictProb() Implementation**

**File:** `gamcoach-ui/src/ebm/gamcoach.js`, lines 313-335

```javascript
predictProb(samples) {
  console.assert(samples.length > 0 && samples[0].length > 0);

  let predictions = [];

  for (let i = 0; i < samples.length; i++) {
    let curSample = samples[i];

    // (1) Get all feature scores (same as predict)
    let binScores = this.countScore(curSample);

    // (2) Sum all scores + intercept (same as predict)
    let predScore = Object.values(binScores).reduce((a, b) => a + b);
    predScore += this.intercept;

    // (3) Convert to probability using sigmoid
    if (this.isClassifier) {
      predScore = sigmoid(predScore);
    }

    predictions.push(predScore);
  }

  return predictions;
}
```

### **Key Differences from predict():**

**Lines 1-14: Identical**
- Same assertions
- Same loop structure
- Same `countScore()` call
- Same summation

**Result after line 14:**
```javascript
predScore = -0.3774  // Same as in predict()
```

**Line 17: Apply Sigmoid**
```javascript
if (this.isClassifier) {  // true
  predScore = sigmoid(predScore);
}

// Before: predScore = -0.3774
// After:  predScore = sigmoid(-0.3774) = 0.407
```

### **Sigmoid Function**

**File:** `gamcoach-ui/src/ebm/gamcoach.js`, lines 44-49

```javascript
function sigmoid(logit) {
  let odd = Math.exp(logit);
  return round(odd / (1 + odd), 5);
}
```

**Step-by-step calculation for our value:**

#### **Step 1: Calculate Odds**
```javascript
logit = -0.3774
odd = Math.exp(-0.3774)

// Math.exp(x) = e^x
// e^(-0.3774) = 1/e^0.3774
//             = 1/1.4583
//             = 0.6856
```

#### **Step 2: Convert to Probability**
```javascript
odd = 0.6856
probability = odd / (1 + odd)
            = 0.6856 / (1 + 0.6856)
            = 0.6856 / 1.6856
            = 0.4068
```

#### **Step 3: Round**
```javascript
function round(num, decimal) {
  return Math.round((num + 2e-16) * 10 ** decimal) / 10 ** decimal;
}

round(0.4068, 5)
= Math.round(0.4068 * 100000) / 100000
= Math.round(40680) / 100000
= 40680 / 100000
= 0.4068
```

**Why add `2e-16`?**
- Tiny number (0.0000000000000002)
- Prevents floating-point rounding errors
- Ensures consistent rounding

**Final result:**
```javascript
predScore = 0.4068  // 40.68% probability
```

### **Back to CheckModal:**

```javascript
const probability = ebm.predictProb([sample])[0];
// probability = 0.4068
```

---

## **Step 11: Count Scores - Main Effects**

This is where the actual scoring happens! Let's dive deep into `countScore()`.

### **Where:** `gamcoach-ui/src/ebm/gamcoach.js`, lines 176-278

### **Function Overview:**

```javascript
countScore(sample) {
  let binScores = {};

  // PART 1: Encode categorical strings to integers (lines 180-195)
  let encodedSample = sample.slice();
  // ... encoding logic ...

  // PART 2: Calculate MAIN EFFECT scores (lines 197-227)
  for (let j = 0; j < encodedSample.length; j++) {
    // ... lookup score for each feature ...
  }

  // PART 3: Calculate INTERACTION EFFECT scores (lines 229-276)
  for (let j = 0; j < this.interactionIndexes.length; j++) {
    // ... lookup interaction scores ...
  }

  return binScores;
}
```

---

### **PART 1: Encode Categorical Features**

**Lines 180-195:**

```javascript
let encodedSample = sample.slice();

for (let j = 0; j < sample.length; j++) {
  if (this.featureTypes[j] === 'categorical') {
    let curEncoder = this.labelEncoder[this.featureNames[j]];

    if (curEncoder[sample[j]] !== undefined) {
      encodedSample[j] = parseInt(curEncoder[sample[j]], 10);
    } else {
      // Unseen level => 0 score
      encodedSample[j] = 0;
    }
  }
}
```

**Purpose:** Convert categorical strings back to integer IDs for lookup.

**Wait, didn't we already encode in Step 8?**
- In Step 8: We decoded IDs → Strings (for EBM input)
- Now: We encode Strings → IDs (for bin lookup)

**Why this round-trip?**
- EBM model stores categorical data as strings internally
- Bin lookups use integer indices
- This ensures compatibility

#### **Example: `term` feature**

**Input:**
```javascript
sample[1] = '36 months'
this.featureTypes[1] = 'categorical'
```

**Process:**
```javascript
j = 1
curEncoder = this.labelEncoder['term']
// curEncoder = { '36 months': '1', '60 months': '2' }

sample[j] = '36 months'
curEncoder['36 months'] = '1'
parseInt('1', 10) = 1

encodedSample[1] = 1
```

**Result:**
```javascript
// Before encoding:
sample[1] = '36 months'

// After encoding:
encodedSample[1] = 1
```

#### **Full Encoded Sample:**

After encoding, categorical features are integers:

```javascript
encodedSample = [
  20000,     // loan_amnt (continuous, unchanged)
  1,         // term (categorical, '36 months' → 1)
  2,         // emp_length (categorical, '10+ years' → 2)
  4,         // home_ownership (categorical, 'RENT' → 4)
  4.7853,    // annual_inc (continuous, unchanged)
  2,         // verification_status (categorical, 'Source Verified' → 2)
  3,         // purpose (categorical, 'debt_consolidation' → 3)
  20.47,     // dti (continuous, unchanged)
  1,         // delinq_2yrs (categorical, '0' → 1)
  16,        // earliest_cr_line (continuous, unchanged)
  1,         // inq_last_6mths (categorical, '0' → 1)
  11,        // open_acc (continuous, unchanged)
  1,         // pub_rec (categorical, '0' → 1)
  4.0414,    // revol_bal (continuous, unchanged)
  57.7,      // revol_util (continuous, unchanged)
  21,        // total_acc (continuous, unchanged)
  1,         // application_type (categorical, 'Individual' → 1)
  1,         // mort_acc (categorical, '0' → 1)
  1,         // pub_rec_bankruptcies (categorical, '0' → 1)
  677        // fico_score (continuous, unchanged)
]
```

---

### **PART 2: Main Effect Scores**

**Lines 197-227:**

```javascript
for (let j = 0; j < encodedSample.length; j++) {
  let curFeatureName = this.featureNames[j];
  let curFeatureType = this.featureTypes[j];
  let curFeature = encodedSample[j];

  let binIndex = -1;
  let binScore = 0;

  if (curFeatureType === 'continuous') {
    // (A) CONTINUOUS FEATURE
    binIndex = searchSortedLowerIndex(this.binEdges[j], curFeature);
    binScore = this.scores[j][binIndex];
  } else {
    // (B) CATEGORICAL FEATURE
    binIndex = this.binEdges[j].indexOf(curFeature);

    if (binIndex < 0) {
      binScore = 0;  // Unseen level
    } else {
      binScore = this.scores[j][binIndex];
    }
  }

  binScores[curFeatureName] = binScore;
}
```

**This loop processes all 19 features, calculating a score for each.**

---

#### **Example A: Continuous Feature - `loan_amnt`**

**Iteration j=0:**

```javascript
j = 0
curFeatureName = this.featureNames[0] = 'loan_amnt'
curFeatureType = this.featureTypes[0] = 'continuous'
curFeature = encodedSample[0] = 20000
```

**Bin Edges:**
```javascript
this.binEdges[0] = [
  0,     // Bin 0: [0, 1000)
  1000,  // Bin 1: [1000, 2000)
  2000,  // Bin 2: [2000, 3000)
  3000,  // Bin 3: [3000, 4000)
  // ... continues to 250000
]
```

**Bin Scores:**
```javascript
this.scores[0] = [
  0.7147,   // Score for bin 0
  0.7025,   // Score for bin 1
  0.6432,   // Score for bin 2
  0.4669,   // Score for bin 3
  // ... continues
]
```

**Find Bin Index:**
```javascript
binIndex = searchSortedLowerIndex(this.binEdges[0], 20000)
```

**`searchSortedLowerIndex()` function:**
```javascript
function searchSortedLowerIndex(sorted, value) {
  // Binary search to find which bin 20000 falls into

  // sorted = [0, 1000, 2000, 3000, ..., 250000]
  // value = 20000

  // Binary search finds that:
  // 20000 is between sorted[19] and sorted[20]
  // sorted[19] = 19000
  // sorted[20] = 20000

  // Returns: 19 (the index of the lower bound)
}
```

**For our value (20000):**
```javascript
binIndex = 19
// This means 20000 falls into bin 19: [19000, 20000)
```

**Get Score:**
```javascript
binScore = this.scores[0][19]
// binScore = -0.1663
```

**Store Result:**
```javascript
binScores['loan_amnt'] = -0.1663
```

---

#### **Example B: Continuous with Transform - `annual_inc`**

**Iteration j=4:**

```javascript
j = 4
curFeatureName = 'annual_inc'
curFeatureType = 'continuous'
curFeature = 4.7853  // Already log10 transformed!
```

**Bin Edges (in log10 space):**
```javascript
this.binEdges[4] = [
  3.4771,  // log10(3000)
  4.1463,  // log10(14000)
  4.2028,  // log10(15950)
  4.2540,  // log10(17940)
  4.3009,  // log10(20000)
  // ... continues
]
```

**Find Bin:**
```javascript
curFeature = 4.7853

// Binary search:
// 4.7853 falls between binEdges[4] and binEdges[5]
// binEdges[4] = 4.3009
// binEdges[5] = 4.8015 (approximately)

binIndex = 4
```

**Get Score:**
```javascript
binScore = this.scores[4][4]
// binScore = -0.0330
```

**Store:**
```javascript
binScores['annual_inc'] = -0.0330
```

---

#### **Example C: Categorical Feature - `term`**

**Iteration j=1:**

```javascript
j = 1
curFeatureName = 'term'
curFeatureType = 'categorical'
curFeature = 1  // Encoded from '36 months'
```

**Bin Edges (category IDs):**
```javascript
this.binEdges[1] = [1, 2]
// 1 = '36 months'
// 2 = '60 months'
```

**Bin Scores:**
```javascript
this.scores[1] = [
  0.2201,   // Score for '36 months' (ID 1)
  -0.1337   // Score for '60 months' (ID 2)
]
```

**Find Bin:**
```javascript
binIndex = this.binEdges[1].indexOf(1)
// Searches [1, 2] for value 1
// Returns: 0 (first position)
```

**Get Score:**
```javascript
binScore = this.scores[1][0]
// binScore = 0.2201
```

**Store:**
```javascript
binScores['term'] = 0.2201
```

---

#### **All Main Effect Scores:**

After processing all 19 features:

```javascript
binScores = {
  'loan_amnt': -0.1663,
  'term': 0.2201,
  'emp_length': -0.0508,
  'home_ownership': -0.1447,
  'annual_inc': -0.0330,
  'verification_status': -0.0515,
  'purpose': -0.0018,
  'dti': -0.0281,
  'delinq_2yrs': 0.0107,
  'earliest_cr_line': -0.0059,
  'inq_last_6mths': 0.1358,
  'open_acc': -0.0227,
  'pub_rec': 0.0157,
  'revol_bal': 0.0050,
  'revol_util': 0.0060,
  'total_acc': 0.0162,
  'application_type': -0.0008,
  'mort_acc': -0.0938,
  'pub_rec_bankruptcies': 0.0052,
  'fico_score': -0.1748
}
```

---

## **Step 12: Count Scores - Interaction Effects**

Interaction effects capture how two features **together** influence the prediction beyond their individual effects.

### **PART 3: Interaction Effect Scores**

**Lines 229-276:**

```javascript
for (let j = 0; j < this.interactionIndexes.length; j++) {
  let curIndexes = this.interactionIndexes[j];

  // Get names and types
  let name1 = this.featureNames[curIndexes[0]];
  let name2 = this.featureNames[curIndexes[1]];
  let type1 = this.featureTypes[curIndexes[0]];
  let type2 = this.featureTypes[curIndexes[1]];

  let value1 = encodedSample[curIndexes[0]];
  let value2 = encodedSample[curIndexes[1]];

  // Find bin indices
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
```

---

### **Interaction Model Data:**

```javascript
this.interactionIndexes = [
  [0, 13],   // loan_amnt (idx 0) x revol_bal (idx 13)
  [2, 9],    // emp_length (idx 2) x earliest_cr_line (idx 9)
  [1, 3],    // term (idx 1) x home_ownership (idx 3)
  // ... 7 more interactions
]

this.interactionBinEdges = [
  // For interaction 0: loan_amnt x revol_bal
  [
    [0, 1000, 2000, ...],      // loan_amnt bins
    [0, 0.9287, 2.1746, ...]   // revol_bal bins (log10)
  ],
  // ... more interactions
]

this.interactionScores = [
  // For interaction 0: loan_amnt x revol_bal
  [
    [-0.0144, 0.0032, ...],  // Scores for loan_amnt bin 0
    [-0.0089, 0.0045, ...],  // Scores for loan_amnt bin 1
    // ... more bins
  ],
  // ... more interactions
]
```

---

#### **Example: `loan_amnt x revol_bal` Interaction**

**Iteration j=0:**

```javascript
j = 0
curIndexes = this.interactionIndexes[0] = [0, 13]

// Feature 1: loan_amnt (index 0)
name1 = this.featureNames[0] = 'loan_amnt'
type1 = this.featureTypes[0] = 'continuous'
value1 = encodedSample[0] = 20000

// Feature 2: revol_bal (index 13)
name2 = this.featureNames[13] = 'revol_bal'
type2 = this.featureTypes[13] = 'continuous'
value2 = encodedSample[13] = 4.0414  // log10(11000)
```

**Find Bin for loan_amnt:**
```javascript
type1 = 'continuous'

binIndex1 = searchSortedLowerIndex(
  this.interactionBinEdges[0][0],
  20000
)

// this.interactionBinEdges[0][0] = [0, 1000, 2000, ..., 250000]
// Binary search for 20000
// Returns: 19
```

**Find Bin for revol_bal:**
```javascript
type2 = 'continuous'

binIndex2 = searchSortedLowerIndex(
  this.interactionBinEdges[0][1],
  4.0414
)

// this.interactionBinEdges[0][1] = [0, 0.9287, 2.1746, 2.5321, ...]
// Binary search for 4.0414
// Returns: 13 (approximately)
```

**Get Interaction Score:**
```javascript
binScore = this.interactionScores[0][19][13]

// This is a 2D lookup:
// Row 19 (loan_amnt bin)
// Column 13 (revol_bal bin)

binScore = -0.0433
```

**Store:**
```javascript
binScores['loan_amnt x revol_bal'] = -0.0433
```

**Interpretation:**
- `loan_amnt` alone contributes: -0.1663
- `revol_bal` alone contributes: 0.0050
- Their interaction contributes: -0.0433
- **Total effect:** -0.1663 + 0.0050 + (-0.0433) = -0.2046

---

#### **Example: `term x home_ownership` Interaction**

**Iteration j=6:**

```javascript
j = 6
curIndexes = [1, 3]

// Feature 1: term (index 1)
name1 = 'term'
type1 = 'categorical'
value1 = 1  // '36 months'

// Feature 2: home_ownership (index 3)
name2 = 'home_ownership'
type2 = 'categorical'
value2 = 4  // 'RENT'
```

**Find Bin for term:**
```javascript
type1 = 'categorical'

binIndex1 = this.interactionBinEdges[6][0].indexOf(1)

// this.interactionBinEdges[6][0] = [1, 2]
// indexOf(1) = 0
```

**Find Bin for home_ownership:**
```javascript
type2 = 'categorical'

binIndex2 = this.interactionBinEdges[6][1].indexOf(4)

// this.interactionBinEdges[6][1] = [1, 2, 3, 4, 5, 6]
// indexOf(4) = 3
```

**Get Score:**
```javascript
binScore = this.interactionScores[6][0][3]

// Row 0 (term = '36 months')
// Column 3 (home_ownership = 'RENT')

binScore = 0.0187
```

**Store:**
```javascript
binScores['term x home_ownership'] = 0.0187
```

---

#### **All Interaction Scores:**

After processing all 10 interactions:

```javascript
binScores = {
  // ... (main effects from before)

  // Interaction effects:
  'loan_amnt x revol_bal': -0.0433,
  'home_ownership x mort_acc': 0.0163,
  'pub_rec x revol_bal': 0.0114,
  'inq_last_6mths x fico_score': -0.0165,
  'emp_length x earliest_cr_line': -0.0159,
  'revol_bal x fico_score': -0.0014,
  'term x home_ownership': 0.0187,
  'loan_amnt x fico_score': -0.0113,
  'revol_bal x pub_rec_bankruptcies': 0.0072,
  'annual_inc x revol_bal': 0.0145
}
```

---

### **Final `binScores` Object:**

Combining main effects + interactions:

```javascript
binScores = {
  // 19 Main Effects
  'loan_amnt': -0.1663,
  'term': 0.2201,
  'emp_length': -0.0508,
  'home_ownership': -0.1447,
  'annual_inc': -0.0330,
  'verification_status': -0.0515,
  'purpose': -0.0018,
  'dti': -0.0281,
  'delinq_2yrs': 0.0107,
  'earliest_cr_line': -0.0059,
  'inq_last_6mths': 0.1358,
  'open_acc': -0.0227,
  'pub_rec': 0.0157,
  'revol_bal': 0.0050,
  'revol_util': 0.0060,
  'total_acc': 0.0162,
  'application_type': -0.0008,
  'mort_acc': -0.0938,
  'pub_rec_bankruptcies': 0.0052,
  'fico_score': -0.1748,

  // 10 Interaction Effects
  'loan_amnt x revol_bal': -0.0433,
  'home_ownership x mort_acc': 0.0163,
  'pub_rec x revol_bal': 0.0114,
  'inq_last_6mths x fico_score': -0.0165,
  'emp_length x earliest_cr_line': -0.0159,
  'revol_bal x fico_score': -0.0014,
  'term x home_ownership': 0.0187,
  'loan_amnt x fico_score': -0.0113,
  'revol_bal x pub_rec_bankruptcies': 0.0072,
  'annual_inc x revol_bal': 0.0145
}
```

**Total: 29 scores (19 main + 10 interactions)**

---

## **Step 13: Calculate Final Probability**

Now we combine everything to get the final prediction.

### **Calculation Steps:**

#### **Step 1: Sum All Feature Scores**

```javascript
sum = Object.values(binScores).reduce((a, b) => a + b)

// Main effects sum:
-0.1663 + 0.2201 + (-0.0508) + (-0.1447) + (-0.0330) +
(-0.0515) + (-0.0018) + (-0.0281) + 0.0107 + (-0.0059) +
0.1358 + (-0.0227) + 0.0157 + 0.0050 + 0.0060 +
0.0162 + (-0.0008) + (-0.0938) + 0.0052 + (-0.1748)
= -0.3595

// Interaction effects sum:
(-0.0433) + 0.0163 + 0.0114 + (-0.0165) + (-0.0159) +
(-0.0014) + 0.0187 + (-0.0113) + 0.0072 + 0.0145
= -0.0203

// Total sum:
-0.3595 + (-0.0203) = -0.3798
```

#### **Step 2: Add Intercept**

```javascript
rawScore = sum + intercept
         = -0.3798 + 0.002579
         = -0.3772
```

**Note:** Slight difference from our earlier calculation (-0.3774) due to rounding in intermediate steps.

#### **Step 3: Apply Sigmoid**

```javascript
probability = sigmoid(-0.3772)
            = 1 / (1 + exp(0.3772))
            = 1 / (1 + 1.4577)
            = 1 / 2.4577
            = 0.407
            = 40.7%
```

#### **Step 4: Determine Decision**

```javascript
decision = (probability >= 0.5) ? 1 : 0
         = (0.407 >= 0.5) ? 1 : 0
         = false ? 1 : 0
         = 0

// 0 = Rejected
// 1 = Approved
```

---

## **Step 14: Display Results**

### **Where:** `gamcoach-ui/src/components/check-modal/CheckModal.svelte`, lines 191-198, 280-298

### **Store Results:**

**Lines 191-198:**
```javascript
predictionResult = {
  prediction: prediction,     // 0
  probability: probability,   // 0.407
  rawScore: rawScore,        // -0.3772
  decision: prediction === 1 ? 'Approved' : 'Rejected'  // 'Rejected'
};

showResult = true;  // Triggers UI to display
```

### **Render Results:**

**Lines 280-298:**
```svelte
{#if showResult && predictionResult}
  <div
    class="result-panel"
    class:approved={predictionResult.prediction === 1}
    class:rejected={predictionResult.prediction === 0}
  >
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

### **Rendered HTML:**

```html
<div class="result-panel rejected">
  <div class="result-header">Prediction Result</div>

  <div class="result-content">
    <div class="result-decision">
      <span class="label">Decision:</span>
      <span class="value decision-text">Rejected</span>
    </div>

    <div class="result-probability">
      <span class="label">Probability:</span>
      <span class="value">40.7%</span>
    </div>

    <div class="result-score">
      <span class="label">Raw Score:</span>
      <span class="value">-0.377</span>
    </div>
  </div>
</div>
```

### **What User Sees:**

```
┌─────────────────────────────────┐
│     Prediction Result           │
│                                 │
│  Decision:     Rejected         │
│  Probability:  40.7%            │
│  Raw Score:    -0.377           │
└─────────────────────────────────┘
```

**CSS Styling:**
- `.rejected` class applies red/negative styling
- `.approved` class would apply green/positive styling

---

## **Complete Flow Summary**

### **Input → Output Trace:**

```
1. User Input (Form):
   loan_amnt: 20000
   term: 1 (ID)
   annual_inc: 61000 (raw)
   revol_bal: 11000 (raw)
   ...

2. Sample Array (Transformed):
   [20000, '36 months', ..., 4.7853, ..., 4.0414, ..., 677]
   ↓
   Categorical: ID → String
   Continuous: Apply log10 if needed

3. Encode for Lookup:
   [20000, 1, ..., 4.7853, ..., 4.0414, ..., 677]
   ↓
   Categorical: String → ID
   Continuous: Unchanged

4. Bin Lookups:
   loan_amnt (20000) → Bin 19 → Score: -0.1663
   term (1) → Bin 0 → Score: 0.2201
   annual_inc (4.7853) → Bin 4 → Score: -0.0330
   ...
   loan_amnt x revol_bal → Bin[19][13] → Score: -0.0433
   ...

5. Sum Scores:
   Main: -0.3595
   Interactions: -0.0203
   Intercept: +0.0026
   ─────────────────
   Total: -0.3772

6. Apply Sigmoid:
   probability = 1 / (1 + e^0.3772)
              = 0.407
              = 40.7%

7. Determine Decision:
   40.7% < 50% → REJECTED

8. Display to User:
   Decision: Rejected
   Probability: 40.7%
   Raw Score: -0.377
```

---

## **Key Concepts Recap**

### **1. Generalized Additive Model (GAM)**
- Prediction = Sum of individual feature contributions
- Each feature has its own score based on its value
- No cross-feature multiplication (except interactions)

### **2. Feature Binning**
- Continuous features divided into bins (ranges)
- Each bin has a pre-computed score
- Binary search finds which bin a value falls into

### **3. Categorical Encoding**
- Three representations:
  - **Form**: Integer ID (for dropdown value)
  - **EBM Input**: String label (for compatibility)
  - **Bin Lookup**: Integer ID (for indexing)

### **4. Log Transformations**
- Applied to `annual_inc` and `revol_bal`
- Transforms: 61000 → 4.7853
- Makes binning more meaningful
- Model trained on log-scale

### **5. Interaction Effects**
- Capture non-additive relationships
- 2D lookup: feature1_bin x feature2_bin
- Adds nuance beyond main effects

### **6. Sigmoid Function**
- Converts log-odds to probability
- Range: (-∞, +∞) → (0, 1)
- Formula: σ(x) = 1 / (1 + e^-x)

### **7. Decision Threshold**
- Default: 50%
- probability ≥ 0.5 → Approved
- probability < 0.5 → Rejected

---

## **Files Involved**

1. **`CoachPanel.svelte`** - Triggers modal open
2. **`CheckModal.svelte`** - Form UI and orchestration
3. **`store.js`** - Svelte store for modal state
4. **`gamcoach.js`** - EBM prediction engine
5. **`lc-classifier.json`** - Model data (bins, scores)

---

## **Debugging Tips**

### **Browser Console Output:**

When you click Check, open Developer Tools (F12) to see:

```
=== CheckModal Prediction ===
Input values by feature:
  Loan Amount: 20000
  Payment Period: 36 months (ID: 1, Encoded: "36 months")
  Employment Length: 10+ years (ID: 2, Encoded: "10+ years")
  Annual Income: 61000 (log10: 4.7853)
  Revolving Balance: 11000 (log10: 4.0414)
  ...

Sample array sent to EBM: [20000, "36 months", ..., 4.7853, ..., 4.0414, ...]

Raw Score: -0.3774
Probability: 0.407
Decision: Rejected
============================
```

### **Verification:**

Compare with Python script output:
```bash
python check_prediction_v2.py
```

Should show:
```
Approval Probability:                              40.7%
PREDICTION: REJECTED
```

---

## **End of Walkthrough**

You now have a complete understanding of:
- ✅ Form initialization and rendering
- ✅ Data transformation pipeline
- ✅ EBM scoring mechanism
- ✅ Probability calculation
- ✅ Result display

**Total Process:** 14 steps from button click to result display!
