# OpenJev memory optimization

The approved implementation was deployed to the existing production canister on
2026-11-17; see [MAINNET.md](MAINNET.md#memory-optimization-upgrade-2026-11-17)
for the live verification. The sections below retain the original local
measurement and review history.

The PR tracks source, tests, compact measurement summaries, and review records.
Large raw reports and Wasm binaries remain in the deployment operator's local
artifact archive. Paths to those files below describe that archive; they are
not available in a fresh checkout. The deployed and rollback Wasm SHA-256 values
are recorded in [MAINNET.md](MAINNET.md#memory-optimization-upgrade-2026-11-17).

This change keeps the existing INT8 pack, stable offsets, numerical operations,
public Candid, authorization and billing rules. It reduces duplicate heap weights.
The original scope was local implementation and validation; no mainnet funding
or deployment was performed during measurement and review.

## Publication retry and read-only analysis

Publication can be retried independently of measurement:

```sh
bash tools/measure_memory.sh publish artifacts/memory-optimization/runs/<run-id>
```

This validates the sealed artifacts and the complete strict report, creates an
approval if needed, and publishes the adoption pointer. It requires the sealed
source files to match and does
not invoke Cargo, PocketIC, upload or inference. If an interrupted publication
already wrote `approved.json`, `resume` takes the same publication-only path.
The approval now pins the report, Wasm, manifest and summary hashes. Retrying a
sealed approval never rewrites its report, summary or marker; a matching pointer
is also left untouched. Older approvals remain supported through strict report
and summary validation without rewriting their saved marker.

`memory_compare.py <report> [--final]` is read-only by default. To save a derived
JSON summary, pass `--output <new-file>`; existing files and symlinks are refused.
It never implicitly writes beside the raw report or replaces an approved summary.

Verification: 35 regression tests pass in ordinary and optimized Python. Faults
before summary/approval/pointer replacement and after pointer commit are covered,
including publication-only recovery and repeated no-op retries. The existing
110-input, 3,300-sample real-model report was reanalyzed through the CLI with and
without `--final` and with a separate new output. All published bytes, hashes and
modification times stayed unchanged. This change touches Python/shell publication
and analysis only; Wasm builds and canister measurements were not rerun.

Evidence: `artifacts/memory-optimization/publication-safety-20261116T042146149172Z.json`.

## Real-model acceptance evidence

The public typed query, normal-build capacity and artifact-publication review
findings are corrected. The latest approved evidence is selected through
`artifacts/memory-optimization/current.json`; historical top-level files remain
unchanged. The run is `runs/20261116T023020Z-ac9f945d/`.

- Full real-model comparison: 110 inputs, 3,300 fresh nonce samples, and normal
  upgrade with no model re-upload. Token IDs, logits, probabilities and selections
  match bit-for-bit. Stable hashes remain unchanged across the samples.
- The three real Tetris requests succeed through anonymous `decide_query` on the
  source, instrumented variants and upgraded normal build. Long requests retain
  explicit query rejection status alongside their update results.
- Normal total memory: **338,536,669 B**, saving **75,735,976 B (18.28%)** against
  the fixed source baseline. Maximum normal inference instruction increase:
  **4.953861%**, within the per-input 5% limit.
- Focused checks: 25 Python gate/publication regression tests in ordinary and
  optimized Python, and five Rust runner tests passed at the time of this run.
  Current publication retry checks are described above.

During measurement, two unrelated source files were added by concurrent work.
The original publisher's exact live-tree inventory guard stopped publication;
the complete successful measurement report was preserved. The retained source
archive was then verified file-by-file and its original publisher/analyzer
performed all strict final gates and atomic publication. Model/tokenizer inputs,
all published hashes and historical artifacts were checked again. The record and
exact recovery script are in `validation.json` and `publication-recovery.py`.

The current runner distinguishes later additions from modifications/deletions
of sealed source files; a regression test covers that case. Existing sealed
source files must still match, and approved runs cannot be replayed. No mainnet
operation was performed.

## Reviewed implementation (2026-11-16)

The review found and corrected three groups of P2 issues:

1. **Read-window cache validity.** Cache keys now include the reader function as
   well as its address range. The previous key could return another reader's
   bytes. A cache entry is invalidated before any buffer mutation, so a failed
   partial read cannot leave corrupt data marked as the previous valid window.
   Both failures were reproduced before the fix and have focused regression tests.
2. **Checkpoint preservation.** Checkpoints are replaced through a temporary file
   in the same directory. Resume retains samples for every pending run, and
   restores the current run's samples before its first setup checkpoint. Previously
   setup could overwrite completed samples with empty arrays before copying them
   back, losing progress if interrupted during replay. Every requested run is now
   preflighted before the first checkpoint, so a later image mismatch cannot
   replace the original evidence.
3. **Acceptance validation.** The analyzer checks paired repeated handler counters
   and the actual normal-upgrade results, rather than trusting `passed` alone.
   Corpus, upgrade and stable-state checks remain active under `python -O`.
   Invalid counters are rejected, transient heap peaks determine eligibility,
   and measurement baselines cannot be selected as production candidates.

Review verification: 134 workspace tests passed (4 default-ignored), 17 tests with
`memory-bench` enabled, 13 analyzer tests in both ordinary and optimized Python,
and a fresh full-checkpoint comparison on all 110 inputs. The normal-build
upgrade and the separate saved-production-Wasm fixture upgrade both passed.
Public Candid and normal exports remain identical to the frozen source baseline.

The reviewed normal build uses **338,536,669 B** total memory and its maximum
forward-instruction increase is **4.944791%** against the original baseline.
Its SHA-256 is
`186527a9e07f600169502a3fae0304ac185857d31ccf44e686b764500fecfb5d`.
`artifacts/memory-optimization/selected.wasm` now contains this reviewed build.

This review reran the 110-input correctness/budget comparison and upgrade;
the earlier 3,300-sample timing experiment was rechecked with the stricter analyzer
and retained as original evidence. It was not rerun for this revised Wasm.
Review records are under `artifacts/memory-optimization/review/`, including
`validation.json`, `full.json`, and `original-evidence-rechecked.json`. Prior Wasm
artifacts remain in that directory as `selected-before-review.wasm` and
`bench-before-review.wasm`. The initial results below describe the prior build.
No mainnet operations were performed.

## Initial optimization results (2026-11-16)

| Build / stage | Total allocated memory | Allocated Wasm heap |
|---|---:|---:|
| Frozen source baseline, after workload | 414,272,645 B | 179,175,424 B |
| Instrumented resident baseline | 413,868,207 B | 178,716,672 B |
| Instrumented selected policy | 338,632,879 B | 103,481,344 B |
| Normal selected build, after upgrade and workload | **338,536,656 B** | **103,415,808 B** |

The normal build saves **75,735,989 bytes (18.28%)** against the frozen source
baseline. Its worst forward-instruction increase is **4.953834%**, at the
6-token, one-class spread input. All previously successful ordinary queries
still succeed. The instrumented policy's worst forward increase is 4.940115%,
and its initial handler-counter increase is 4.925329% against the resident
instrumented path. The paired repeated handler increase stays below 5% too.

Both instrumented variants completed 1,650 unique-nonce samples: 110 inputs,
5 repetitions in each of 3 rounds, **3,300 samples total**. Logit bits match the
frozen source for every sample. All 32 natural-request token-ID arrays match the fixed corpus in both
instrumented variants. Probability bits and selections match in the ordinary API
comparison, including after the normal-build upgrade. Stable-memory hashes are unchanged across inference, and total allocated
memory does not grow during the repetitions. Stable capacity stays 222,953,472 B.
Maximum stable read traffic is 31,948,800 B in 146 reads per inference.

The normal upgrade preserves controllers, owner/callers, pricing, the cost guard,
model identity and the existing blob. Re-warm-up succeeds without re-upload.
The saved production Wasm also passes the separate fixture upgrade/billing test.
Workspace tests: 128 passed, 4 ignored by default; the isolated billing/upgrade
and full memory comparison tests were run separately and passed. Eight acceptance
analyzer tests pass. Normal exports and public Candid match the baseline exactly;
no memory-diagnostic endpoint is exported by the normal Wasm.

Diagnostic-query per-case median round-trip ratios range from 0.938 to 0.996
relative to the resident variant (median of per-case ratios: 0.979). This is a
local observation, not a production speed claim. Per-case medians, p95 values and
query/update labels are retained in `final.summary.json`. Warm-up timings include
telemetry RPCs; do not compare an uninstrumented baseline with an instrumented
candidate as pure initialization time.

Normal Wasm SHA-256:
`b164ab964c8f2cacec611333f14239fed615ce77fbd7b6adc3ec0fcfec7d0060`.
Measurement-build SHA-256:
`07ccb495b652332de0b35e33ca92c634e780e78b3678d16bda163673bee347cd`.
`validation.json` records the final raw report hash and analyzer hash. The
measurement-time runner and analyzer copies are retained under `sources/`. The
runner additionally checks loading-policy/input fields before resuming; this
host-side validation does not change measured Wasm behavior. The final analyzer
adds rejection of repeated nonces, missing upgrade evidence and hidden memory
growth without changing the Wasm or measurement data.

## Selected implementation

The embedding's 38,684,160 INT8 bytes stay in the existing stable pack. An inference
reads only the rows it uses, and reuses repeated rows within that inference. The
201,480 bytes of embedding row scales stay in heap. Eighteen dense matrices are
also read on demand, one whole matrix at a time, into a shared 1,769,472-byte
window. All other dense matrices stay resident to respect the instruction budget.
The selected matrix names are in `artifacts/memory-optimization/selected-names.json`.

The dense window keeps its largest initialized length: shrinking it between
matrices caused redundant zero-filling immediately before the next stable read.
The selected configuration initializes this window during warm-up, so each query
can reuse its committed capacity without paying for initial zero-filling.

Warm-up validates weights in chunks and fills resident vectors directly. Streamed
weights retain an immutable address after complete hash, weight-range and scale
validation. The chunk size is 1 MiB, selected from 64 KiB, 256 KiB and 1 MiB.
No full embedding buffer is allocated. Normalization and bias tensors use their
existing F32 representation. No quantization change or model re-upload is needed.

A normal build has a fixed loading policy. `memory-bench` enables owner-only
experimental policy switches, nonce probes, tokenization inspection and memory
telemetry. This feature must not be enabled in a production build. Its diagnostic
update methods intentionally support local, owner-only measurement independently
of the paid production inference methods.

## Measurement and acceptance

`canisters/verdict-engine/tests/memory_optimization.rs` creates new disposable
PocketIC 15 application-subnet canisters. It accepts no existing canister ID or
mainnet endpoint. Its dedicated server has an idle timeout and is reaped when the
runner exits; the library's implicit server has a 600-second hard timeout, which
is too short for the final run.

The fixed corpus contains 110 cases: 74 synthetic combinations, one vocabulary
boundary case, 32 natural requests from the existing parity corpus, and three
recorded production Tetris prompts. Synthetic lengths are 6, 14, 20, 30, 39, 40,
41, 48, 64 and 128, with 1, 2, 4 or 25 classes where valid, and repeated versus
spread token IDs. The generator seed is `0x4f50454e4a4556`. Full inputs and input/Wasm hashes
are recorded in each raw report; the final report also records implementation
source hashes.

Baseline `source` is the unchanged, rebuilt source Wasm. `legacy` uses the same
resident loader in the instrumented comparison build. The normal inference
counter is compared with `source`; the diagnostic handler counter is compared
with the fixed `legacy` path. Both comparisons must stay within 5% **for every
case**, cumulatively against their original baseline. Previously successful normal
queries must still succeed on the real application-subnet query limit. Longer
requests exercise paid updates through a local cycles proxy.

Token IDs, logit bits, probability bits and selections are compared. Invalid IDs,
corrupt weights/scales, incomplete warm-up and the native resident/streamed paths
have focused tests. Query diagnostics include stable-read calls/bytes, allocated
heap peaks, scratch capacity and phase counters. Three representative lengths
also capture detailed encoder phase traces. Stage snapshots cover upload,
tokenizer initialization, every warm-up tensor and post-inference memory.

Each diagnostic input is repeated five times in each of three rounds, using unique
nonces and alternating the order of the resident and selected canisters. Medians
and p95 values are per case. Update samples are labeled separately: their measured
round trip includes the preceding rejected query attempt. They are not query
latency measurements or production latency estimates. Handler counters stop before
JSON/Candid reply encoding; ordinary API success checks enforce the full replica
limit, including encoding.

The memory gate uses management API total memory, not just array payload sizes.
Transient query heap peaks are recorded because a query's heap growth disappears
when its snapshot is discarded. Tokenizer initialization heap growth includes
parsing temporaries and is **not** a live tokenizer-allocation count. Payload
figures exclude allocator metadata.

The last tuning steps followed the stopping rule: pre-initializing the window
allowed one extra matrix while changing the short-case total by less than 1%;
switching from 256 KiB to 1 MiB chunks then saved 458,752 bytes (about 0.14%).
A nineteenth matrix exceeded 5% even on the short witness input. After these two
consecutive sub-1% capacity improvements, the selected policy was frozen for the
full-corpus gate. The largest remaining regions are the unchanged stable pack and
reserved management area, followed by resident dense weights whose further
streaming breaches the instruction budget.

## Evidence and reproduction

Raw reports are under `artifacts/memory-optimization/`:

- `screen.json`: original resident, embedding-only, one-layer and all-matrix probes.
  The initial server expired after completing these cases; the report is retained.
- `micro-v2.json`: shorter probes after eliminating repeated buffer zero-filling.
- `partial-screen.json`: 16, 18 and 20 selected matrices; 18/20 exceed 5% without
  a pre-initialized window.
- `tuning.json`: pre-initialization, three chunk sizes, an extra matrix and full
  layer windows. Nineteen matrices and full layer streaming exceed the budget.
- `final.json` and `final.summary.json`: full-corpus comparison, timing samples,
  state checks and upgrade of the same baseline canister to the normal build.
- `legacy-upgrade-tests.log`: the saved production Wasm upgraded with a small
  fixture; caller authorization, paid execution and billing persistence pass.
- `baseline/`: immutable original source/production Wasm, Candid, toolchain,
  source archive and the pre-existing user patch. The production Wasm hash is
  `337c800eaede4148f961405b936150ff5e523dd48e616ecac0a266691041a6b3`.

From the repository root, with the real pack and tokenizer present:

```sh
bash tools/measure_memory.sh final
# After an interruption: replay setup/correctness on fresh canisters, then reuse
# only already-completed samples whose corpus and Wasm hashes match.
bash tools/measure_memory.sh resume artifacts/memory-optimization/runs/<run-id>
python3 -m unittest discover -s tests -p test_memory_compare.py
cargo test --workspace
```

The script requires the frozen baseline artifacts and a PocketIC 15 executable.
It checks the supplied `POCKET_IC_BIN`, then the library's local download cache;
it does not replace the user's existing PocketIC installation. Build output honors
`CARGO_TARGET_DIR`. Model and tokenizer inputs are hash-checked during warm-up.

## Deployment handoff

Resolve `artifacts/memory-optimization/current.json` to its immutable run directory.
Use that directory’s normal `selected.wasm`, never `bench.wasm`. Before any mainnet action,
re-read the exact target's controller, module, current state and funding needs.
The intended target is `qojfj-6qaaa-aaaam-qjkaq-cai`; it remains frozen unless funded
separately. Recalculate the required reserve and recovery headroom at that time.

After separately authorizing production recovery, upgrade the existing canister;
do not reinstall, start a new upload, change stable offsets or delete data. Run
`start_warmup` and `warmup_next` to completion using the existing stored pack.
Verify the model hash, caller settings, pricing, normal queries, instruction
counts and total memory. Keep the saved previous Wasm for rollback, which also
requires warm-up. A rollback's larger heap must have sufficient cycles headroom.

The model pack and 64 MiB management region remain allocated in stable memory.
Stable and heap storage have the same per-byte storage price; savings come from
removing duplicate allocated heap. Existing stable space is not reclaimed by
this change. The memory/5% results cover this fixed checkpoint and corpus, not
all possible future models or inputs.


## Review gate corrections

The three recorded production Tetris prompts are also reconstructed as typed
`decide_query` requests. Their rendered prompts and token IDs match the raw
fixtures, and all three must succeed through the anonymous public query on the
source, diagnostic and upgraded normal builds. Reports keep `decision_query`
status separately from the update fallback used for longer requests. Both query
availability and exact decision outputs are gated independently.

Final acceptance also requires the normal-build upgrade’s management memory to
be a positive integer, below the source baseline and no more than 1 MiB above
the selected measured policy’s peak total. The upgraded Wasm hash must match
the run’s frozen normal image, and its candidate must be the best eligible policy.

`measure_memory.sh final` creates `runs/<unique-id>/`, builds into a separate Cargo
target directory under the configured target root, and freezes Wasm, Candid and
matrix selection hashes in `manifest.json`. Source hashes, a source archive,
working diff and toolchain are retained alongside the raw evidence. All images
are loaded before canister setup. Resume requires an explicit sealed run directory
and rejects source, artifact, corpus, policy or model/tokenizer changes.

Only a complete successful comparison publishes `current.json` with manifest,
report, summary and normal Wasm hashes. This single atomic pointer is the
publication boundary; failed or interrupted runs retain their evidence without
replacing the previously approved artifacts. Historical top-level artifacts and
review reports remain unchanged. No production operation is part of this runner.

Resume never rebuilds artifacts. A run interrupted before `manifest.json` was
sealed must be restarted with `final`. An approved run cannot replay
measurements: `resume` validates its sealed evidence and retries only publication.
Use `final` for a new comparison, or `publish` to retry publication of a complete
report even when interruption happened before its approval marker was saved.
