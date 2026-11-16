import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync,mkdirSync} from 'node:fs';
import {ROOT,OUT,sha,read,atomic} from './v2-common';
import type {costRequest} from '../src/placement-value-v2';
export type Request=ReturnType<typeof costRequest>;
export type OracleReply={selected:number;tokens:number;instructions:string;cached:boolean;scores:number[];logits?:number[];model?:number[]};
export class NativeOracle {
 private process:ChildProcessWithoutNullStreams;private queue:{resolve:(line:string)=>void;reject:(e:Error)=>void}[]=[];private failed:Error|undefined;
 private pending=new Map<string,Promise<OracleReply>>();actual=0;cached=0;
 constructor(private directory=`${OUT}/native-cache`){
  mkdirSync(directory,{recursive:true});this.process=spawn(`${ROOT}/target/release/tetris_probe`,[ROOT],{stdio:'pipe'});
  const fail=(e:Error)=>{this.failed=e;for(const q of this.queue.splice(0))q.reject(e);};
  this.process.on('error',fail);this.process.stdin.on('error',fail);this.process.on('exit',code=>{if(code)fail(new Error(`Native probe exited ${code}`));});
  this.process.stderr.on('data',chunk=>process.stderr.write(chunk));
  createInterface({input:this.process.stdout}).on('line',line=>this.queue.shift()?.resolve(line));
 }
 async choose(request:Request):Promise<OracleReply>{
  const key=sha(JSON.stringify(request));if(this.pending.has(key)){this.cached++;return {...await this.pending.get(key)!,cached:true};}
  const work=(async()=>{
   const path=`${this.directory}/${key}.json`;
   if(existsSync(path)){this.cached++;return {...read<OracleReply>(path),cached:true};}
   const raw=await new Promise<string>((resolve,reject)=>{if(this.failed){reject(this.failed);return;}this.queue.push({resolve,reject});this.process.stdin.write(JSON.stringify({text:request.state,labels:request.options.map(o=>o.text),infer:true})+'\n');});
   const v=JSON.parse(raw);
   if(!Number.isInteger(v.selected)||v.selected<0||v.selected>=request.options.length||v.tokens>41||!v.scores.every(Number.isFinite))throw new Error('Invalid native reply');
   const result={selected:v.selected,tokens:v.tokens,instructions:'0',cached:false,scores:v.scores};atomic(path,result);this.actual++;return result;
  })();this.pending.set(key,work);try{return await work;}catch(error){this.pending.delete(key);throw error;}
 }
 close(){this.process.stdin.end();}
}
