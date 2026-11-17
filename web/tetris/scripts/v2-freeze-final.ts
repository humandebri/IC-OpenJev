import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,copyFileSync} from 'node:fs';
import {ROOT,OUT,read,atomic,freeze,sha,now} from './v2-common';
import {validateBundle,type ValueBundle} from '../src/placement-value-v2';
import type {Spec} from './v2-study-core';
process.chdir(ROOT);const round=existsSync(`${OUT}/selection-extra.json`)?'extra':'initial';
const selected=read(`${OUT}/selection-${round}.json`),summary=read(`${OUT}/${selected.stage}-summary.json`),trained=read(`${OUT}/training-${round}.json`);
assert(selected.validation_complete&&summary.complete&&summary.authoritative&&summary.query_error_free&&summary.http_query_per_turn);
const spec=selected.spec as Spec,bytes=readFileSync(spec.bundle!);assert.equal(sha(bytes),spec.bundle_sha256);
const model=JSON.parse(bytes.toString()) as ValueBundle;validateBundle(model);
assert(read(`${OUT}/prediction-parity-${model.metadata.round}.json`).passed);
const browser=read(`${OUT}/browser-bench-${model.metadata.round}.json`),latency=browser.models.find((m:any)=>m.sha256===spec.bundle_sha256);assert(latency?.eligible);
for(const [path,hash] of Object.entries(browser.source_hashes))assert.equal(sha(readFileSync(`${ROOT}/${path}`)),hash);
const counterfactual={sampling:'up to 8 equally spaced midpoint states per game, before conditioning on disagreement',horizon:32,rollouts:8,teacher:'fixed two-ply',source_sha256:sha(readFileSync(`${ROOT}/web/tetris/scripts/v2-counterfactual.ts`))};
freeze(`${OUT}/counterfactual-protocol.json`,counterfactual);
const final={...selected,chosen_round:round,validation_summary_sha256:sha(readFileSync(`${OUT}/${selected.stage}-summary.json`)),browser_evidence_sha256:sha(readFileSync(`${OUT}/browser-bench-${model.metadata.round}.json`)),
 source_sha256:sha(readFileSync(import.meta.filename)),analysis_source_sha256:sha(readFileSync(`${ROOT}/tools/report_tetris_v2.py`)),counterfactual_protocol_sha256:sha(JSON.stringify(counterfactual)),frozen_before_heldout:true};
freeze(`${OUT}/selection-final.json`,final);
const data=read(`${OUT}/data-protocol.json`),training=read(`${OUT}/training-${model.metadata.round}.json`);
assert.equal(sha(readFileSync(`${ROOT}/models/verdict-pack/model.bin`)),data.checkpoint_sha256);
assert.equal(sha(readFileSync(`${ROOT}/models/verdict-151m/tokenizer.json`)),data.tokenizer_sha256);
const fixturePath=`${OUT}/model-candidates/${model.metadata.round}/${model.metadata.id}-predictions.json`;
copyFileSync(fixturePath,`${OUT}/selected-predictions.json`);
model.alpha=spec.alpha!;model.beta=spec.beta!;model.metadata={...model.metadata,selection_bundle_sha256:spec.bundle_sha256,selection_final_sha256:sha(readFileSync(`${OUT}/selection-final.json`)),browser_p95_ms:latency.p95_ms,
 training_conditions:{residual_objective:'regression',risk_objective:'cross_entropy',max_trees:600,early_stopping_rounds:50,horizon:32,rollouts:8,teacher:'fixed-two-ply',feature_version:model.geometry?'board-268-v2':'summary-68-v2'},
 hashes:{checkpoint:data.checkpoint_sha256,tokenizer:data.tokenizer_sha256,model_digest:data.model_digest,data_protocol:sha(JSON.stringify(data)),seed_manifest:sha(JSON.stringify(data.seeds)),training_source:training.source_sha256,training_protocol:sha(readFileSync(`${OUT}/training-protocol-${model.metadata.round}.json`)),python_prediction_fixture:sha(readFileSync(fixturePath))}};
const asset=Buffer.from(JSON.stringify(model)+'\n');assert(asset.length<=8*1024*1024);const assetPath=`${ROOT}/web/tetris/public/tetris-value-v2.json`;
if(existsSync(assetPath))assert.equal(sha(readFileSync(assetPath)),sha(asset));else writeFileSync(assetPath,asset);
freeze(`${ROOT}/web/tetris/public/tetris-value-v2-manifest.json`,{version:2,sha256:sha(asset),bytes:asset.length,feature_version:model.geometry?'board-268-v2':'summary-68-v2',selection_final_sha256:sha(readFileSync(`${OUT}/selection-final.json`))});
const budget=read(`${OUT}/budget.json`);if(!budget.final_started_ms){budget.final_started_ms=now();budget.final_deadline_ms=Math.min(now()+4*3600_000,budget.overall_deadline_ms);atomic(`${OUT}/budget.json`,budget);}
console.log({round,spec,asset_bytes:asset.length,browser_p95_ms:latency.p95_ms,final_deadline_ms:budget.final_deadline_ms});
