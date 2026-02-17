<script>
  import { onMount } from 'svelte';
  import { checkModalConfigStore } from '../../store';
  import { config } from '../../config/config';

  let component = null;
  let show = false;
  let ebm = null;
  let modelData = null;
  let featureValues = {};
  let predictionResult = null;
  let showResult = false;

  const unsubscribe = checkModalConfigStore.subscribe(value => {
    show = value.show;
    ebm = value.ebm;
    modelData = value.modelData;

    // Initialize feature values when modal opens
    if (show && ebm && modelData) {
      initializeFeatureValues();
      showResult = false;
      predictionResult = null;
    }
  });

  /**
   * Initialize feature values with defaults from the current example or reasonable defaults
   */
  const initializeFeatureValues = () => {
    featureValues = {};

    if (!ebm || !ebm.featureNames || !modelData) return;

    // Default values based on your loan application
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
      'pub_rec': 1,                // 0 time (derogatory records)
      'application_type': 1,        // Individual Application
      'mort_acc': 1,               // 0 account
      'pub_rec_bankruptcies': 1    // 0 time
    };

    ebm.featureNames.forEach((name, index) => {
      const featureType = ebm.featureTypes[index];

      if (featureType === 'continuous') {
        // Use your specific defaults if available, otherwise use 0
        featureValues[name] = reasonableDefaults[name] || 0;
      } else if (featureType === 'categorical') {
        // Use your specific categorical defaults if available
        if (categoricalDefaults[name] !== undefined) {
          featureValues[name] = categoricalDefaults[name];
        } else {
          // Otherwise use first category option
          const feature = modelData.features.find(f => f.name === name);
          if (feature && feature.binLabel && feature.binLabel.length > 0) {
            featureValues[name] = feature.binLabel[0];
          }
        }
      }
    });
  };

  /**
   * Get categorical options for a feature
   */
  const getCategoricalOptions = (featureName) => {
    if (!modelData) return [];

    const feature = modelData.features.find(f => f.name === featureName);
    if (!feature || !feature.binLabel) return [];

    // Get level descriptions if available
    const levelDescriptions = feature.description?.levelDescription || {};

    return feature.binLabel.map(value => ({
      value: value,
      label: levelDescriptions[value]?.displayName || `Option ${value}`
    }));
  };

  /**
   * Get display name for a feature
   */
  const getFeatureDisplayName = (featureName) => {
    if (!modelData) return featureName;

    const feature = modelData.features.find(f => f.name === featureName);
    return feature?.description?.displayName || featureName;
  };

  /**
   * Get description (tooltip text) for a feature
   */
  const getFeatureDescription = (featureName) => {
    if (!modelData) return '';

    const feature = modelData.features.find(f => f.name === featureName);
    return feature?.description?.description || '';
  };

  /**
   * Handle the Check button click
   */
  const handleCheck = () => {
    if (!ebm || !modelData) return;

    // Build sample array in the correct order
    // For categorical features, we need to convert numeric IDs to label strings
    // For continuous features with transforms, apply the transformation
    const sample = ebm.featureNames.map((name, index) => {
      const value = featureValues[name];

      if (ebm.featureTypes[index] === 'categorical') {
        // Get the labelEncoder for this feature
        const labelDecoder = modelData.labelEncoder[name];
        if (labelDecoder && labelDecoder[value] !== undefined) {
          // Convert numeric ID to label string (e.g., 1 -> '36 months')
          return labelDecoder[value];
        }
        return value;
      } else {
        // Check if this continuous feature uses a transformation
        const feature = modelData.features.find(f => f.name === name);
        const transform = feature?.config?.usesTransform;

        if (transform === 'log10') {
          // Apply log10 transformation
          return value > 0 ? Math.log10(value) : 0;
        }

        return value;
      }
    });

    // Debug: Log the input values
    console.log('=== CheckModal Prediction ===');
    console.log('Input values by feature:');
    ebm.featureNames.forEach((name, i) => {
      const feature = modelData?.features.find(f => f.name === name);
      const displayName = feature?.description?.displayName || name;
      const value = featureValues[name];

      // For categorical, show the label
      if (ebm.featureTypes[i] === 'categorical') {
        const levelDesc = feature?.description?.levelDescription || {};
        const displayValue = levelDesc[value]?.displayName || value;
        const encodedValue = sample[i]; // The actual value being sent to EBM
        console.log(`  ${displayName}: ${displayValue} (ID: ${value}, Encoded: "${encodedValue}")`);
      } else {
        const transform = feature?.config?.usesTransform;
        if (transform === 'log10') {
          console.log(`  ${displayName}: ${value} (log10: ${sample[i].toFixed(4)})`);
        } else {
          console.log(`  ${displayName}: ${value}`);
        }
      }
    });
    console.log('\nSample array sent to EBM:', sample);

    // Get prediction
    const rawScore = ebm.predict([sample], true)[0];
    const probability = ebm.predictProb([sample])[0];
    const prediction = probability >= 0.5 ? 1 : 0;

    console.log('Raw Score:', rawScore);
    console.log('Probability:', probability);
    console.log('Decision:', prediction === 1 ? 'Approved' : 'Rejected');
    console.log('============================');

    predictionResult = {
      prediction: prediction,
      probability: probability,
      rawScore: rawScore,
      decision: prediction === 1 ? 'Approved' : 'Rejected'
    };

    showResult = true;
  };

  /**
   * Reset form values to defaults
   */
  const handleReset = () => {
    initializeFeatureValues();
    showResult = false;
    predictionResult = null;
  };

  /**
   * Close the modal
   */
  const closeModal = () => {
    checkModalConfigStore.update(value => {
      value.show = false;
      return value;
    });
  };

  /**
   * Handle click outside modal to close
   */
  const handleBackgroundClick = (e) => {
    if (e.target === e.currentTarget) {
      closeModal();
    }
  };

  onMount(() => {
    return () => {
      unsubscribe();
    };
  });
