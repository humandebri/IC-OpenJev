# Jev-assisted Tetris policy search (2026-11-16)

This study asks whether gameplay can improve while the unchanged 151M Jev model
still makes the final placement choice. It does not retrain Jev, deploy a canister,
change the current application's default, or override the model with a heuristic.
The candidate policies are implemented in `web/tetris/scripts/jev-policy.ts`.

## Fixed experimental conditions

- The same browser placement rules, seeded seven-bag, 128-piece cap, public NEXT,
  and fixed two-ply evaluation are used throughout. No hidden future is provided.
- Every model policy makes one logical model decision per placed piece, including
  genuine one-placement states. If at least two safe, distinct resulting boards
  exist, at least two remain offered. Exact descriptions may still coincide.
- Model outputs are applied unchanged. Query failures stop the experiment; there
  is no heuristic fallback or post-response quality filter.
- Inputs stay at or below 41 tokens and actual model execution below 5B reported
  instructions. The native screen is diagnostic; final games use actual queries
  against the pinned compatibility Wasm on disposable PocketIC 15.
- Identical offline-study requests may share validated replies. Logical decision
  counts are reported separately from distinct actual queries. This is not a
  cold-cache latency or aggregate inference-cost benchmark.

## Candidate and input search

Sixteen configurations were fixed before screening: current reserved-extrema
four candidates, the prior learned variant, best 2/3/4 by two-ply score, score-band
and Pareto variants, canonical/quality/reversed orders, relative feature labels,
scalar relative costs, and numeric feature labels. Geometry-equivalent results
are removed by occupancy; equal-feature but different boards remain available.

The `top2` policy keeps the two highest-scoring safe placements, breaking score
ties by canonical placement order. It offers them in canonical order and retains
the existing `Min holes` / relative holes-height-missed description. `top2-cost`
uses the same placements and order, but offers `cost N` under `Min cost`, where
`N = maximum offered search score - this candidate's score`. Thus the cost prompt
explicitly supplies a code-computed quality signal. It measures assisted choice,
not raw-board Tetris understanding.

Development used seeds 20001–20008 (16 × 8 games). The three best non-reference
variants plus the reference were compared on seeds 20017–20024 (4 × 8 games).
Selection ranked mean lines, then survival, shorter input, and config ID. The
selected `top2` averaged 44 lines there; `top2-cost` averaged 42.5 and `pareto4` 30.
The old test seeds 30001–30032 were not used for this search.

## Two independently held-out cohorts

Round one compared selected `top2` and the current model policy on seeds
40001–40032, with same-candidate evaluator/random and full-search controls. It
averaged 34.594 versus 30.938 lines. The paired mean gain was 3.656 lines, with
95% bootstrap interval [-3.750, 10.844], so this cohort did not establish a clear
improvement. All results are retained; the policy was not retuned against them.

Because the development finalists were unstable across small seed sets, a second
confirmation was initiated after the first round's interim results. It designates
the already-fixed `top2-cost` as primary and includes the unchanged `top2` as a
secondary comparison, on new seeds 50001–50032. Both policies were defined in the
original sixteen configurations. No prompt, candidate cutoff or weight was
changed using either held-out cohort. No further confirmation rounds are planned
for this run. The second protocol records its parent development protocol.

Both cohorts report all policies on identical piece sequences within that cohort.
Audit reports include paired bootstrap intervals; the additional 97.5% intervals
allow a conservative Bonferroni view of the two primary comparisons against the
current policy. Other contrasts are diagnostic, and 32-seed results do not prove
universal superiority over an evaluator.

## A diagnosed input failure

Native diagnostic probes show why wording and arity matter. On the tested scalar
cost examples, four distinct costs were correctly minimized in all 72 order
probes; four-way cases with repeated costs were correct in 16/27. In particular,
`0,1,1,1` failed all four permutations, while `0,0,1,1` passed all six. Two-way
numeric probes were 14/17, including failures with larger gaps. These correlated,
development-informed probes are diagnostics, not independent accuracy samples.
Actual game traces include choosing cost 8 from `8,0,8,8`.

The prompt alone does not establish competent arithmetic. The final confirmation
therefore checks actual gameplay and preserves every actual model reply, including
choices below the code's preferred score.

## Reproduction and evidence

Run from the repository root with the existing Node dependencies and frozen
`target/release/tetris_probe` binary:

```sh
TETRIS_JEV_DIR=/tmp/openjev-jev-replay node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/jev-search.ts screen
TETRIS_JEV_DIR=/tmp/openjev-jev-replay node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/jev-search.ts validate
```

Start the disposable server as described in [the preceding study](TETRIS_SEARCH_EVALUATOR.md).
It writes `artifacts/tetris-search/local-target.json` and should remain running
while actual query studies execute:

