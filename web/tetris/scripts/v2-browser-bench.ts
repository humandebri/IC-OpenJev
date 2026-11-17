import {chromium} from 'playwright';
import {readFileSync} from 'node:fs';
import {ROOT,OUT,read,atomic,sha,hashes} from './v2-common';
process.chdir(ROOT);const round=process.argv[2]||'initial',trained=read(`${OUT}/training-${round}.json`),manifest=read(`${OUT}/dataset-manifest.json`);
const pool:any[]=[];
for(const source of manifest.sources.filter((s:any)=>s.path.startsWith('rows/data_valid-')).slice(0,32)){
 const groups=read(`${OUT}/groups/${source.path.split('/').at(-1)}`).groups;
 for(const group of groups.filter((g:any)=>g.turn<128))pool.push({seed:group.seed,turn:group.turn,height:20-group.board.findIndex((v:number)=>v!==0),board:group.board.flatMap((r:number)=>Array.from({length:10},(_,x)=>(r>>>x)&1))});
}
pool.sort((a,b)=>a.height-b.height||a.seed-b.seed||a.turn-b.turn);
const frames=Array.from({length:Math.min(32,pool.length)},(_,i)=>pool[Math.floor(i*(pool.length-1)/31)]);
const browser=await chromium.launch({headless:true}),results=[];
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});
 await page.route('**/__v2_benchmark',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Tetris candidate benchmark</title>'}));
 await page.goto('http://127.0.0.1:5177/__v2_benchmark');
 const environment=await page.evaluate(()=>({user_agent:navigator.userAgent,hardware_concurrency:navigator.hardwareConcurrency,device_memory:(navigator as Navigator&{deviceMemory?:number}).deviceMemory}));
 for(const item of trained.models){
  const bytes=readFileSync(`${OUT}/${item.path}`);if(sha(bytes)!==item.sha256)throw new Error('Model changed');const bundle=JSON.parse(bytes.toString());
  const result=await page.evaluate(async({bundle,frames,hash})=>{
   const modulePath='/src/placement-browser-v2.ts',module=await import(/* @vite-ignore */modulePath);
   const value={bundle,hash},measurements:number[]=[];
   for(let repeat=0;repeat<5;repeat++)for(const frame of frames){
    const game={...frame,id:0,mode:1,lines:0,over:false,policy:'value-v2'};
    const start=performance.now();const result=module.prepareAssisted(game,value);const elapsed=performance.now()-start;
    if(result.candidates.length!==2&&result.choices.length>=2)throw new Error('Lost a choice');
    if(repeat>0)measurements.push(elapsed);
   }
   measurements.sort((a,b)=>a-b);return {samples:measurements.length,p50_ms:measurements[Math.floor(measurements.length*.5)],p95_ms:measurements[Math.floor(measurements.length*.95)],max_ms:Math.max(...measurements)};
  },{bundle,frames,hash:item.sha256});
  results.push({id:item.id,sha256:item.sha256,bytes:bytes.length,...result,eligible:result.p95_ms<=50&&bytes.length<=8*1024*1024});console.log(results.at(-1));
 }
 atomic(`${OUT}/browser-bench-${round}.json`,{browser:'Playwright Chromium, no CPU throttling, warm code and uncached board predictions',environment,frames:frames.length,frames_sha256:sha(JSON.stringify(frames)),source_hashes:hashes(['web/tetris/src/placement-browser-v2.ts','web/tetris/src/placement-fast.ts','web/tetris/src/placement-value-v2.ts','web/tetris/scripts/v2-browser-bench.ts']),models:results});
}finally{await browser.close();}
