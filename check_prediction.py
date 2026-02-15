"""
Script to check loan prediction for specific input values
"""
import json
import math

# Load the model
with open('gamcoach-ui/public/data/lc-classifier.json', 'r') as f:
    model_data = json.load(f)

# Your input data
input_data = {
    'loan_amnt': 20000,
    'term': '36 months',
    'emp_length': '10+ years',
    'home_ownership': 'RENT',
    'annual_inc': 61000,
    'verification_status': 'Source Verified',
    'purpose': 'debt_consolidation',
    'dti': 20.47,
    'delinq_2yrs': '0',
    'earliest_cr_line': 16,
    'inq_last_6mths': '0',
    'open_acc': 11,
    'pub_rec': '0',
    'revol_bal': 11000,
    'revol_util': 57.7,
    'total_acc': 21,
    'application_type': 'Individual',
    'mort_acc': '0',
    'pub_rec_bankruptcies': '0',
    'fico_score': 677
}

print("="*60)
print("LOAN APPLICATION PREDICTION CHECK")
print("="*60)

# Get feature information
features = model_data['features']
intercept = model_data['intercept']
feature_names = model_data['featureNames']
feature_types = model_data['featureTypes']

print("\nInput Values:")
print("-"*60)
for key, value in input_data.items():
    print(f"  {key:25s} = {value}")

# Calculate the score
total_score = intercept
print(f"\nIntercept: {intercept:.6f}")
print("\nFeature Contributions:")
print("-"*60)

for i, feature_name in enumerate(feature_names):
    if feature_name not in input_data:
        print(f"WARNING: {feature_name} not found in input data!")
        continue

    # Find feature in features list
    feature_info = next((f for f in features if f['name'] == feature_name), None)
    if not feature_info:
        continue

    input_value = input_data[feature_name]
    feature_type = feature_types[i]

    if feature_type == 'continuous':
        # Find which bin this value falls into
        bin_edges = feature_info['binEdge']
        additive_scores = feature_info['additive']

        # Find the appropriate bin
        bin_index = 0
        for j in range(len(bin_edges) - 1):
            if bin_edges[j] <= input_value < bin_edges[j + 1]:
                bin_index = j
                break

        score = additive_scores[bin_index]
        total_score += score
        print(f"  {feature_name:25s} = {input_value:>10} -> score: {score:>8.4f}")

    elif feature_type == 'categorical':
        # For categorical, find the matching bin label
        label_encoder = model_data['labelEncoder'][feature_name]
        additive_scores = feature_info['additive']
        bin_labels = feature_info['binLabel']

        # Find matching label ID
        label_id = None
        for str_id, label_str in label_encoder.items():
            if label_str == input_value:
                label_id = int(str_id)
                break

        if label_id is None:
            print(f"  {feature_name:25s} = {input_value} -> NOT FOUND!")
            continue

        # Find index in binLabel
        try:
            bin_index = bin_labels.index(label_id)
            score = additive_scores[bin_index]
            total_score += score
            print(f"  {feature_name:25s} = {input_value:>10} -> score: {score:>8.4f}")
        except ValueError:
            print(f"  {feature_name:25s} = {input_value} -> Bin not found!")

print("-"*60)
print(f"{'Total Raw Score:':40s} {total_score:>10.4f}")

# Calculate probability using sigmoid
probability = 1 / (1 + math.exp(-total_score))
print(f"{'Approval Probability:':40s} {probability:>10.1%}")

# Make decision
decision = "APPROVED" if probability >= 0.5 else "REJECTED"
print("\n" + "="*60)
print(f"PREDICTION: {decision}")
print("="*60)
