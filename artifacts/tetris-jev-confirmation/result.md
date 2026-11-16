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
