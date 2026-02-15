import json

data = json.load(open('gamcoach-ui/public/data/lc-classifier.json'))
print("Feature transformations:")
for f in data['features']:
    if f.get('type') == 'interaction':
        continue
    fname = f['name']
    if fname in data['featureNames']:
        idx = data['featureNames'].index(fname)
        if data['featureTypes'][idx] == 'continuous':
            transform = f.get('config', {}).get('usesTransform')
            print(f"  {fname:30s} -> {transform}")
