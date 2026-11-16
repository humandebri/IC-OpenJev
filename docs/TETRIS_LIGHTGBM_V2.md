# LightGBM v2 placement experiment

This experiment changes browser assistance. The OpenJev 151M checkpoint, tokenizer, canister API, placement rules, seven-bag generator, and one model query per placement remain fixed. The research horizon is 512 placements; the browser game still stops at 128.

The ordinary-play default is controlled independently by `web/tetris/src/placement-v2-release.json`. V2 stays experimental until the held-out performance, artifact, browser latency, UI, and build gates all pass. No production deployment is part of this work.

## Value and candidates

`placement-fast.ts` uses twenty ten-bit row masks and the original normalized clockwise rotation, reachable-pose BFS, and no-kicks rules. Its results are checked against the original colored-board implementation before data generation. Only identical resulting occupancy is merged. If any current placement allows NEXT, all placements blocking NEXT are excluded. Otherwise the remaining legal placements are retained so a last move can still be queried and applied.

For every current placement, the fixed heuristic chooses the best reachable public-NEXT response. Ties retain canonical rotation, column, then row order. Let B2 be this response's board:

```text
V0             = -8 * holes(B2) - height(B2)
residual target = 10 * mean(lines over the following 32 placements) - V0
risk target     = fraction ending within those 32 placements
score           = 10 * (current clears + NEXT clears) + V0
                  + alpha * predicted residual - beta * predicted risk
```

The known two clears are excluded from the rollout target and added exactly once. The response is selected by the fixed heuristic, independently of the learned correction. If NEXT has no placement, no B2 prediction is made and fixed current-placement ordering is used.

The two highest-scoring safe, occupancy-distinct placements are offered whenever two exist. Their display order is canonical pose order. Jev receives `Min cost` and `cost N` labels, where N is the rounded nonnegative difference from the best score. Jev's validated selection is applied unchanged, including when it differs from the evaluator. One remaining placement still gets one query. A failed or invalid query leaves the browser board unchanged. Evaluator-only mode uses the same candidates and makes no query.

## Features and training

The summary version has 68 numeric features: ten column heights, ten column hole counts, nine signed adjacent height differences, ten well depths, twenty row occupancy counts, total height, bumpiness, total hole depth, row transitions, column transitions, closed empty components, maximum and total well depth, and V0. The geometry version appends 200 row-major occupancy bits, for 268 features. Hole depth sums the distance below the first occupied cell. Side walls and the bottom count as solid for transition and well features; the top is open. Closed components are four-connected empty regions with no path to the top row.

Only B2 is input. Seed, split, turn, piece identifiers, the hidden game future, and rollout identifiers are metadata, never model features. Both known pieces have already been applied to B2.

The fixed seed manifest contains 2,048 training, 256 data-validation, 64 game-validation, 256 optional extra-collection, and 128 final-test seeds. They are derived deterministically from SHA-256 in the 32-bit seed space, collision checked, and separated from prior evaluation ranges. Held-out gameplay seeds are never used for state collection or label generation.

Collection uses 50% fixed search, 25% fixed-search numeric costs plus the unchanged native Jev checkpoint, and 25% exploration among the fixed top four placements. The exploratory policy picks uniformly with probability 0.1 and otherwise uses the best placement. At most eight states per episode are sampled across height strata. At each state, up to eight candidates include the fixed top four, maximum immediate clears, a shape-distant placement, and deterministic random remaining placements.

Every sampled candidate is applied together with its fixed NEXT response. Eight independent future seven-bag streams are shared across candidates at that state. Each is continued for 32 placements by the fixed two-ply teacher. The real episode's hidden future is not used. Raw boards, seeds, response clears, rollout seeds, individual lines, survival, and end indicators are retained locally.

