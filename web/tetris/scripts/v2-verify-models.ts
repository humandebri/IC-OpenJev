import {ROOT,OUT,read,atomic,sha} from './v2-common';
import {readFileSync} from 'node:fs';
import {validateBundle,forestPredict,type ValueBundle} from '../src/placement-value-v2';
process.chdir(ROOT);const round=process.argv[2]||'initial',trained=read(`${OUT}/training-${round}.json`),results=[];
for(const item of trained.models){
 const bytes=readFileSync(`${OUT}/${item.path}`);if(sha(bytes)!==item.sha256)throw new Error('Model changed');
 const bundle=JSON.parse(bytes.toString()) as ValueBundle;validateBundle(bundle);
 const fixture=read(`${OUT}/model-candidates/${round}/${item.id}-predictions.json`);let error=0;
 fixture.features.forEach((values:number[],i:number)=>{
  error=Math.max(error,Math.abs(forestPredict(bundle.residual,values)-fixture.residual[i]),Math.abs(forestPredict(bundle.risk,values)-fixture.risk[i]));
 });
 if(error>1e-9)throw new Error(`Python/TypeScript mismatch: ${item.id} ${error}`);
 results.push({id:item.id,sha256:item.sha256,rows:fixture.features.length,max_error:error,bytes:bytes.length,eligible:bytes.length<=8*1024*1024});
}
atomic(`${OUT}/prediction-parity-${round}.json`,{passed:true,models:results});console.log(results);
