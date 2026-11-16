# Placement search and learned evaluator

This experiment keeps the 151M INT8 OpenJev checkpoint fixed. Browser search and
LightGBM are explicitly separate assistance. Nothing here deploys to production.
The old `legacy` policy remains reproducible, including its candidate ordering,
features, prompt, physics, seven-bag and 128-placement cap.

## Browser policies

`lookahead` searches every reachable current placement and every reachable NEXT
placement with the same no-kicks clockwise placement rules. Occupancy-equivalent
resulting boards are merged in canonical placement order. Equal feature tuples
with different geometry remain distinct. If any move permits NEXT, moves that
block NEXT are excluded; otherwise all distinct current placements remain.

For each current placement, its best NEXT response maximizes
`10 * (current lines + NEXT lines) - 8 * final holes - final height`.
Ties retain canonical rotation/x/y order. Up to four candidates reserve, in order:
best search score, maximum immediate clears, minimum immediate holes, minimum
immediate height. Repeated reservations are filled by search score. Offered
candidates return to canonical placement order rather than score order.

The three-field relative prompt stays syntactically unchanged. With assistance,
`holes` and `height` describe the best NEXT landing, and `missed` measures the
shortfall in two-placement total clears. With legacy they describe the immediate
landing. No board, seed, evaluator score or undisplayed future is sent to OpenJev.
Even one candidate makes one actual model query in interactive model mode.
Failures leave the board unchanged; evaluator-only mode has no canister traffic.

`learned` uses immediate clears plus predicted subsequent clears for the ranking
reservation and recommendation. Safety filtering, feature reservations, and the
fixed-heuristic NEXT response used for descriptions remain the same. Thus the
learned evaluator does not quietly change the model's prompt vocabulary.

## Data and training

Seeds 10001–10256 train; 20001–20064 validate; 30001–30032 test. Games end at
spawn failure or 128 pieces. Behavior alternates full-legal immediate heuristic,
lookahead, and seeded random. Four evenly spaced visited states are sampled per
game (or all when fewer than four). Each state evaluates at most eight distinct
safe candidates, always including the improved four, with deterministic random
sampling of the remainder.

Features comprise 10 column heights, 10 per-column holes, 9 signed adjacent
height differences, 10 well depths (walls count as height 20), 20 row occupancies,
and seven one-hot NEXT indicators. Piece colors are ignored. Inputs contain no
seed, turn, hidden bag state, current score or undisplayed future pieces.

The regression label is mean future lines from four 16-piece rollouts after the
candidate landing, beginning with known NEXT. Later pieces come from independent
seeded seven-bags shared across alternatives. Continuation uses the frozen
lookahead policy. Immediate clears are excluded from the label and added during
ranking. Future survival is logged separately. Targets are simulated outcomes,
not imitation labels from the old heuristic score.

LightGBM 4.6.0 uses numeric regression, learning rate .05, 15 or 31 leaves, at most
200 trees and early stopping after 20 validation rounds. Tree size is chosen by
mean validation return of the highest predicted alternative per state, then MSE,
then smaller leaf count. CPU deterministic mode, RNG 1729 and two threads are
fixed. The JSON dump and numeric feature order are shipped as a static browser
asset with SHA-256 verification. Python predictions are checked independently
against the TypeScript tree interpreter before acceptance.

## Reproduce

Run from the repository root, using the existing npm installation in `web/tetris`:

```sh
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/placement-data.ts
python3 -m venv /tmp/openjev-tetris-venv
/tmp/openjev-tetris-venv/bin/pip install -r tools/requirements-tetris.txt
/tmp/openjev-tetris-venv/bin/python tools/train_tetris_evaluator.py
cargo build --release -p verdict-candle --bin tetris_probe
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/placement-token-check.ts
```

macOS LightGBM needs the OpenMP runtime (`libomp`). An existing compatible runtime
can be selected with `DYLD_LIBRARY_PATH`; this task used the local PyTorch runtime
without changing system libraries. Data generation runs up to four child
processes and resumes complete per-seed files. Delete affected generated data
before changing generation rules; do not mix versions of a dataset.

For disposable real-Wasm query evaluation, obtain PocketIC **15.0.0**, set
`POCKET_IC_BIN` to its `pocket-ic` executable and run:

```sh
POCKET_IC_BIN=/path/to/pocket-ic cargo test --release -p verdict-engine --test tetris_search_local -- --ignored --nocapture
```

The test pins the saved compatibility Wasm hash, creates an isolated application
subnet, loads the unchanged local model, warms it and writes `local-target.json`.
It never installs over an existing canister. Its owned server avoids the library's default ten-minute hard TTL; a heartbeat keeps it alive between queries. Keep the process open during the
study; enter `stop` afterward to remove its disposable instance.

```sh
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/placement-study.ts --native
node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/placement-study.ts --local --test
```

Without `--local`, use explicit `IC_HOST` and `CANISTER_ID`, or the existing public
model endpoint. Only queries are sent. `--native` is a diagnostic validation mode;
it is refused for held-out testing and cannot authorize adoption. Fixed-model
replies may be cached for identical requests in the offline study; each cached
reply is revalidated. This isolates decision quality and does not measure RTT,
cold caches or total inference cost. Interactive play never uses this study cache.

## Comparison and acceptance

Every seed runs legacy+model, lookahead+model, lookahead-only, learned+model,
learned-only and full-legal search. The latter uses the same safe two-ply score;
its best-scoring candidate is also reserved in lookahead, so it is an explicit
control rather than a claim that a wider selector must score higher.

