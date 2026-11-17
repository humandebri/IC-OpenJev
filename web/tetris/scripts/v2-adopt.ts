import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ROOT,OUT,read,atomic,sha,now} from './v2-common';
process.chdir(ROOT);const report=read(`${OUT}/test-report.json`),audit=read(`${OUT}/test-audit.json`),summary=read(`${OUT}/test-summary.json`),selected=read(`${OUT}/selection-final.json`),budget=read(`${OUT}/budget.json`);
const manifest=read(`${ROOT}/web/tetris/public/tetris-value-v2-manifest.json`),asset=readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`),parity=read(`${OUT}/browser-policy-parity.json`),ui=read(`${OUT}/ui/result.json`),gates=read(`${OUT}/ui/gates.json`),checks=read(`${OUT}/ui/tests-build.json`);
assert(report.complete&&summary.complete&&audit.passed);assert.equal(report.artifacts['test-summary.json'],sha(readFileSync(`${OUT}/test-summary.json`)));assert.equal(audit.summary_sha256,sha(readFileSync(`${OUT}/test-summary.json`)));
assert.equal(report.analysis_source_sha256,selected.analysis_source_sha256);assert.equal(report.analysis_source_sha256,sha(readFileSync(`${ROOT}/tools/report_tetris_v2.py`)));
assert.equal(selected.browser_evidence_sha256,sha(readFileSync(`${OUT}/browser-bench-${JSON.parse(asset.toString()).metadata.round}.json`)));
for(const evidence of [gates,checks])for(const [path,hash] of Object.entries(evidence.source_hashes))assert.equal(sha(readFileSync(`${ROOT}/${path}`)),hash,`Frontend source changed: ${path}`);
const criteria={...report.criteria,one_http_query_per_turn:summary.http_query_per_turn&&audit.http_queries===summary.logical_model_turns,
 bundle_at_most_8MiB:asset.length<=8*1024*1024&&asset.length===manifest.bytes&&sha(asset)===manifest.sha256,
 browser_p95_at_most_50ms:JSON.parse(asset.toString()).metadata.browser_p95_ms<=50,
 browser_policy_parity:parity.passed&&parity.asset_sha256===manifest.sha256&&parity.selection_sha256===sha(readFileSync(`${OUT}/selection-final.json`)),
 python_typescript_parity:read(`${OUT}/prediction-parity-${JSON.parse(asset.toString()).metadata.round}.json`).passed,
 python_browser_parity:read(`${OUT}/browser-prediction-parity.json`).passed&&read(`${OUT}/browser-prediction-parity.json`).asset_sha256===manifest.sha256,
 data_feature_audit:read(`${OUT}/data-audit.json`).passed,label_reference_audit:read(`${OUT}/label-audit.json`).passed,
 cache_and_simulation_audit:read(`${OUT}/simulation-check.json`).passed&&read(`${OUT}/simulation-check.json`).study_core_sha256===sha(readFileSync(`${ROOT}/web/tetris/scripts/v2-study-core.ts`)),
 seed_partitions_unused:read(`${OUT}/prior-seed-audit.json`).passed,
 ui_functional_and_390px:ui.passed&&ui.evaluator_hash===manifest.sha256,
 frontend_quality:gates.passed&&gates.asset_sha256===manifest.sha256,
 frontend_tests_build:checks.passed&&checks.asset_sha256===manifest.sha256,
 final_within_budget:now()<=budget.final_deadline_ms&&now()<=budget.overall_deadline_ms};
const adopted=Object.values(criteria).every(Boolean),oldRelease=read(`${ROOT}/web/tetris/src/placement-release.json`),failed=Object.entries(criteria).filter(([,v])=>!v).map(([k])=>k),default_policy=adopted?'value-v2':oldRelease.default_policy;
const result={adopted,default_policy,failed,criteria,model_sha256:manifest.sha256,model_bytes:asset.length,chosen_spec:selected.spec,performance:report.comparisons,elapsed_seconds:(now()-budget.started_ms)/1000,final_seconds:(now()-budget.final_started_ms)/1000,
 evidence:Object.fromEntries(['test-report.json','test-audit.json','selection-final.json','browser-policy-parity.json','ui/result.json','ui/gates.json','ui/tests-build.json','counterfactual-summary.json'].map(path=>[path,sha(readFileSync(`${OUT}/${path}`))])),source_sha256:sha(readFileSync(import.meta.filename))};
atomic(`${OUT}/adoption.json`,result);atomic(`${ROOT}/web/tetris/src/placement-v2-release.json`,{adopted,default_policy,reason:adopted?'Passed preregistered held-out and browser gates':`Experimental: ${failed.join(', ')}`,model_sha256:manifest.sha256,evidence_sha256:sha(readFileSync(`${OUT}/adoption.json`))});console.log(result);
