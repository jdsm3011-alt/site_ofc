from pathlib import Path
import json, unicodedata
from collections import Counter

base = Path('data')


def norm(s):
    s = (s or '').strip().lower()
    s = unicodedata.normalize('NFD', s)
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn')
    s = s.replace('-', ' ').replace('_', ' ')
    s = ' '.join(s.split())
    return s

with open(base / 'municipios.json', encoding='utf-8') as f:
    municipios = json.load(f)
with open(base / 'municipios_geom.geojson', encoding='utf-8') as f:
    geo = json.load(f)

json_names = {m['municipio'] for m in municipios}
geo_names = {feat['properties']['municipio'] for feat in geo['features']}

json_norm = {norm(m['municipio']): m['municipio'] for m in municipios}
geo_norm = {norm(feat['properties']['municipio']): feat['properties']['municipio'] for feat in geo['features']}

missing_in_json = sorted(geo_names - json_names)
missing_in_geo = sorted(json_names - geo_names)

def print_report(label, items):
    print(f'\n{label}: {len(items)}')
    for item in items[:80]:
        print(' -', item)

print('JSON entries:', len(municipios))
print('GEO entries:', len(geo['features']))
print_report('Names in geo but not in json', missing_in_json)
print_report('Names in json but not in geo', missing_in_geo)

norm_mismatches = []
for n in sorted(json_norm.keys() | geo_norm.keys()):
    if n not in json_norm or n not in geo_norm:
        norm_mismatches.append(n)

print('\nNormalized mismatches count:', len(norm_mismatches))
for n in norm_mismatches[:100]:
    print(' mismatch key:', repr(n))

for target in ['guimaraes', 'guimarães', 'sao joao da madeira', 'são joao da madeira', 'sao joao da madeira']:
    print(f'\nLookup {target!r}: json={target in json_norm} geo={target in geo_norm}')
    if target in json_norm:
        print(' json name:', json_norm[target])
    if target in geo_norm:
        print(' geo name:', geo_norm[target])
