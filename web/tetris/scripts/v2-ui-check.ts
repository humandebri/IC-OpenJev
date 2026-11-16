import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import {ROOT,OUT,atomic,sha} from './v2-common';
process.chdir(ROOT);const out=`${OUT}/ui`;mkdirSync(out,{recursive:true});const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),api:string[]=[],errors:string[]=[];page.on('request',r=>{if(/\/api\//.test(r.url()))api.push(r.url());});page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(process.env.UI_URL||'http://127.0.0.1:5178/');await page.waitForFunction(()=>!(document.querySelector('option[value="value-v2"]') as HTMLOptionElement)?.disabled);
 await page.getByText('Comparison mode & seed',{exact:true}).click();const policy=page.getByLabel('Policy',{exact:true}),assistance=page.getByLabel('Browser assistance',{exact:true});
 const pause=async()=>{await page.getByRole('button',{name:'Pause',exact:false}).click();};
 const step=async()=>{await page.getByRole('button',{name:'Step once',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.play-actions button') as HTMLButtonElement)?.disabled);};
 await policy.selectOption('1');await assistance.selectOption('value-v2');await page.getByRole('button',{name:'Start game',exact:false}).click();await pause();await step();
 await page.locator('.turn-details').getByText('value-v2',{exact:true}).waitFor();assert.equal(api.length,0);
 await assistance.selectOption('fixed-cost');await step();await page.locator('.turn-details').getByText('value-v2',{exact:true}).waitFor();
 await page.getByRole('button',{name:'New game',exact:true}).click();await pause();await step();await page.locator('.turn-details').getByText('fixed-cost',{exact:true}).waitFor();assert.equal(api.length,0);
 await policy.selectOption('0');await assistance.selectOption('value-v2');await page.getByRole('button',{name:'New game',exact:true}).click();await pause();await step();
 await page.locator('.turn-details').getByText('value-v2',{exact:true}).waitFor();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Save input / output JSON',exact:true}).click()]);const downloaded=`${out}/actual-query.json`;await download.saveAs(downloaded);
 const log=JSON.parse(readFileSync(downloaded,'utf8')),r=log.response;assert.equal(r.query_count,1);assert.equal(r.candidates.length,2);assert(r.input_tokens<=41);assert(BigInt(r.inference_instructions)>0n&&BigInt(r.inference_instructions)<5_000_000_000n);assert.equal(r.policy,'value-v2');assert.equal(r.value_v2.length,2);assert.equal(Buffer.from(r.model).toString('hex'),'0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0');
 assert.equal(r.evaluator_hash,sha(readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`)));
 const board=await page.locator('svg.board').innerHTML();await page.route('**/api/v*/canister/**/query',route=>route.abort('failed'));await step();await page.getByRole('alert').waitFor();assert.equal(await page.locator('svg.board').innerHTML(),board);await page.unroute('**/api/v*/canister/**/query');await step();assert.equal(await page.getByRole('alert').count(),0);
 await page.getByText('Inspect candidates & features',{exact:true}).click();await page.getByText('What the code and model do',{exact:true}).click();assert(await page.getByText('LightGBM v2 keeps the fixed NEXT response',{exact:false}).isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.screenshot({path:`${out}/390.png`,fullPage:true});await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${out}/1280.png`,fullPage:true});
 atomic(`${out}/result.json`,{passed:true,viewport:390,policy_frozen:true,evaluator_only_api_calls:0,actual_query_count:r.query_count,input_tokens:r.input_tokens,instructions:r.inference_instructions,model:Buffer.from(r.model).toString('hex'),evaluator_hash:r.evaluator_hash,error_injection:'aborted query; board held; retry succeeded',horizontal_overflow:false,page_errors:errors});console.log('PASS browser modes, actual Jev, injected failure/retry and 390px');
}finally{await browser.close();}
