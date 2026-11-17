import {fileURLToPath} from 'node:url';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {availableParallelism} from 'node:os';
import {TRAIN_SEEDS,VALID_SEEDS,trainingRows,hash} from './placement-study-core';
import {FEATURE_NAMES} from '../src/placement-search';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const out='artifacts/tetris-search';mkdirSync(`${out}/data`,{recursive:true});
const arg=process.argv.indexOf('--seed');
if(arg>=0){
 const seed=Number(process.argv[arg+1]);writeFileSync(`${out}/data/${seed}.json`,JSON.stringify(trainingRows(seed)));process.exit(0);
}
const seeds=[...TRAIN_SEEDS,...VALID_SEEDS];let cursor=0,done=0;
await Promise.all(Array.from({length:Math.min(4,availableParallelism())},async()=>{
 while(cursor<seeds.length){
  const seed=seeds[cursor++],path=`${out}/data/${seed}.json`;
  if(!existsSync(path))await new Promise<void>((resolve,reject)=>{
   const p=spawn(process.execPath,['--import','./web/tetris/node_modules/tsx/dist/loader.mjs',import.meta.filename,'--seed',String(seed)],{stdio:'inherit'});
   p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`seed ${seed}: ${code}`)));
  });
  if(++done%8===0)console.log(`data ${done}/${seeds.length}`);
 }
}));
const generatorHashes=Object.fromEntries(['web/tetris/scripts/placement-data.ts','web/tetris/scripts/placement-study-core.ts','web/tetris/src/placement-local.ts','web/tetris/src/placement-search.ts'].map(p=>[p,hash(readFileSync(p))]));
const records=seeds.flatMap(seed=>JSON.parse(readFileSync(`${out}/data/${seed}.json`,'utf8')));
const data=JSON.stringify({feature_names:FEATURE_NAMES,train_seeds:TRAIN_SEEDS,valid_seeds:VALID_SEEDS,records});
writeFileSync(`${out}/dataset.json`,data);
writeFileSync(`${out}/dataset-summary.json`,JSON.stringify({rows:records.length,train_seeds:TRAIN_SEEDS,valid_seeds:VALID_SEEDS,feature_names:FEATURE_NAMES,sha256:hash(data),rollout_horizon:16,rollouts:4,states_per_game:4,max_candidates:8,generator_hashes:generatorHashes},null,2)+'\n');