```sh
TETRIS_JEV_DIR=/tmp/openjev-jev-replay node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/jev-search.ts test
TETRIS_JEV_CONFIRM_DIR=/tmp/openjev-jev-confirm-replay node --import ./web/tetris/node_modules/tsx/dist/loader.mjs web/tetris/scripts/jev-cost-confirmation.ts test
```

The supplied confirmation repeats the two fixed original development finalists;
it does not select a new policy from the second cohort. Saved protocols refuse a
mixed-source resume. Exact executed runner snapshots are retained: the final
drivers only add fresh output-directory support and remove unreachable phase
branches from the confirmation-only driver. Candidate/description logic did not
change. Use new output directories when rerunning supplied artifacts.

Large per-turn traces and raw reply caches stay local. Compact summaries retain
all game metrics and raw-file hashes. Independent Python audits replay the seven-
bag and every placement, check distinct candidate geometry and prompt features,
and bind every applied model choice to its actual query reply.

```sh
python3 tools/audit_tetris_jev_search.py
python3 tools/audit_tetris_jev_search.py artifacts/tetris-jev-confirmation
```

## Independent confirmation result

All six policies below used the same 32 seeds, 50001–50032. Jev weights were unchanged. The numeric-cost policy was the designated primary candidate for this second confirmation.

| Policy | Mean lines | Mean pieces | 128-piece cap reached | Mean model input tokens |
|---|---:|---:|---:|---:|
| Current four candidates + Jev | 32.562 | 108.500 | 53.12% | 40.88 |
| Best two + relative feature descriptions + Jev | 40.875 | 118.094 | 75.00% | 22.99 |
| Best two + numeric relative cost + Jev | 43.031 | 121.812 | 78.12% | 11.00 |
| Same two candidates, evaluator only | 45.031 | 123.688 | 84.38% | 0.00 |
| Same two candidates, uniform random | 10.219 | 60.250 | 0.00% | 0.00 |
| All legal placements, two-ply evaluation | 45.031 | 123.688 | 84.38% | 0.00 |

The primary Jev policy gained 10.469 lines on average against the current Jev policy: paired 95% bootstrap interval [4.53125, 16.4375], and 97.5% interval [3.625, 17.34375]. It won on 23 seeds and lost on 9. The 97.5% interval remains positive under the conservative two-primary-comparison view described above.

Its point estimate exceeded the relative-description two-candidate policy by 2.156 lines, but the paired 95% interval [-3.6875, 7.96875] includes zero. Thus the data support improvement over the current policy, not a clear ordering between both two-candidate variants.

The numeric-cost policy was 2.000 lines below the same-candidate evaluator on average; paired 95% interval for Jev minus evaluator was [-5.46875, 1.03125]. It is close in this sample, but this is not an equivalence or noninferiority test, and it does not demonstrate superiority over search-only play.

Jev selected a below-maximum-code-score move on 33 of 3898 decisions. All selected placements were applied as returned. 3895 of those turns had at least two different resulting boards. The three remaining one-candidate turns were genuinely constrained states, not pruning to a forced code recommendation.

The improvement is chiefly a change in the choice problem: browser code retains two high-quality placements and supplies a numeric code-derived shortfall. Jev performs a compact comparison. These results do not establish raw-board understanding or a stronger standalone Tetris model.

Independent replay passed for 192 games, 20,993 turns, and 131,948 candidate placements. 11,149 logical model choices bind to 1,446 distinct actual frozen-Wasm replies. Across all policies, maximum input was 41 tokens and maximum reported model instructions 3,650,951,823; both final runs completed with no query errors or budget violations. Jev's own primary input averaged 11.00 tokens versus 40.88 for the reference.

The study ran 128 development games, 32 validation games, and 352 held-out games across the two retained cohorts (512 games total). The first cohort remains a negative/uncertain primary confirmation; it has not been omitted from the report. No further candidate tuning or hold-out rounds were run.

Evidence: [first-round summary](../artifacts/tetris-jev-search/test-summary.json), [first-round audit](../artifacts/tetris-jev-search/audit.json), [independent confirmation](../artifacts/tetris-jev-confirmation/test-summary.json), [confirmation audit](../artifacts/tetris-jev-confirmation/audit.json), [development screening](../artifacts/tetris-jev-search/screen-summary.json), [validation](../artifacts/tetris-jev-search/validate-summary.json), and [cost diagnostic](../artifacts/tetris-jev-search/cost-probe.json).

The experimental policies and replay tools are implemented and tested. The normal application default remains the previously verified lookahead policy. No UI release, production deployment, model upload to production, or funding operation was performed.
