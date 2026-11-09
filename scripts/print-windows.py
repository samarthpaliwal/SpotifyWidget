import json, sys
for w in json.load(sys.stdin):
    print(w['owner'], '|', w.get('name'), '|', w['layer'], '|', w['b'])
