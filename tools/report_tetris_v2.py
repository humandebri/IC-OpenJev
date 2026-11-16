"""Paired held-out analysis. This script never fits or selects a policy."""
import hashlib
import json
import os
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('TETRIS_V2_DIR', ROOT / 'artifacts/tetris-lgbm-v2'))

def read(name):
    return json.loads((OUT / name).read_text())

def digest(name):
    return hashlib.sha256((OUT / name).read_bytes()).hexdigest()

def main():
    summary, protocol, audit = read('test-summary.json'), read('test-protocol.json'), read('test-audit.json')
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    assert read('selection-final.json')['analysis_source_sha256'] == source_hash, 'analysis changed after final selection'
    assert summary['complete'] and summary['authoritative'] and audit['passed']
    assert audit['summary_sha256'] == digest('test-summary.json')
    seeds = protocol['seeds']
    grouped = {(g['spec'], g['seed']): g for g in summary['games']}
    rng = np.random.default_rng(1729)
    indices = rng.integers(0, len(seeds), size=(20000, len(seeds)))
    values = lambda policy, key: np.array([grouped[policy, s][key] for s in seeds], dtype=float)
    def interval(v):
        return np.quantile(v[indices].mean(axis=1), [.025, .975]).tolist()
    comparisons = []
    for mode in ('jev', 'eval'):
        baseline = values(f'fixed-{mode}', 'lines')
        for family in ('v1', 'v2'):
            lines = values(f'{family}-{mode}', 'lines')
            differences = lines - baseline
            comparisons.append(dict(policy=f'{family}-{mode}', baseline=f'fixed-{mode}',
                mean_difference=float(differences.mean()), paired_95_ci=interval(differences),
                relative_gain=float(lines.mean() / baseline.mean() - 1),
                mean_survival_difference=float((values(f'{family}-{mode}','pieces')-values(f'fixed-{mode}','pieces')).mean()),
                survival_paired_95_ci=interval(values(f'{family}-{mode}','pieces')-values(f'fixed-{mode}','pieces')),
                mean_128_lines_difference=float((values(f'{family}-{mode}','lines128')-values(f'fixed-{mode}','lines128')).mean()),
                lines128_paired_95_ci=interval(values(f'{family}-{mode}','lines128')-values(f'fixed-{mode}','lines128')),
                survival128_paired_95_ci=interval(values(f'{family}-{mode}','pieces128')-values(f'fixed-{mode}','pieces128')),
                noninferiority_5pct_margin_ci=interval(lines - .95 * baseline)))
    contributions = []
    for family in ('fixed', 'v1', 'v2'):
        difference = values(f'{family}-jev', 'lines') - values(f'{family}-eval', 'lines')
        contributions.append(dict(family=family, mean_difference=float(difference.mean()), paired_95_ci=interval(difference)))
    random_difference = values('v2-jev', 'lines') - values('v2-random', 'lines')
    gain = next(c for c in comparisons if c['policy'] == 'v2-jev')
    control = next(c for c in comparisons if c['policy'] == 'v2-eval')
    performance = dict(mean_512_gain_at_least_10pct=gain['relative_gain'] >= .10,
        paired_512_difference_ci_positive=gain['paired_95_ci'][0] > 0,
        mean_survival_not_worse=values('v2-jev','pieces').mean() >= values('fixed-jev','pieces').mean(),
        mean_128_lines_not_worse=values('v2-jev','lines128').mean() >= values('fixed-jev','lines128').mean(),
        mean_128_survival_not_worse=values('v2-jev','pieces128').mean() >= values('fixed-jev','pieces128').mean(),
        evaluator_5pct_noninferior=control['noninferiority_5pct_margin_ci'][0] >= 0,
        query_errors_zero=summary['query_error_free'],input_41_tokens=audit['max_tokens'] <= 41,
        model_instructions_below_5B=int(audit['max_instructions']) < 5_000_000_000)
    result = dict(complete=True,analysis_source_sha256=source_hash,performance_passed=all(performance.values()),criteria=performance,
        bootstrap=dict(seed=1729,resamples=20000,unit='paired game seed',interval='percentile 95%'),
        comparisons=comparisons,jev_contributions=contributions,
        jev_vs_random_same_candidate_rule=dict(mean_difference=float(random_difference.mean()),paired_95_ci=interval(random_difference)),
        metrics=summary['metrics'],
        artifacts={name:digest(name) for name in ('test-summary.json','test-protocol.json','test-audit.json','selection-final.json')},
        adoption='Pending browser latency, bundle size, UI and build gates; keep experimental until every gate passes')
    (OUT / 'test-report.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__ == '__main__':
    main()
