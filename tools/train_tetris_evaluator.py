#!/usr/bin/env python3
"""Train only on simulator returns; validation chooses tree size, never test seeds."""
import hashlib
import json
from pathlib import Path
import lightgbm as lgb
import numpy as np

root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/tetris-search'
raw = (out / 'dataset.json').read_bytes()
data = json.loads(raw)
train = [r for r in data['records'] if r['seed'] in data['train_seeds']]
valid = [r for r in data['records'] if r['seed'] in data['valid_seeds']]
assert set(data['train_seeds']).isdisjoint(data['valid_seeds'])

def matrix(rows):
    return np.asarray([r['features'] for r in rows]), np.asarray([r['target'] for r in rows])

x, y = matrix(train)
vx, vy = matrix(valid)
results = []
for leaves in (15, 31):
    params = dict(objective='regression', metric='l2', num_leaves=leaves,
                  learning_rate=0.05, min_data_in_leaf=20, seed=1729,
                  deterministic=True, force_col_wise=True, num_threads=2, verbosity=-1)
    model = lgb.train(params, lgb.Dataset(x, label=y, feature_name=data['feature_names']),
                      num_boost_round=200, valid_sets=[lgb.Dataset(vx, label=vy)],
                      callbacks=[lgb.early_stopping(20, verbose=False)])
    pred = model.predict(vx)
    mse = float(np.mean((pred - vy) ** 2))
    # Rank on actual held-out rollout returns within a board, not just MSE.
    groups = {}
    for row, value in zip(valid, pred):
        groups.setdefault((row['seed'], row['turn']), []).append((float(value), row['target']))
    selected_return = float(np.mean([max(rows, key=lambda r: r[0])[1] for rows in groups.values()]))
    path = out / f'evaluator-{leaves}.json'
    path.write_text(json.dumps(model.dump_model(), separators=(',', ':')) + '\n')
    model.save_model(str(out / f'evaluator-{leaves}.txt'))
    results.append(dict(leaves=leaves, mse=mse, selected_return=selected_return,
                        best_iteration=model.best_iteration, params=params))
best = sorted(results, key=lambda r: (-r['selected_return'], r['mse'], r['leaves']))[0]
model_raw = (out / f"evaluator-{best['leaves']}.json").read_bytes()
(out / 'evaluator.json').write_bytes(model_raw)
# Python predictions consumed by the independent TypeScript parity test.
bst = lgb.Booster(model_file=str(out / f"evaluator-{best['leaves']}.txt"))
check = np.vstack([x[:64], vx[:64], np.zeros((1, x.shape[1]))])
(out / 'prediction-fixtures.json').write_text(json.dumps(dict(features=check.tolist(), predictions=bst.predict(check).tolist())) + '\n')
summary = dict(lightgbm_version=lgb.__version__, numpy_version=np.__version__,
               dataset_sha256=hashlib.sha256(raw).hexdigest(), model_sha256=hashlib.sha256(model_raw).hexdigest(),
               train_rows=len(train), valid_rows=len(valid), feature_names=data['feature_names'],
               candidates=results, selected=best, test_used=False)
(out / 'training-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))

public = root / 'web/tetris/public'
public.mkdir(exist_ok=True)
(public / 'tetris-evaluator.json').write_bytes(model_raw)
(public / 'tetris-evaluator-manifest.json').write_text(json.dumps(dict(sha256=summary['model_sha256'], feature_names=data['feature_names'], dataset_sha256=summary['dataset_sha256']), indent=2) + '\n')
