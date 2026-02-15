"""
Script to check loan prediction for specific input values (with interaction terms)
"""
import json
import math

def search_sorted_lower_index(sorted_edges, value):
    """Binary search to find bin index for continuous features"""
    left = 0
    right = len(sorted_edges) - 1

    while right - left > 1:
        i = left + int((right - left) / 2)

        if value > sorted_edges[i]:
            left = i
        elif value < sorted_edges[i]:
            right = i
        else:
            return i

    # Handle out of bound issues
    if value >= sorted_edges[right]:
        return right
    if value < sorted_edges[left]:
        return left

    return right - 1

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

print("="*70)
print("LOAN APPLICATION PREDICTION CHECK (with Interaction Terms)")
print("="*70)

# Get feature information
features = model_data['features']
intercept = model_data['intercept']
feature_names = model_data['featureNames']
feature_types = model_data['featureTypes']
label_encoder = model_data['labelEncoder']

print("\nInput Values:")
print("-"*70)
for key, value in input_data.items():
    print(f"  {key:25s} = {value}")

# Build encoded sample (convert categorical strings to integers and apply transforms)
encoded_sample = []
for i, feature_name in enumerate(feature_names):
    value = input_data[feature_name]
    feature_type = feature_types[i]

    if feature_type == 'categorical':
        # Find the integer encoding for this categorical value
        encoder = label_encoder[feature_name]
        encoded_value = None
        for str_id, label_str in encoder.items():
            if label_str == value:
                encoded_value = int(str_id)
                break
        if encoded_value is None:
            encoded_value = 0  # Unseen level
        encoded_sample.append(encoded_value)
    else:
        # Check if this feature uses a transformation
        feature_info = next((f for f in features if f['name'] == feature_name), None)
        transform = feature_info.get('config', {}).get('usesTransform') if feature_info else None

        if transform == 'log10':
            # Apply log10 transformation
            transformed_value = math.log10(value) if value > 0 else 0
            encoded_sample.append(transformed_value)
        else:
            encoded_sample.append(value)

# Calculate the score - Main Effects
bin_scores = {}
total_score = intercept

print(f"\nIntercept: {intercept:.6f}")
print("\n=== Main Effect Contributions ===")
print("-"*70)

for i, feature_name in enumerate(feature_names):
    # Find feature in features list
    feature_info = next((f for f in features if f['name'] == feature_name), None)
    if not feature_info:
        continue

    feature_type = feature_types[i]
    encoded_value = encoded_sample[i]
    input_value = input_data[feature_name]

    if feature_type == 'continuous':
        # Find which bin this value falls into
        bin_edges = feature_info['binEdge'][:-1]  # Skip last edge
        additive_scores = feature_info['additive']

        bin_index = search_sorted_lower_index(bin_edges, encoded_value)
        score = additive_scores[bin_index]
        bin_scores[feature_name] = score
        total_score += score
        print(f"  {feature_name:25s} = {input_value:>10} -> score: {score:>8.4f}")

    elif feature_type == 'categorical':
        additive_scores = feature_info['additive']
        bin_labels = feature_info['binLabel']

        try:
            bin_index = bin_labels.index(encoded_value)
            score = additive_scores[bin_index]
            bin_scores[feature_name] = score
            total_score += score
            print(f"  {feature_name:25s} = {input_value:>10} -> score: {score:>8.4f}")
        except ValueError:
            score = 0
            bin_scores[feature_name] = score
            print(f"  {feature_name:25s} = {input_value} -> Unseen level (score: 0)")

# Calculate Interaction Effects
print("\n=== Interaction Effect Contributions ===")
print("-"*70)

interaction_features = [f for f in features if f.get('type') == 'interaction']
for inter_feature in interaction_features:
    name1 = inter_feature['name1']
    name2 = inter_feature['name2']
    inter_name = f"{name1} x {name2}"

    # Get indices
    index1 = feature_names.index(name1)
    index2 = feature_names.index(name2)

    type1 = feature_types[index1]
    type2 = feature_types[index2]

    value1 = encoded_sample[index1]
    value2 = encoded_sample[index2]

    # Get bin edges and scores
    bin_edge1 = inter_feature['binLabel1']
    bin_edge2 = inter_feature['binLabel2']

    # Skip last edge for continuous features
    if type1 == 'continuous':
        bin_edge1 = bin_edge1[:-1]
    if type2 == 'continuous':
        bin_edge2 = bin_edge2[:-1]

    # Find bin indices
    bin_index1 = -1
    bin_index2 = -1

    if type1 == 'continuous':
        bin_index1 = search_sorted_lower_index(bin_edge1, value1)
    else:
        try:
            bin_index1 = bin_edge1.index(value1)
        except ValueError:
            bin_index1 = -1

    if type2 == 'continuous':
        bin_index2 = search_sorted_lower_index(bin_edge2, value2)
    else:
        try:
            bin_index2 = bin_edge2.index(value2)
        except ValueError:
            bin_index2 = -1

    # Get interaction score
    if bin_index1 >= 0 and bin_index2 >= 0:
        inter_score = inter_feature['additive'][bin_index1][bin_index2]
        bin_scores[inter_name] = inter_score
        total_score += inter_score
        print(f"  {inter_name:35s} -> score: {inter_score:>8.4f}")
    else:
        bin_scores[inter_name] = 0
        print(f"  {inter_name:35s} -> score: {0:>8.4f} (unseen)")

print("-"*70)
print(f"{'Total Raw Score (log-odds):':45s} {total_score:>10.4f}")

# Calculate probability using sigmoid
probability = 1 / (1 + math.exp(-total_score))
print(f"{'Approval Probability:':45s} {probability:>10.1%}")

# Make decision
decision = "APPROVED" if probability >= 0.5 else "REJECTED"
print("\n" + "="*70)
print(f"PREDICTION: {decision}")
print("="*70)
