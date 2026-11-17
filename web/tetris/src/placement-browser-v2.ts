import {connectQuery,validateReply,type Decision as OldDecision,type ModelReply,type Status} from './placement-query-api';
import {landed,placements,pieceAt,renderPrompt,MAX_TURNS} from './placement-local';
import type {Game as OldGame,PlacementPolicy as OldPolicy} from './placement-api';
import {loadBrowserEvaluator} from './placement-evaluator';
import {fastChoices,fastPlacements,masks,maskFeatures} from './placement-fast';
import {costRequest,topTwo,v2Score,validateBundle,type ValueBundle} from './placement-value-v2';
import valueRelease from './placement-v2-release.json';
import {loadAssetWithin} from './placement-asset-load';
export type {Pose} from './placement-api';
export type PlacementPolicy=OldPolicy|'fixed-cost'|'value-v2';
export type Game=Omit<OldGame,'policy'>&{policy?:PlacementPolicy};
export type Decision=Omit<OldDecision,'policy'>&{policy:PlacementPolicy;value_v2?:{version:2;residual:number;risk:number;alpha:number;beta:number;known_lines:number;terminal:number[]|null}[]};
export type BrowserBundle={bundle:ValueBundle;hash:string};
export const FROZEN_JEV='0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0';
export async function loadValueBundle(base=import.meta.env.BASE_URL,expectedHash:string|null=valueRelease.adopted?valueRelease.model_sha256:null,signal?:AbortSignal):Promise<BrowserBundle>{
 if(expectedHash!==null&&!/^[a-f0-9]{64}$/.test(expectedHash))throw new Error('Invalid approved release hash');
 const manifestResponse=await fetch(`${base}tetris-value-v2-manifest.json`,{signal});if(!manifestResponse.ok)throw new Error('v2 manifest unavailable');
 const manifest=await manifestResponse.json() as {sha256:string;bytes:number};if(manifest.bytes>8*1024*1024)throw new Error('v2 exceeds 8 MiB');
 if(expectedHash!==null&&manifest.sha256!==expectedHash)throw new Error('v2 evaluator does not match the approved release');
 const response=await fetch(`${base}tetris-value-v2.json`,{signal});if(!response.ok)throw new Error('v2 model unavailable');
 const bytes=await response.arrayBuffer();if(bytes.byteLength>8*1024*1024||bytes.byteLength!==manifest.bytes)throw new Error('v2 size mismatch');
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 if(hash!==manifest.sha256)throw new Error('v2 hash mismatch');if(expectedHash!==null&&hash!==expectedHash)throw new Error('v2 evaluator does not match the approved release');const bundle=JSON.parse(new TextDecoder().decode(bytes)) as ValueBundle;validateBundle(bundle);return {bundle,hash};
}
export function prepareAssisted(game:Game,value?:BrowserBundle){
 if(game.over||game.turn>=MAX_TURNS)throw new Error('Run complete');
 const piece=pieceAt(game.seed,game.turn),next=pieceAt(game.seed,game.turn+1),all=fastChoices(masks(game.board),piece,next);
 if(game.policy==='value-v2'&&!value)throw new Error('v2 is not loaded');
 const choices=topTwo(game.policy==='value-v2'?all.map(c=>v2Score(c,value!.bundle)):all.map(c=>({...c,residual:0,risk:c.safe?0:1})));
 if(!choices.length)throw new Error('No legal placement');
 const legal=placements(game.board,piece),candidates=choices.map(c=>{
  const reference=legal.find(v=>v.pose.r===c.r&&v.pose.x===c.x&&v.pose.y===c.y);if(!reference)throw new Error('Unreachable placement');
  const f=c.next?maskFeatures(c.next.board):c;
  return {...reference,search:{safe:c.safe,next_count:c.next?fastPlacements(c.board,next).length:0,total_lines:c.total_lines,holes:f.holes,height:f.height,score:c.score,next_pose:c.next?{r:c.next.r,x:c.next.x,y:c.next.y}:null}};
 });
 const recommended=choices.reduce((a,c,i)=>c.score>choices[a].score?i:a,0);
 return {piece,next,choices,candidates,recommended,legal_count:legal.length,request:costRequest(choices)};
}
export async function chooseAssisted(game:Game,status:Status,query:(r:ReturnType<typeof costRequest>)=>Promise<ModelReply>,value?:BrowserBundle):Promise<Decision>{
 const began=performance.now(),turn=prepareAssisted(game,value),candidate_ms=performance.now()-began;
 let selected=turn.recommended,reply:ModelReply|undefined;
 if(game.mode===0){if(!status.enabled)throw new Error('Model unavailable');if(Array.from(status.model,v=>v.toString(16).padStart(2,'0')).join('')!==FROZEN_JEV)throw new Error('This policy requires the frozen Jev 151M model');reply=await query(turn.request);selected=validateReply(reply,turn.request,status);if(reply.input_tokens>41)throw new Error('Input exceeds 41 tokens');}
 const chosen=turn.candidates[selected],after=landed(game.board,turn.piece,chosen.cells),model_candidates=turn.candidates.map((_,i)=>i);
 const over=game.turn+1>=MAX_TURNS||!turn.choices[selected].safe;
 return {id:game.turn,game:game.id,seed:game.seed,mode:game.mode,turn:game.turn,piece:turn.piece,next:turn.next,before:game.board.slice(),after:after.board,total_lines:game.lines+after.lines,over,
  legal_count:turn.legal_count,candidates:turn.candidates,recommended:turn.recommended,selected,logits:reply?.logits??[],scores:reply?.probabilities??[],model:Array.from(reply?.model??status.model),
  prompt:reply?renderPrompt(turn.request):'',model_request:reply?turn.request:null,input_tokens:reply?.input_tokens??0,inference_instructions:reply?.measured_instructions.toString()??'0',
  rules:'placement-v2-safe-dedup-fixed-next-top2-integer-cost',policy:game.policy!,evaluator_hash:game.policy==='value-v2'?value!.hash:null,candidate_ms,model_candidates,
  rounds:reply?[{model_candidates,selected,input_tokens:reply.input_tokens}]:[],query_count:reply?1:0,
  value_v2:game.policy==='value-v2'?turn.choices.map(c=>({version:2,residual:c.residual,risk:c.risk,alpha:value!.bundle.alpha,beta:value!.bundle.beta,known_lines:c.total_lines,terminal:c.next?Array.from(c.next.board):null})):undefined};
}
export async function connectBrowserQuery(host:string,canister:string,assetTimeoutMs=30_000){
 const [v1,v2]=await Promise.allSettled([
  loadAssetWithin(signal=>loadBrowserEvaluator(undefined,signal),assetTimeoutMs),
  loadAssetWithin(signal=>loadValueBundle(undefined,undefined,signal),assetTimeoutMs),
 ]);
 const old=await connectQuery(host,canister,v1.status==='fulfilled'?v1.value:undefined),value=v2.status==='fulfilled'?v2.value:undefined;
 const errors={v1:v1.status==='rejected'?`LightGBM v1 unavailable: ${String(v1.reason)}`:null,v2:v2.status==='rejected'?`LightGBM v2 unavailable: ${String(v2.reason)}`:null};
 const availabilityError=(policy:PlacementPolicy)=>policy==='value-v2'?errors.v2:policy==='learned'?errors.v1:null;
 const assertAvailable=(policy:PlacementPolicy)=>{const error=availabilityError(policy);if(error)throw new Error(error);};
 return {local:old.local,status:old.status,query:old.query,availability:{v1:v1.status==='fulfilled',v2:!!value},
  availabilityError,assertAvailable,
  start:(seed:number,mode:number,policy:PlacementPolicy):Game=>{assertAvailable(policy);return {id:0,seed,mode,policy,board:Array(200).fill(0),turn:0,lines:0,over:false};},
  step:async(game:Game):Promise<Decision>=>{assertAvailable(game.policy??'legacy');return game.policy==='fixed-cost'||game.policy==='value-v2'
   ?chooseAssisted(game,game.mode===0?await old.status():{enabled:false,warmed:false,model:[],max_tokens:0},old.query,value)
   :old.step(game as OldGame);}};
}
export type QueryClient=Awaited<ReturnType<typeof connectBrowserQuery>>;
