import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import {ROOT,OUT,atomic,sha} from './v2-common';
process.chdir(ROOT);const out=`${OUT}/ui`;mkdirSync(out,{recursive:true});const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),api:string[]=[],errors:string[]=[];page.on('request',r=>{if(/\/api\//.test(r.url()))api.push(r.url());});page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(process.env.UI_URL||'http://127.0.0.1:5178/');await page.getByRole('button',{name:'Start game',exact:false}).waitFor({state:'visible'});await page.waitForFunction(()=>!(document.querySelector('.primary') as HTMLButtonElement)?.disabled);
 await page.getByText('Settings',{exact:true}).click();const decider=(name:string)=>page.getByRole('radio',{name,exact:true}).click();
 await page.getByRole('radio',{name:'Jev on ICP',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('radio',{name:'Evaluator only',exact:true}).getAttribute('aria-checked'),'true');
 await page.keyboard.press('Home');assert.equal(await page.getByRole('radio',{name:'Jev on ICP',exact:true}).getAttribute('aria-checked'),'true');
 const shown=(text:string)=>page.locator('.pipeline').getByText(new RegExp(`^${text} ·`)).waitFor();
 const pause=async()=>{await page.getByRole('button',{name:'Pause',exact:false}).click();};
 const step=async()=>{await page.getByRole('button',{name:'Step once',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.secondary button') as HTMLButtonElement)?.disabled);};
 assert.equal(await page.getByLabel('Shortlist',{exact:true}).count(),0);assert.equal(await page.getByLabel('Seed',{exact:true}).count(),0);assert.equal(await page.getByText('Applies to the next game. Same seed, same pieces.',{exact:true}).count(),0);
 await decider('Evaluator only');await page.getByRole('button',{name:'Start game',exact:false}).click();await pause();await step();
 await shown('LightGBM v2');assert.equal(api.length,0);
 await decider('Jev on ICP');await step();await shown('LightGBM v2');assert.equal(api.length,0);
 await page.getByRole('button',{name:'New game',exact:true}).click();await pause();await step();
 await shown('LightGBM v2');await page.getByText('Verify this run',{exact:true}).click();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download this turn (JSON)',exact:true}).click()]);const downloaded=`${out}/actual-query.json`;await download.saveAs(downloaded);
 const log=JSON.parse(readFileSync(downloaded,'utf8')),r=log.response;assert.equal(r.query_count,1);assert.equal(r.candidates.length,2);assert(r.input_tokens<=41);assert(BigInt(r.inference_instructions)>0n&&BigInt(r.inference_instructions)<5_000_000_000n);assert.equal(r.policy,'value-v2');assert.equal(log.local_input.seed,184);assert.equal(r.value_v2.length,2);assert.equal(Buffer.from(r.model).toString('hex'),'0757d774c8c44397d189c5b479853897acef8f1e2b55ebf1f5a46969063225e0');
 assert.equal(r.evaluator_hash,sha(readFileSync(`${ROOT}/web/tetris/public/tetris-value-v2.json`)));
 const board=await page.locator('svg.board').innerHTML();await page.route('**/api/v*/canister/**/query',route=>route.abort('failed'));await step();await page.getByRole('alert').waitFor();assert.equal(await page.locator('svg.board').innerHTML(),board);await page.unroute('**/api/v*/canister/**/query');await step();assert.equal(await page.getByRole('alert').count(),0);
 assert.equal(await page.locator('.option').count(),2);assert(await page.getByText('Forecast after NEXT',{exact:true}).first().isVisible());
 assert.deepEqual(await page.locator('.option .cost').allTextContents(),r.model_request.options.map((o:{text:string})=>o.text));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.screenshot({path:`${out}/390.png`,fullPage:true});await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${out}/1280.png`,fullPage:true});
 atomic(`${out}/result.json`,{passed:true,viewport:390,mode_frozen:true,seed:184,settings_controls_removed:true,evaluator_only_api_calls:0,actual_query_count:r.query_count,input_tokens:r.input_tokens,instructions:r.inference_instructions,model:Buffer.from(r.model).toString('hex'),evaluator_hash:r.evaluator_hash,error_injection:'aborted query; board held; retry succeeded',horizontal_overflow:false,page_errors:errors});console.log('PASS browser modes, actual Jev, injected failure/retry and 390px');
}finally{await browser.close();}
