import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const out='artifacts/tetris-search/ui';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),api:string[]=[],errors:string[]=[];
 page.on('pageerror',e=>errors.push(String(e)));
 await page.route('**/api/v*/**',route=>{api.push(route.request().url());return route.abort();});
 await page.goto(process.env.UI_URL||'http://127.0.0.1:5177/');
 await page.waitForFunction(()=>!(document.querySelector('option[value="learned"]') as HTMLOptionElement)?.disabled);
 await page.getByText('Comparison mode & seed',{exact:true}).click();
 await page.getByLabel('Policy',{exact:true}).selectOption('1');
 await page.getByLabel('Browser assistance',{exact:true}).selectOption('lookahead');
 const pause=async()=>{await page.getByRole('button',{name:'Pause',exact:false}).click();};
 const step=async()=>{await page.getByRole('button',{name:'Step once',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('.play-actions button') as HTMLButtonElement)?.disabled);};
 await page.getByRole('button',{name:'Start game',exact:false}).click();await pause();await step();
 await page.locator('.turn-details').getByText('lookahead',{exact:true}).waitFor();
 // Editing pending settings must not change the active game's frozen policy.
 await page.getByLabel('Browser assistance',{exact:true}).selectOption('learned');await step();
 await page.locator('.turn-details').getByText('lookahead',{exact:true}).waitFor();
 await page.getByRole('button',{name:'New game',exact:true}).click();await pause();await step();
 await page.locator('.turn-details').getByText('learned',{exact:true}).waitFor();
 assert.match(await page.locator('.model-hash').innerText(),/^[a-f0-9]{64}$/);
 await page.getByText('Inspect candidates & features',{exact:true}).click();
 await page.getByText('What the code and model do',{exact:true}).click();
 assert(await page.getByText('These are browser code and learned assistance, not capabilities of the 151M model.',{exact:false}).isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.equal(api.length,0);assert.deepEqual(errors,[]);
 await page.screenshot({path:`${out}/390.png`,fullPage:true});
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:`${out}/1280.png`,fullPage:true});
 writeFileSync(`${out}/result.json`,JSON.stringify({browser:'Playwright Chromium',narrow_width:390,policy_frozen:true,learned_hash_displayed:true,evaluator_only_api_calls:api.length,page_errors:errors,horizontal_overflow:false},null,2)+'\n');
 console.log('PASS: frozen policy, both assistance modes, hashed evaluator, zero API calls, 390px layout');
}finally{await browser.close();}
