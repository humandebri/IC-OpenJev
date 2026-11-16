import {createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
export const ROOT=resolve(import.meta.dirname,'../../..');
export const OUT=process.env.TETRIS_V2_DIR||`${ROOT}/artifacts/tetris-lgbm-v2`;
export const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
export const derive=(...parts:(string|number)[])=>createHash('sha256').update(parts.join(':')).digest().readUInt32LE(0);
export function random(seed:number){let state=seed||0x9e3779b9;return ()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};}
export const read=<T=any>(path:string):T=>JSON.parse(readFileSync(path,'utf8'));
export function atomic(path:string,value:unknown){mkdirSync(resolve(path,'..'),{recursive:true});const temp=`${path}.${process.pid}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2)+'\n');renameSync(temp,path);}
export function hashes(paths:string[]){return Object.fromEntries(paths.map(path=>[path,sha(readFileSync(`${ROOT}/${path}`))]));}
export function seedManifest(){
 const used=new Set<number>([0]);for(const [start,count] of [[10001,256],[20001,64],[30001,32],[40001,32],[50001,32]])for(let i=0;i<count;i++)used.add(start+i);
 const make=(split:string,count:number)=>Array.from({length:count},(_,i)=>{let n=0,value:number;do{value=derive('tetris-lgbm-v2',split,i,n++);}while(used.has(value));used.add(value);return value;});
 return {train:make('train',2048),data_valid:make('data-valid',256),game_valid:make('game-valid',64),extra:make('extra',256),test:make('test',128)};
}
export const DATA_SOURCES=['web/tetris/src/placement-fast.ts','web/tetris/src/placement-value-v2.ts','web/tetris/src/placement-local.ts','web/tetris/src/placement-search.ts','web/tetris/scripts/v2-common.ts','web/tetris/scripts/v2-oracle.ts','web/tetris/scripts/v2-data.ts','web/tetris/scripts/v2-data-core.ts'];
export function dataProtocol(){
 return {version:2,seeds:seedManifest(),horizon:32,rollouts:8,episode_cap:512,states_per_episode:8,candidates_per_state:8,source_mix:[.5,.25,.25],teacher:'fixed-two-ply',source_hashes:hashes(DATA_SOURCES),probe_sha256:sha(readFileSync(`${ROOT}/target/release/tetris_probe`)),checkpoint_sha256:sha(readFileSync(`${ROOT}/models/verdict-pack/model.bin`)),tokenizer_sha256:sha(readFileSync(`${ROOT}/models/verdict-151m/tokenizer.json`)),model_digest:'0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0'};
}
export function freeze(path:string,value:unknown){if(existsSync(path)&&JSON.stringify(read(path))!==JSON.stringify(value))throw new Error(`Frozen artifact mismatch: ${path}`);atomic(path,value);}
export const now=()=>Date.now();