Summaries report mean/median lines, survival, under-32-piece top-out rate,
128-piece cap rate, candidate generation time, recommendation disagreements and
score shortfall. For the first four disagreements per game, paired independent
rollouts estimate the actual line-return difference between model choice and
recommendation on the same board and candidates. These are proxy counterfactuals,
not ground-truth optimal decisions or independent full games.

On a fresh clone, use `TETRIS_STUDY_DIR=/path/to/new-output` for both study
commands to preserve the checked-in protocols and summaries. The harness uses
the shipped evaluator if that output directory has no newly trained model.
Resuming the original directory requires its exact frozen sources and raw files;
the native validation runner snapshot is retained with its protocol.

Training and validation finish before test is revealed. Protocol and source
hashes are frozen before evaluation; resume refuses changed protocols. Test data
cannot select hyperparameters. All six policies must complete all 32 test seeds.
Lookahead adoption requires nonregressing mean lines, survival and early top-out
rate against legacy. Learned adoption additionally requires at least 10% more
mean lines (strict improvement when the baseline is zero), nonregressing survival
and early top-out rate for both model and evaluator-only comparisons. Every reply
must pass identity/argmax/token/instruction validation: <=41 input tokens and
<5B measured model instructions, with no query errors or budget violations.

Only a complete authoritative test writes `placement-release.json`. Failed gates
keep learned assistance experimental; incomplete validation keeps legacy default.
The artifact, UI and query API distinguish assistance from OpenJev's contribution.
After comparison, run `python3 tools/audit_tetris_search.py` to independently
replay every test placement and verify the actual reply cache, frozen sources
and adoption configuration.

Large datasets, query cache and raw game traces stay local; committed summaries
bind them with hashes. The shipped model and Python prediction fixtures are small
reviewable artifacts. Production freezing or latency is not a statement about
local decision quality.

## UI verification

`placement-ui-check.ts` drives Chromium at 390px, switches both assistance modes,
checks that changing pending settings preserves the active game's policy, verifies
the evaluator hash and confirms zero canister calls in evaluator-only play.
The vlmkit 0.23.0 integrity/copy/scroll/handlers/interactions/breakpoints gates
are also run. The handlers gate retunes `drag-source-not-draggable` to warning:
React registers a synthetic dragstart listener on `#root` even though the app has
no drag handlers or drag feature. This root-only inventory finding is retained
in evidence; controls are separately exercised by the browser flow.

## Measured result — 2026-11-16 JST

Training used 8,179 candidate examples from 256 seeds; validation used 2,046 examples from 64 separate seeds. The selected LightGBM evaluator has 199 trees with at most 31 leaves. A separate 384-game native validation comparison was diagnostic only. No held-out results selected its parameters.

Final evaluation used the same 32 held-out piece sequences for every policy, with a 128-piece cap and actual frozen-Wasm queries on disposable PocketIC 15.

| Policy | Mean lines | Median lines | Mean pieces | Top-out before 32 | Reached 128 |
|---|---:|---:|---:|---:|---:|
| Current candidates + OpenJev | 7.938 | 6.0 | 50.781 | 6.25% | 0.00% |
| NEXT lookahead candidates + OpenJev | 27.719 | 28.0 | 97.594 | 0.00% | 37.50% |
| NEXT lookahead evaluation only | 45.656 | 49.0 | 125.531 | 0.00% | 87.50% |
| Learned candidates + OpenJev | 36.656 | 41.5 | 114.219 | 0.00% | 59.38% |
| Learned evaluation only | 26.875 | 25.0 | 100.250 | 0.00% | 31.25% |
| All legal placements + NEXT search | 45.656 | 49.0 | 125.531 | 0.00% | 87.50% |

**Adoption:** `lookahead` is the workspace default; `learned` remains experimental. Learned candidates improve the model-assisted comparison, but learned-only performance fails the required improvement over fixed NEXT evaluation. No policy or hyperparameter was changed after test results were exposed.

The fixed search control equals the offered-candidate evaluator because the global best search move is guaranteed a candidate slot. OpenJev still reduces performance against that evaluator-only control. These results show stronger assisted gameplay, not stronger standalone OpenJev board understanding.

Independent Python replay passed for all 192 games, 19,645 turns and 154,949 candidate placements. All 8,403 logical model decisions bind to 2,733 distinct actual query replies; identical requests reused these validated replies. Maximum input was 41 tokens and maximum reported model execution was 3,650,949,429 instructions. Held-out query errors and budget violations were zero. This is decision-quality evidence, not a measurement of uncached RTT or aggregate inference cost.

The shared comparison queried the frozen compatibility Wasm, SHA-256 `584657715086775ff0e785053b175c777d27261abd13029b71bc1aeeb662204e`, with the unchanged OpenJev model digest `0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0`. The native validation runner snapshot is saved with its protocol; later runner changes only add working-directory handling, output-directory selection and a persistent failure latch for adoption.

The first four recommendation disagreements per game were also checked with paired 16-piece rollouts. Across the 128 lookahead-model sampled states, the estimated line-return difference from the recommendation totaled -42.5; for learned-model it was -4.75 across 128 states. Individual positive and negative examples are retained separately. These correlated, limited-horizon estimates are not optimality labels.

The measured results above are retained in this document. Machine-readable experiment output is generated locally under `artifacts/tetris-search/` and is excluded from Git. The illustrative decisions use only the first four disagreements on the first three test seeds; regenerate them with `node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/placement-examples.ts`.

The public canister returned `IC0207` (frozen) during the read-only availability check. No production upgrade, funding or deployment was performed. Local query results do not establish current production availability.
