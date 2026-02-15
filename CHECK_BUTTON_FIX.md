# Check Button Fix - Log Transform Support

## Problem
The Check button in GAM Coach was not applying log10 transformations to continuous features (`annual_inc` and `revol_bal`), resulting in incorrect predictions.

## Solution
Updated `CheckModal.svelte` to apply log10 transformations when building the sample array for prediction.

## Changes Made

### File: `gamcoach-ui/src/components/check-modal/CheckModal.svelte`

**Lines 123-154:** Modified the `handleCheck()` function to apply transformations

```javascript
const sample = ebm.featureNames.map((name, index) => {
  const value = featureValues[name];

  if (ebm.featureTypes[index] === 'categorical') {
    // Convert numeric IDs to label strings
    const labelDecoder = modelData.labelEncoder[name];
    if (labelDecoder && labelDecoder[value] !== undefined) {
      return labelDecoder[value];
    }
    return value;
  } else {
    // NEW: Check if this continuous feature uses a transformation
    const feature = modelData.features.find(f => f.name === name);
    const transform = feature?.config?.usesTransform;

    if (transform === 'log10') {
      // Apply log10 transformation
      return value > 0 ? Math.log10(value) : 0;
    }

    return value;
  }
});
```

**Lines 156-179:** Enhanced debug logging to show transformed values

```javascript
console.log('Input values by feature:');
ebm.featureNames.forEach((name, i) => {
  const feature = modelData?.features.find(f => f.name === name);
  const displayName = feature?.description?.displayName || name;
  const value = featureValues[name];

  if (ebm.featureTypes[i] === 'categorical') {
    const levelDesc = feature?.description?.levelDescription || {};
    const displayValue = levelDesc[value]?.displayName || value;
    const encodedValue = sample[i];
    console.log(`  ${displayName}: ${displayValue} (ID: ${value}, Encoded: "${encodedValue}")`);
  } else {
    const transform = feature?.config?.usesTransform;
    if (transform === 'log10') {
      // NEW: Show both original and transformed values
      console.log(`  ${displayName}: ${value} (log10: ${sample[i].toFixed(4)})`);
    } else {
      console.log(`  ${displayName}: ${value}`);
    }
  }
});
```

## Features Affected

The following features use log10 transformation in the LC (Lending Club) classifier:
- `annual_inc` - Annual Income
- `revol_bal` - Revolving Balance

## Testing

To test the fix, you need to rebuild the UI:

```bash
cd gamcoach-ui
npm install
npm run build
```

Then open the GAM Coach application and:

1. Click the **Check** button (circled in blue in the UI)
2. Enter the test values:
   - Loan Amount: 20000
   - Term: 36 months
   - Employment Length: 10+ years
   - Home Ownership: RENT
   - Annual Income: 61000
   - Verification Status: Source Verified
   - Purpose: debt_consolidation
   - Debt to Income Ratio: 20.47
   - Number of Past Due: 0
   - Credit History Length: 16
   - Number of Credit Inquiries: 0
   - Number of Open Accounts: 11
   - Number of Derogatory Records: 0
   - Revolving Balance: 11000
   - Credit Utilization: 57.7
   - Number of Accounts: 21
   - Application Type: Individual
   - Number of Mortgages: 0
   - Number of Bankruptcies: 0
   - FICO Score: 677

3. Click the **Check** button to see the prediction

## Expected Results

**BEFORE the fix:**
- Approval Probability: ~30.5% or ~58.9% (incorrect)
- Decision: Varies (incorrect)

**AFTER the fix:**
- Raw Score (log-odds): -0.3774
- Approval Probability: **40.7%**
- Decision: **REJECTED**

You can verify in the browser console (F12) that the log10 transformations are applied:
- `Annual Income: 61000 (log10: 4.7853)`
- `Revolving Balance: 11000 (log10: 4.0414)`

## Python Verification Script

A Python script `check_prediction_v2.py` has been created to independently verify the predictions. Run it with:

```bash
python check_prediction_v2.py
```

This should output the same probability (40.7%) as the Check button in the UI.

## Notes

- The fix ensures consistency between the UI Check button and the Python EBM model
- The transformation is applied at prediction time, not when displaying the input values
- The debug console logs show both original and transformed values for verification
- This fix only affects the Check modal; the main GAM Coach functionality was already handling transformations correctly via the EBM class in `gamcoach.js`