LightGBM 4.6.0 trains a regression residual and a `cross_entropy` risk model with fractional labels, using the [official probability-label objective](https://lightgbm.readthedocs.io/en/v4.6.0/Parameters.html#objective). Both use numeric features, learning rate 0.05, deterministic seed 1729, at most 600 trees, and 50 rounds of early stopping. The grid is summary/geometry × 31/63 leaves × minimum leaf data 50/200. Alpha is 0, 0.25, 0.5, or 1; beta is 0, 10, or 40. Alpha=beta=0 is the fixed-search control. Model selection uses game performance, not regression loss alone.

Official LightGBM [`dump_model()`](https://lightgbm.readthedocs.io/en/v4.6.0/pythonapi/lightgbm.Booster.html#lightgbm.Booster.dump_model) trees are exported as flat numeric nodes with explicit identity or sigmoid links. Missing, categorical, NaN, and nonfinite inputs are not part of this feature schema. Python and browser predictions, probability transformation, feature ordering, and extreme sigmoid inputs are checked.

## Selection and held-out rules

The first 16 game-validation seeds screen the grid using the fixed checkpoint's native inference implementation. These are screening results, not instruction-budget evidence. The top three eligible bundles are compared on all 64 game-validation seeds using one actual HTTP `decide_query` per game turn. Identical reply records may share disk storage; the authoritative transport never memoizes model calls. Each call has a unique ID and its complete validated response is bound to the request and frozen model/Wasm identities. The local replica's internal query cache is left to the replica.

The original cached-response runner is retained as a reproducible screening/preflight tool. Its summaries expose actual calls and cache hits. Its cached validation output is saved separately and cannot authorize final selection. `v2-study-live.ts` is authoritative; the final-freeze step requires its HTTP-per-turn marker.

If time permits, the provisional actual-query selection collects up to 16,384 extra rows from 256 new episodes. Their labels use the same fixed teacher, followed by one retraining round and the same 16/64 validation groups. The previous initial winner is included in the extra round's 64-seed comparison. Initial and extra dataset manifests and evidence remain separately hashed.

Before test access, `selection-final.json` freezes the bundle, coefficients, actual-query validation evidence, browser latency evidence, and analysis implementation. Then the 128 previously unused test seeds are evaluated once, on identical piece streams, for fixed/v1/v2 assistance with Jev, the three evaluators alone, and random selection from the v2 top two. Test results never feed back into tuning.

The primary endpoint is mean lines at 512 placements. The same games record their 128-placement snapshot, median lines, survival, 32/128 early-ending rates, cap rate, disagreements, and candidate-generation time. Paired percentile bootstrap intervals use the seed as the resampling unit, 20,000 resamples, and random seed 1729.

V2+Jev must gain at least 10% in mean 512-placement lines over fixed+Jev, with a positive lower 95% difference bound, and no reduction in mean survival or 128-placement performance. Evaluator-only noninferiority requires the lower paired 95% bound of `v2_lines - 0.95 * fixed_lines` to be nonnegative. Artifact size must be at most 8 MiB; candidate-generation P95 must be at most 50 ms on the recorded reference browser. Inputs must be at most 41 tokens, model instructions strictly below 5 billion, and authoritative query failures zero.

A separate preregistered counterfactual audit samples up to eight equally spaced states per Jev episode. For the same board and same two candidates it estimates Jev-minus-evaluator value with eight independent common-random 32-placement fixed-teacher rollouts. This estimates a controlled continuation, rather than attributing all browser-assistance gains to Jev.

## Budgets, artifacts, and reproduction

The run enforces a 24-hour total budget, 14 hours for data, six hours from initial training for training/selection (including optional retraining), and four hours for final evaluation/audit. At most four simulation processes run concurrently. Completed state groups are the unit of data truncation. Resumption checks source, model, data, protocol, and per-file hashes. `budget.json` retains original deadlines; restarting does not renew the budget.

Experiment output under `artifacts/tetris-lgbm-v2` stays local and is excluded from Git. The selected public bundle and its manifest are retained. Native screening and actual-query validation/final evaluation use a disposable local PocketIC canister with a pinned, previously compatible Wasm; no production canister is upgraded or funded.

The local inference target needs the saved compatible Wasm at `build/compat-model-query/verdict-engine.wasm`, the unchanged model pack, and PocketIC 15. In a separate terminal, start the disposable target and leave it running until all queries finish:

```sh
POCKET_IC_BIN=/path/to/pocket-ic-15 cargo test --offline --release -p verdict-engine --test tetris_search_local -- --ignored --nocapture
```

It writes `artifacts/tetris-search/local-target.json`. Send `stop` to that terminal to remove the disposable instance. Start the benchmark and UI servers in separate terminals; their helper reads the local target instead of hardcoding an ephemeral port:

```sh
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-serve.ts 5177
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-serve.ts 5178
```

```sh
# Install local Node dependencies first. The runners use this venv.
python3 -m venv /tmp/openjev-tetris-venv
/tmp/openjev-tetris-venv/bin/python -m pip install -r tools/requirements-tetris.txt
cargo build --offline --release -p verdict-candle --bin tetris_probe
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-physics-check.ts
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-data.ts generate
/tmp/openjev-tetris-venv/bin/python tools/train_tetris_v2.py initial
# Start the documented disposable PocketIC target and a local Vite server first.
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-run-round-live.ts initial
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-extra.ts
/tmp/openjev-tetris-venv/bin/python tools/train_tetris_v2.py extra
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-run-round-live.ts extra
# Exactly once after selection, never as an iterative tuning command:
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/v2-run-final.ts
```

Use the saved compatible Wasm and model hashes in `data-protocol.json` and each actual-query study protocol. On this Mac, the LightGBM venv uses an existing `libomp` through `DYLD_LIBRARY_PATH`; Chromium uses `PLAYWRIGHT_BROWSERS_PATH=/tmp/openjev-playwright`. These paths are environment setup, not model inputs. A fresh full regeneration should use an isolated checkout and an empty output directory via `TETRIS_V2_DIR`. Preserve the existing v2 asset/manifest before regenerating their outputs: the freeze step deliberately refuses to replace a different existing v2 asset. Keep v1 assets intact. An existing run may only resume matching artifacts; never repeat the held-out cohort for tuning.

## Ordinary-play release guards

When v2 is adopted, browser loading verifies both the fetched manifest and the model bytes against `placement-v2-release.json.model_sha256`. A self-consistent candidate manifest/model pair cannot replace the approved default. An unavailable or rejected evaluator displays its load error and blocks Start/New game for that policy before canister status or inference queries. The user can explicitly select an available alternative; an active game's frozen policy is preserved.

A fresh isolated research checkout must mark its copied v2 release as experimental before publishing new candidate assets for pre-adoption UI checks. The original held-out results and model bytes above are unchanged by these startup guards. Follow-up verification is recorded separately in `ui/release-guard-result.json` and `ui/release-guard-gate-*.json`: six asset/client unit tests plus 390px missing/network/unapproved/corrupt/approved flows, with no canister calls. The frontend suite now contains 92 passing tests.

## Discarded development attempt

A study-only cache initially returned its board key together with scalar predictions. Spreading that object into a candidate could replace the current landing with the NEXT landing. Those screening/validation results and provisional selections were invalidated before any held-out test access. Their raw evidence is archived under `invalid-cache-attempt-1` and excluded from final aggregates. Initial data generation, fixed-teacher labels, trained forests, and the uncached public browser scorer were unaffected.

The correction returns only residual/risk scalars, assigns those fields explicitly, and checks every selected current landing against the original colored-board transition. Regression tests compare cold/warm/shared caches and replay a full seeded game. Before resuming selection, 2,048 turns and 47,296 candidates across all eight models matched the original transitions and uncached scores. Model selection is rerun within the original time budgets; no budget is reset.

The final offline audit normalized JSON's serialization of signed zero. A small JSON adapter converts NumPy booleans to built-in booleans while executing the unchanged preregistered statistical source. These compatibility corrections are hashed in `audit-zero-correction.json` and `serialization-compatibility.json`. `final-completion.json` records the offline continuation after the original audit command stopped; none of the 896 held-out games was repeated.

## Results

Final held-out evaluation used 128 new seeds exactly once. Each policy used the same seeded piece sequence, with at most 512 placements. No test-based coefficient changes or additional test cohorts followed.

| Policy | Mean lines / 512 | Median lines | Mean survival | 512 cap | Mean lines / 128 |
|---|---:|---:|---:|---:|---:|
| Fixed search + Jev | 98.773 | 86.000 | 277.477 | 16.406% | 41.727 |
| Old LightGBM + Jev | 22.984 | 20.000 | 96.531 | 0.000% | 21.930 |
| New LightGBM + Jev | 203.109 | 203.000 | 512.000 | 100.000% | 49.398 |
| Fixed search only | 110.773 | 107.500 | 306.305 | 21.875% | 42.750 |
| Old LightGBM only | 24.047 | 22.000 | 99.250 | 0.000% | 23.258 |
| New LightGBM only | 202.992 | 203.000 | 512.000 | 100.000% | 49.398 |
| Random from new top two | 36.609 | 33.500 | 131.773 | 0.000% | 31.234 |

New LightGBM + Jev changed the primary endpoint by **104.336 lines (105.632%)**, paired 95% CI **[93.141, 115.360]**, relative to fixed search + Jev. Mean survival changed from 277.477 to 512.000, and 128-placement lines from 41.727 to 49.398. The evaluator-only 5% noninferiority margin interval was [87.056, 108.681].

The selected bundle is board-l63-m50, 268 features including occupancy, from the extra training round, alpha=0.5, beta=0. It uses 600/596 residual/risk trees and 4.349 MiB. The recorded reference-browser candidate-generation P95 is 5.600 ms. Bundle SHA-256: `e03c09b52ef23407038cfe84ae92549815fda45d358454d5b8c3bc98fbb445b6`.

Initial data: 141,869 rows (126,205 train, 15,664 data validation). Additional data: 16,384 rows. Final data total: 158,253. All feature rows passed independent Python accounting checks; 128 sampled rollout labels also matched the original colored-board teacher. The additional training round used the same teacher and validation groups.

The final audit replayed 896 games / 247,723 placements with the original placement and board-transition implementation. It bound 113,409 distinct per-turn HTTP query calls to their recorded responses. Authoritative query errors: zero; maximum input: 11 tokens; maximum reported model instructions: 1076891897. The transport did not reuse application-level model responses.

Jev versus the same new evaluator without Jev changed full-game lines by 0.117, paired 95% CI [-0.055, 0.297]. Jev versus random selection from the same new candidate-generation policy changed lines by 166.500, CI [163.266, 169.563]. These comparisons separate model selection from the much larger improvement in browser assistance. The same-board, same-candidate controlled rollout audit is recorded in `counterfactual-summary.json`; it uses fixed-teacher continuation and is not a measurement of full Jev continuation.

**Adoption: passed; ordinary local browser play defaults to LightGBM v2 assistance.** All preregistered performance, size, latency, query, audit, and frontend gates passed. Normal UI runs remain capped at 128 placements. Total local elapsed time was 2.73 hours; final evaluation, audit, and UI gates took 0.27 hours. There was no production deployment.

The measured results above are retained in this document. Machine-readable evidence is generated locally under `artifacts/tetris-lgbm-v2` and is excluded from Git. The selected public asset and its manifest are separate from v1.
