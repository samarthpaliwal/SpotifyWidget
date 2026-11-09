# Dev helper: set one boolean/string setting in the widget's settings.json.
# Usage: python3 scripts/set-setting.py lyrics true
import json, os, sys
p = os.path.expanduser('~/Library/Application Support/SpotifyWidget/settings.json')
d = json.load(open(p)) if os.path.exists(p) else {}
k, v = sys.argv[1], sys.argv[2]
d[k] = {'true': True, 'false': False}.get(v, v)
json.dump(d, open(p, 'w'), indent=2)
print(p, '->', k, '=', d[k])
