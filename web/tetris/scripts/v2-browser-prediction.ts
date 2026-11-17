import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {ROOT,OUT,read,atomic,sha} from './v2-common';
process.chdir(ROOT);const bytes=readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`),bundle=JSON.parse(bytes.toString()),fixtures=read(`${OUT}/selected-predictions.json`);
assert.equal(sha(readFileSync(`${OUT}/selected-predictions.json`)),bundle.metadata.hashes.python_prediction_fixture);
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();await page.route('**/__v2_prediction',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Prediction parity</title>'}));await page.goto('http://127.0.0.1:5177/__v2_prediction');
 const result=await page.evaluate(async({bundle,fixtures})=>{
  const path='/src/placement-value-v2.ts',module=await import(/* @vite-ignore */path);module.validateBundle(bundle);let error=0;
  fixtures.features.forEach((features:number[],i:number)=>{
   error=Math.max(error,Math.abs(module.forestPredict(bundle.residual,features)-fixtures.residual[i]),Math.abs(module.forestPredict(bundle.risk,features)-fixtures.risk[i]),Math.abs(module.forestPredict({...bundle.risk,link:'identity'},features)-fixtures.raw_risk[i]));
  });return {max_error:error,rows:fixtures.features.length,user_agent:navigator.userAgent};
 },{bundle,fixtures});
 assert(result.max_error<=1e-9);atomic(`${OUT}/browser-prediction-parity.json`,{passed:true,...result,asset_sha256:sha(bytes),fixture_sha256:sha(readFileSync(`${OUT}/selected-predictions.json`)),source_sha256:sha(readFileSync(import.meta.filename))});console.log(result);
}finally{await browser.close();}
