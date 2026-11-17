import {expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Agent,episode} from '../scripts/v2-study-core';
import {fastChoices} from './placement-fast';
import {featureNames,type ValueBundle} from './placement-value-v2';
import {prepareAssisted} from './placement-browser-v2';
import {pieceAt} from './placement-local';
it('prediction cache hits and shared models never replace the current landing with the NEXT board',()=>{
 const dir=mkdtempSync(`${tmpdir()}/tetris-v2-cache-`);
 try{
  const bundle:ValueBundle={version:2,geometry:true,feature_names:featureNames(true),residual:{trees:[[[-1,12,0,0]]],link:'identity'},risk:{trees:[[[-1,0,0,0]]],link:'sigmoid'},alpha:.5,beta:10,horizon:32,metadata:{}};
  const text=JSON.stringify(bundle),path=`${dir}/model.json`,hash=createHash('sha256').update(text).digest('hex');writeFileSync(path,text);
  const first=new Agent({id:'first',family:'v2',mode:'jev',bundle:path,bundle_sha256:hash,alpha:.5,beta:10}),second=new Agent({...first.spec,id:'second',alpha:.25});
  const board=new Uint16Array(20),reference=fastChoices(board,2,0),seed=Array.from({length:1000},(_,i)=>((i+1)*2654435761)>>>0).find(s=>pieceAt(s,0)===2&&pieceAt(s,1)===0)!;expect(seed).toBeDefined();
  for(const agent of [first,first,second,second]){
   const actual=agent.prepare(board,2,0);for(const c of actual.all){const original=reference.find(v=>v.key===c.key)!;expect(Array.from(c.board)).toEqual(Array.from(original.board));expect(Array.from(c.board)).not.toEqual(Array.from(c.next!.board));}
   const ui=prepareAssisted({id:0,seed,turn:0,mode:0,lines:0,over:false,policy:'value-v2',board:Array(200).fill(0)},{bundle:{...bundle,alpha:agent.spec.alpha!,beta:agent.spec.beta!},hash});
   expect(actual.request).toEqual(ui.request);expect(actual.offered.map(c=>Array.from(c.board))).toEqual(ui.choices.map(c=>Array.from(c.board)));expect(actual.offered.map(c=>c.score)).toEqual(ui.choices.map(c=>c.score));
   expect(actual.offered).toHaveLength(2);expect(Object.keys(agent.predict(actual.offered[0].next!.board)).sort()).toEqual(['residual','risk']);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
it('replays an entire seeded game identically after warming the shared prediction cache',async()=>{
 const dir=mkdtempSync(`${tmpdir()}/tetris-v2-repeat-`);
 try{
  const bundle:ValueBundle={version:2,geometry:false,feature_names:featureNames(false),residual:{trees:[[[-1,0,0,0]]],link:'identity'},risk:{trees:[[[-1,-10,0,0]]],link:'sigmoid'},alpha:.25,beta:40,horizon:32,metadata:{test:'repeat'}};
  const text=JSON.stringify(bundle),path=`${dir}/model.json`,hash=createHash('sha256').update(text).digest('hex');writeFileSync(path,text);
  const agent=new Agent({id:'repeat',family:'v2',mode:'eval',bundle:path,bundle_sha256:hash,alpha:.25,beta:40}),noQuery=async()=>{throw new Error('Evaluator made a model query');};
  const first=await episode(2836128068,agent,noQuery),second=await episode(2836128068,new Agent(agent.spec),noQuery);
  expect(second.trace).toEqual(first.trace);expect(second.lines).toBe(first.lines);expect(second.pieces).toBe(first.pieces);expect(first.trace.length).toBe(first.pieces);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
