#!/usr/bin/env python3
"""Train versioned residual/risk bundles; all game-based selection is separate."""
import hashlib
import json
import os
import sys
import time
from pathlib import Path
import lightgbm as lgb
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(os.environ.get('TETRIS_V2_DIR', ROOT / 'artifacts/tetris-lgbm-v2'))
ROUND = sys.argv[1] if len(sys.argv) > 1 else 'initial'

def digest(data):
    return hashlib.sha256(data).hexdigest()

def save(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, separators=(',', ':')) + '\n')
    temporary.replace(path)

def flatten(tree, nodes):
    index = len(nodes)
    nodes.append(None)
    if 'leaf_value' in tree:
        nodes[index] = [-1, tree['leaf_value'], 0, 0]
    else:
        assert tree['decision_type'] == '<='
        left, right = flatten(tree['left_child'], nodes), flatten(tree['right_child'], nodes)
        nodes[index] = [tree['split_feature'], tree['threshold'], left, right]
    return index

def export(model, link):
    dump = model.dump_model()
    assert not dump['average_output']
    trees = []
    for item in dump['tree_info']:
        nodes = []
        flatten(item['tree_structure'], nodes)
        trees.append(nodes)
    return dict(trees=trees, link=link)

def main():
    assert lgb.__version__ == '4.6.0'
    OUT.mkdir(exist_ok=True, parents=True)
    budget = json.loads((OUT / 'budget.json').read_text())
    if 'training_started_ms' not in budget:
        started = int(time.time() * 1000)
        budget.update(training_started_ms=started, training_deadline_ms=min(started + 6 * 3600000, budget['overall_deadline_ms'] - 4 * 3600000))
        save(OUT / 'budget.json', budget)
    assert time.time() * 1000 < budget['training_deadline_ms'], 'training/selection budget exhausted'
    manifest_raw = (OUT / 'dataset-manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    job = dict(dataset_sha256=digest(manifest_raw), source_sha256=digest(Path(__file__).read_bytes()),
               feature_sets=['summary', 'board'], leaves=[31, 63], min_data=[50, 200], max_trees=600, patience=50)
    job_path = OUT / f'training-protocol-{ROUND}.json'
    if job_path.exists():
        assert json.loads(job_path.read_text()) == job, 'training resume lineage mismatch'
    else:
        save(job_path, job)
    protocol = json.loads((OUT / 'data-protocol.json').read_text())
    train_set, valid_set = set(protocol['seeds']['train'] + protocol['seeds']['extra']), set(protocol['seeds']['data_valid'])
    test_set = set(protocol['seeds']['test'])
    assert train_set.isdisjoint(valid_set | test_set)
    rows = []
    for source in manifest['sources']:
        raw = (OUT / source['path']).read_bytes()
        assert digest(raw) == source['sha256'], source['path']
        part = json.loads(raw)
        assert part['protocol_sha256'] == manifest['protocol_sha256']
        # Labels must still belong to the collected state and both known clears.
        group_path = OUT / 'groups' / Path(source['path']).name
        groups = json.loads(group_path.read_text())['groups']
        lookup = {(g['turn'], c['key']): (g, c) for g in groups for c in g['candidates']}
        for row in part['rows']:
            group, candidate = lookup[row['turn'], row['key']]
            assert row['before'] == group['board'] and row['terminal'] == candidate['terminal']
            assert row['immediate_lines'] == candidate['immediate_lines'] and row['next_lines'] == candidate['next_lines']
            assert row['seed'] not in test_set
            assert len(row['outcomes']) == 8 and row['risk_target'] == sum(o['ended'] for o in row['outcomes']) / 8
            assert row['residual_target'] == 10 * row['future_lines'] - row['base']
            rows.append(row)
    train = [r for r in rows if r['seed'] in train_set]
    valid = [r for r in rows if r['seed'] in valid_set]
    assert len(train) >= 8192 and len(valid) >= 1024, 'insufficient completed groups'
    names = manifest['feature_names']
    tx = np.asarray([r['features'] for r in train], dtype=np.float32)
    vx = np.asarray([r['features'] for r in valid], dtype=np.float32)
    ty = np.asarray([r['residual_target'] for r in train])
    vy = np.asarray([r['residual_target'] for r in valid])
    tr = np.asarray([r['risk_target'] for r in train])
    vr = np.asarray([r['risk_target'] for r in valid])
    assert np.isfinite(tx).all() and np.isfinite(vx).all()
    candidates = OUT / 'model-candidates' / ROUND
    candidates.mkdir(exist_ok=True, parents=True)
    results = []
    prior_path = OUT / f'training-{ROUND}.json'
    prior = json.loads(prior_path.read_text())['models'] if prior_path.exists() else []
    for geometry in (False, True):
        width = len(names) if geometry else len(manifest['summary_feature_names'])
        for leaves in (31, 63):
            for minimum in (50, 200):
                ident = f"{'board' if geometry else 'summary'}-l{leaves}-m{minimum}"
                path = candidates / f'{ident}.json'
                if time.time() * 1000 >= budget['training_deadline_ms']:
                    break
                saved = next((v for v in prior if v['id'] == ident), None)
                if saved and path.exists() and digest(path.read_bytes()) == saved['sha256'] and (candidates / f'{ident}-predictions.json').exists():
                    results.append(saved)
                    continue
                params = dict(learning_rate=.05, num_leaves=leaves, min_data_in_leaf=minimum, seed=1729,
                              deterministic=True, force_col_wise=True, num_threads=2, verbosity=-1,
                              zero_as_missing=False, feature_pre_filter=False)
                models = []
                for objective, y, v, metric in [('regression', ty, vy, 'l2'), ('cross_entropy', tr, vr, 'cross_entropy')]:
                    model = lgb.train(dict(params, objective=objective, metric=metric),
                                      lgb.Dataset(tx[:, :width], label=y, feature_name=names[:width]),
                                      valid_sets=[lgb.Dataset(vx[:, :width], label=v)], num_boost_round=600,
                                      callbacks=[lgb.early_stopping(50, verbose=False)])
                    models.append(model)
                residual, risk = models
                prediction, probabilities = residual.predict(vx[:, :width]), risk.predict(vx[:, :width])
                metadata = dict(id=ident, round=ROUND, dataset_sha256=digest(manifest_raw),
                                data_protocol_sha256=manifest['protocol_sha256'], train_rows=len(train), valid_rows=len(valid),
                                params=params, lightgbm_version=lgb.__version__, numpy_version=np.__version__,
                                iterations=[m.best_iteration for m in models])
                bundle = dict(version=2, geometry=geometry, feature_names=names[:width],
                              residual=export(residual, 'identity'), risk=export(risk, 'sigmoid'),
                              alpha=.5, beta=10, horizon=32, metadata=metadata)
                save(path, bundle)
                check = np.vstack([tx[:64, :width], vx[:64, :width], np.zeros((1, width))])
                save(candidates / f'{ident}-predictions.json', dict(features=check.tolist(),
                         residual=residual.predict(check).tolist(), risk=risk.predict(check).tolist(), raw_risk=risk.predict(check, raw_score=True).tolist()))
                item = dict(id=ident, path=str(path.relative_to(OUT)), sha256=digest(path.read_bytes()), bytes=path.stat().st_size,
                            mse=float(np.mean((prediction - vy) ** 2)), brier=float(np.mean((probabilities - vr) ** 2)),
                            iterations=metadata['iterations'], eligible=path.stat().st_size <= 8 * 1024 * 1024)
                results.append(item)
                save(OUT / f'training-{ROUND}.json', dict(complete=len(results) == 8, dataset_sha256=digest(manifest_raw),
                     source_sha256=digest(Path(__file__).read_bytes()), train_rows=len(train), valid_rows=len(valid), models=results))
                print(json.dumps(item), flush=True)
    assert results
    save(OUT / f'training-{ROUND}.json', dict(complete=len(results) == 8, dataset_sha256=digest(manifest_raw),
         source_sha256=digest(Path(__file__).read_bytes()), train_rows=len(train), valid_rows=len(valid), models=results))

if __name__ == '__main__':
    main()
