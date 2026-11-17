import {createEvaluator,type Evaluator,type TreeModel} from './placement-search';
export async function loadBrowserEvaluator(base=import.meta.env.BASE_URL,signal?:AbortSignal):Promise<Evaluator>{
 const manifestResponse=await fetch(`${base}tetris-evaluator-manifest.json`,{signal});
 if(!manifestResponse.ok)throw new Error('Evaluator manifest unavailable');
 const manifest=await manifestResponse.json() as {sha256:string};
 const response=await fetch(`${base}tetris-evaluator.json`,{signal});
 if(!response.ok)throw new Error('Evaluator unavailable');
 const bytes=await response.arrayBuffer();
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 if(hash!==manifest.sha256)throw new Error('Evaluator hash mismatch');
 return createEvaluator(JSON.parse(new TextDecoder().decode(bytes)) as TreeModel,hash);
}
