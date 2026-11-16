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

Evidence: [held-out summary](../artifacts/tetris-search/test-summary.json), [native validation](../artifacts/tetris-search/validation-summary.json), [training](../artifacts/tetris-search/training-summary.json), [independent audit](../artifacts/tetris-search/audit.json), [illustrative decisions](../artifacts/tetris-search/model-examples.json), and [UI flow](../artifacts/tetris-search/ui/result.json). The examples use only the first four disagreements on the first three test seeds; regenerate them with `node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/placement-examples.ts`.

The public canister returned `IC0207` (frozen) during the read-only availability check. No production upgrade, funding or deployment was performed. Local query results do not establish current production availability.
