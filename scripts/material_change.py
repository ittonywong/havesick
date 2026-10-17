#!/usr/bin/env python3
"""Exit 0 if data/waits.json differs MATERIALLY from the committed version (git HEAD),
ignoring timestamps that change on every run. Used by the workflow to avoid a commit every 10 min.
Usage: material_change.py <old.json> <new.json>"""
import json, sys
VOLATILE = {'generated_at', 'fetched_at', 'attempted_at', 'last_success_at', 'source_updated_at', 'robots', 'http', 'next_attempt_at', 'not_modified', 'source_updated_note'}
def strip(x):
    if isinstance(x, dict): return {k: strip(v) for k, v in x.items() if k not in VOLATILE}
    if isinstance(x, list): return [strip(v) for v in x]
    return x
try:
    old = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
new = json.load(open(sys.argv[2]))
changed = strip(old) != strip(new)
print('material change' if changed else 'no material change')
sys.exit(0 if changed else 1)