</script>

<div class="check-modal-wrapper" class:hidden={!show}>
  <div
    class="check-modal-background"
    on:click={handleBackgroundClick}
    on:keydown={e => e.key === 'Escape' && closeModal()}
  >
    <div class="check-modal" bind:this={component}>
      <!-- Header -->
      <div class="modal-header">
        <div class="modal-title">Manual Prediction Check</div>
        <div class="close-button" on:click={closeModal}>
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path
              d="M1 1 L15 15 M15 1 L1 15"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </div>
      </div>

      <!-- Content -->
      <div class="modal-content">
        <div class="instruction">
          <strong>Review and modify values below</strong> to check the model's prediction. The form is pre-filled with sample loan application data.
        </div>

        <div class="feature-inputs">
          {#if ebm && ebm.featureNames}
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
          {/if}
        </div>

        <!-- Result Display -->
        {#if showResult && predictionResult}
          <div class="result-panel" class:approved={predictionResult.prediction === 1} class:rejected={predictionResult.prediction === 0}>
            <div class="result-header">Prediction Result</div>
            <div class="result-content">
              <div class="result-decision">
                <span class="label">Decision:</span>
                <span class="value decision-text">{predictionResult.decision}</span>
              </div>
              <div class="result-probability">
                <span class="label">Probability:</span>
                <span class="value">{(predictionResult.probability * 100).toFixed(1)}%</span>
              </div>
              <div class="result-score">
                <span class="label">Raw Score:</span>
                <span class="value">{predictionResult.rawScore.toFixed(3)}</span>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn-cancel" on:click={closeModal}>Close</button>
        <button class="btn-reset" on:click={handleReset}>Reset</button>
        <button class="btn-check" on:click={handleCheck}>Check</button>
      </div>
    </div>
  </div>
</div>

<style src="./CheckModal.scss"></style>
