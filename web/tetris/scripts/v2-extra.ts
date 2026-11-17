import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {ROOT,OUT,read,freeze,sha,now} from './v2-common';
process.chdir(ROOT);
const selected=read(`${OUT}/selection-initial.json`);
const bundle=read(selected.spec.bundle);bundle.alpha=selected.spec.alpha;bundle.beta=selected.spec.beta;
const output=`${OUT}/extra-collector.json`;
freeze(output,bundle);
const budget=read(`${OUT}/budget.json`);
if(Math.min(budget.data_deadline_ms,budget.training_deadline_ms)-now()<30*60_000)throw new Error('Insufficient reserved budget for optional additional collection');
freeze(`${OUT}/extra-protocol.json`,{base_protocol_sha256:sha(readFileSync(`${OUT}/data-protocol.json`)),collector_sha256:sha(JSON.stringify(bundle)),selection_sha256:sha(readFileSync(`${OUT}/selection-initial.json`)),source_sha256:sha(readFileSync(import.meta.filename))});
await new Promise<void>((resolve,reject)=>{
 const p=spawn(process.execPath,['--import',`${ROOT}/web/tetris/node_modules/tsx/dist/loader.mjs`,`${ROOT}/web/tetris/scripts/v2-data.ts`,'extra',output],{stdio:'inherit'});
 p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`Extra collection exited ${code}`)));
});
