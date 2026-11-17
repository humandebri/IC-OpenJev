#!/usr/bin/env python3
"""Diagnostic only: cost-order understanding at two and four candidate slots."""
import hashlib
import itertools
import json
import subprocess
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'artifacts/tetris-jev-search'
p = subprocess.Popen([str(ROOT / 'target/release/tetris_probe'), str(ROOT)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
rows = []
try:
    for values in [(0, 1), (0, 2), (0, 8), (0, 20), (0, 28), (0, 31), (0, 38), (0, 64), (0, 1, 2, 3), (0, 2, 8, 20), (0, 1, 10, 100), (0, 0), (0, 0, 0, 0), (0, 0, 0, 1), (0, 0, 1, 1), (0, 1, 1, 1), (0, 1, 1, 2)]:
        for order in sorted(set(itertools.permutations(values))):
            request = dict(text='Min cost', labels=[f'cost {v}' for v in order], infer=True)
            p.stdin.write(json.dumps(request) + '\n')
            p.stdin.flush()
            reply = json.loads(p.stdout.readline())
            rows.append(dict(costs=order, selected=reply['selected'], selected_cost=order[reply['selected']], repeated_costs=len(set(order))<len(order), correct=order[reply['selected']] == min(order), scores=reply['scores'], tokens=reply['tokens']))
finally:
    p.stdin.close()
    p.wait()
summary = {str(n): dict(cases=sum(len(r['costs']) == n for r in rows), correct=sum(r['correct'] for r in rows if len(r['costs']) == n)) for n in (2, 4)}
summary['repeated_costs'] = {str(n): dict(cases=sum(len(r['costs']) == n and r['repeated_costs'] for r in rows), correct=sum(r['correct'] for r in rows if len(r['costs']) == n and r['repeated_costs'])) for n in (2, 4)}
(OUT / 'cost-probe.json').write_text(json.dumps(dict(summary=summary, rows=rows, probe_sha256=hashlib.sha256((ROOT / 'target/release/tetris_probe').read_bytes()).hexdigest(), note='Correlated synthetic order probes, not independent gameplay trials or a held-out policy selection set.'), indent=2) + '\n')
print(summary)
