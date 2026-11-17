import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {connectBrowserQuery,type QueryClient,type Game,type Decision,type PlacementPolicy} from './placement-browser-v2';
import {rotations} from './game';
import {pieceAt,MAX_TURNS} from './placement-local';
import {costs,cropTop,expectedLines,movePreview,type Preview} from './move-preview';
import valueRelease from './placement-v2-release.json';
import previousRelease from './placement-release.json';
import {releasePolicy,POLICY_NAMES,usesNumericCosts,optionLabels} from './placement-policy-ui';
import './app.css';

const COLORS=['transparent','#46d5ed','#efd55a','#b697ff','#65df99','#f48392','#639bff','#f9b367'];
const LETTERS=['A','B','C','D'];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const DEFAULT_POLICY=releasePolicy(valueRelease,previousRelease);

// Held-out evaluation, docs/TETRIS_LIGHTGBM_V2.md (128 unseen seeds, 512 pieces each).
const RESULTS=[
 {label:'Previous shortlist → Jev',note:'fixed two-piece search',lines:98.773},
 {label:'LightGBM v2 → Jev',note:'this demo',lines:203.109,current:true},
 {label:'Same two options, random pick',note:'no model',lines:36.609},
];

type Phase='idle'|'thinking'|'reveal'|'placing';
type Tally={contested:number;cheaper:number};

function friendlyError(e:unknown){
 const text=String(e instanceof Error?e.message:e).replace(/^Error:\s*/,'');
 if(/LightGBM v2 unavailable/.test(text))return 'LightGBM v2 unavailable — the evaluator could not be verified. Switch the shortlist to “Fixed search” in Settings to play without it.';
 if(/Model unavailable|token limit/.test(text))return 'The model on the canister is not available right now. Try “Evaluator only” in Settings to play without it.';
 if(/frozen Jev/.test(text))return 'The canister is serving a different model than this demo was validated with.';
 if(/frozen|top up|out of cycles/i.test(text))return 'The canister is paused (out of cycles), so the model can’t be asked right now. Choose “Evaluator only” in Settings to keep playing in your browser.';
 if(/reject|replica|Reject code|fetch|network|Failed|abort|timed out/i.test(text))return 'Couldn’t reach the model on the canister. Nothing was placed — try again in a moment.';
 if(text.length>160){console.error(text);return 'Something went wrong. Nothing was placed — try again.';}
 return text;
}

function App(){
 const [client,setClient]=useState<QueryClient>();
 const [loadError,setLoadError]=useState('');
 const [game,setGame]=useState<Game>();
 const [decision,setDecision]=useState<Decision>();
 const [board,setBoard]=useState<number[]>(Array(200).fill(0));
 const [moving,setMoving]=useState<[number,number][]>([]);
 const [phase,setPhase]=useState<Phase>('idle');
 const [auto,setAuto]=useState(false);
 const running=useRef(false);
 const [error,setError]=useState('');
 const [elapsed,setElapsed]=useState(0);
 const [tally,setTally]=useState<Tally>({contested:0,cheaper:0});
 const [seed,setSeed]=useState(184);
 const [mode,setMode]=useState(0);
 const [policy,setPolicy]=useState<PlacementPolicy>(DEFAULT_POLICY);
 const host=import.meta.env.VITE_IC_HOST||'https://icp-api.io';
 const canister=import.meta.env.VITE_CANISTER_ID||'';
 const busy=phase!=='idle';

 useEffect(()=>{let live=true;connectBrowserQuery(host,canister).then(c=>{if(live)setClient(c);}).catch(e=>{if(live)setLoadError(friendlyError(e));});return()=>{live=false;};},[]);

 const start=async()=>{
  if(!client)return;setPhase('thinking');setError('');setAuto(false);
  try{
   client.assertAvailable(policy);
   if(mode===0&&!(await client.status(true)).enabled)throw new Error('Model unavailable');
   const g=client.start(seed>>>0,mode,policy);
   setGame(g);setBoard(g.board);setDecision(undefined);setMoving([]);setTally({contested:0,cheaper:0});setAuto(true);
  }catch(e){setError(friendlyError(e));}
  finally{setPhase('idle');}
 };

 const step=async()=>{
  if(!client||!game||running.current||game.over)return;
  running.current=true;setPhase('thinking');setError('');
  try{
   const began=performance.now();const r=await client.step(game);setElapsed(performance.now()-began);
   setDecision(r);setBoard(r.before);setPhase('reveal');
   const c=costs(r);if(r.mode===0&&usesNumericCosts(r.policy)&&new Set(c).size>1)setTally(t=>({contested:t.contested+1,cheaper:t.cheaper+(c[r.selected]===0?1:0)}));
   await sleep(700);setPhase('placing');
   for(const p of r.candidates[r.selected].path){setMoving(rotations(r.piece)[p.r].map(([x,y])=>[x+p.x,y+p.y]));await sleep(30);}
   setMoving([]);setBoard(r.after);setGame({...game,board:r.after,turn:r.turn+1,lines:r.total_lines,over:r.over});
  }catch(e){setError(friendlyError(e));setAuto(false);}
  finally{running.current=false;setPhase('idle');}
 };

 useEffect(()=>{
  if(!auto||busy||!game||game.over)return;
  const timer=setTimeout(()=>{if(document.hidden){setAuto(false);return;}void step();},450);
  return()=>clearTimeout(timer);
 },[auto,busy,game]);

 const saveLog=()=>{
  if(!decision)return;
  const blob=new Blob([JSON.stringify({host,canister,model_request:decision.model_request,local_input:{board:decision.before,seed:game?.seed,turn:decision.turn},response:decision,certified:false},null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`tetris-turn-${decision.turn+1}.json`;a.click();URL.revokeObjectURL(a.href);
 };

 const policyError=client?.availabilityError(policy)??null;
 const needsStart=!game||game.over;
 const shownError=error||(needsStart&&policyError?friendlyError(policyError):'')||loadError;
 const activeMode=game?.mode??mode;
 const activePolicy=game?.policy??policy;
 const network=activeMode===1?'Browser only':client?.local?'Local canister':'ICP mainnet';
 const nextPiece=game&&!game.over?pieceAt(game.seed,game.turn+1):null;
 const reveal=phase==='reveal'&&decision?decision:undefined;

 return <>
  <header className="top">
   <a className="brand" href="/">open<span>Jev</span></a>
   <span className={`net ${activeMode===1?'off':''}`}><i/>{network}</span>
  </header>
  <main>
   <section className="hero">
    <p className="eyebrow">LightGBM in your browser · 151M model on the Internet Computer</p>
    <h1>One more <em>block.</em></h1>
    <p className="lede">Your browser looks two pieces ahead and shortlists the two best moves. A 151M-parameter model running inside an ICP canister reads their costs and makes the call.</p>
   </section>

   <div className="stage">
    <section className="cabinet" aria-label="Game">
     <div className="well">
      <Board board={board} moving={moving} piece={decision?.piece??0} reveal={reveal}/>
      {!game&&<div className="overlay"><strong>Press start</strong><span>{MAX_TURNS} pieces · seed {seed}</span></div>}
      {game?.over&&phase==='idle'&&<div className="overlay"><strong>{game.lines} lines</strong><span>{game.turn} pieces placed</span></div>}
     </div>
     <aside className="hud">
      <div><h2>Next</h2><div className="next">{nextPiece!==null?<PieceIcon piece={nextPiece}/>:<span className="dash">—</span>}</div></div>
      <div><h2>Lines</h2><strong className="big">{game?.lines??0}</strong></div>
      <div><h2>Piece</h2><strong className="mid">{game?.turn??0}<small>/{MAX_TURNS}</small></strong></div>
      {activeMode===0&&tally.contested>0&&<div className="agree" title="Moves where the two options had different costs, and how often Jev picked the cheaper one"><h2>Cheaper pick</h2><strong className="mid">{tally.cheaper}<small>/{tally.contested}</small></strong></div>}
     </aside>
     <div className="controls">
      <button className="primary" disabled={(busy&&!auto)||!client||(needsStart&&!!policyError)} onClick={needsStart?start:()=>setAuto(!auto)}>
       {needsStart?(game?'Play again':'Start game'):auto?'Pause':'Resume'}{auto&&!needsStart?<Icon d="M7 5v14M17 5v14"/>:<Icon d="M5 12h14M13 6l6 6-6 6"/>}
      </button>
      {game&&!game.over&&<div className="secondary"><button disabled={busy||auto} onClick={()=>void step()}>Step once</button><button disabled={busy||!!policyError} onClick={start}>New game</button></div>}
     </div>
     {shownError&&<p role="alert" className="fault">{shownError}</p>}
     <details className="settings">
      <summary>Settings</summary>
      <div className="fields">
       <fieldset><legend>Who decides</legend>
        <div className="seg" role="radiogroup" aria-label="Who decides" onKeyDown={e=>{
         if(busy||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(e.key))return;
         e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?1:1-mode;setMode(next);
         e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
        }}>
         <button role="radio" tabIndex={mode===0?0:-1} aria-checked={mode===0} disabled={busy} onClick={()=>setMode(0)}>Jev on ICP</button>
         <button role="radio" tabIndex={mode===1?0:-1} aria-checked={mode===1} disabled={busy} onClick={()=>setMode(1)}>Evaluator only</button>
        </div>
       </fieldset>
       <label>Shortlist<select aria-label="Shortlist" value={policy} disabled={busy} onChange={e=>setPolicy(e.target.value as PlacementPolicy)}>
        <option value="value-v2" disabled={!!client&&!client.availability.v2}>LightGBM v2</option>
        <option value="fixed-cost">Fixed search (baseline)</option>
        <option value="lookahead">Lookahead search (four candidates)</option>
        <option value="learned" disabled={!!client&&!client.availability.v1}>LightGBM v1 (experimental)</option>
        <option value="legacy">Legacy heuristic</option>
       </select></label>
       <label>Seed<input aria-label="Seed" type="number" inputMode="numeric" value={seed} disabled={busy} onChange={e=>setSeed(Number(e.target.value))}/></label>
      </div>
      <p className="hint">Applies to the next game. Same seed, same pieces.</p>
      {!usesNumericCosts(policy)&&<p className="hint">This retained policy offers up to four placements and sends hole, height and missed-clear descriptions.</p>}
     </details>
    </section>

    <DecisionPanel decision={decision} phase={phase} game={game} mode={activeMode} policy={activePolicy} elapsed={elapsed}/>
   </div>

   <Results/>

   <section className="how">
    <h2 className="section-title">How a move is made</h2>
    <ol>
     <li><b>Shortlist in your browser</b><span>Every legal placement is paired with the best answer for the visible NEXT piece. LightGBM v2 predicts how the resulting board plays out over the following 32 pieces, and the top two become options A and B.</span></li>
     <li><b>Reduce to costs</b><span>Each option becomes a single number — how far it trails the best one. The model never sees the board, the scores, or upcoming pieces.</span></li>
     <li><b>Decide on-chain</b><span>Jev, a 151M-parameter model, answers one ICP query call of about 11 tokens. Its pick is applied as-is, even when it disagrees.</span></li>
    </ol>
   </section>

   <details className="verify">
    <summary>Verify this run</summary>
    <dl>
     <dt>Canister</dt><dd>{canister||'not configured'}</dd>
     <dt>Endpoint</dt><dd>{host}</dd>
     {decision&&decision.model.length>0&&<><dt>Model hash</dt><dd className="hash">{decision.model.map(v=>v.toString(16).padStart(2,'0')).join('')}</dd></>}
     <dt>Evaluator SHA-256</dt><dd className="hash model-hash">{decision?decision.evaluator_hash??`None — ${POLICY_NAMES[decision.policy].toLowerCase()}`:activePolicy==='value-v2'?valueRelease.model_sha256:activePolicy==='learned'?previousRelease.evaluator_hash:`None — ${POLICY_NAMES[activePolicy].toLowerCase()}`}</dd>
    </dl>
    <p>The board, candidate search and LightGBM run entirely in your browser. Only the short cost labels reach the canister, as a query call. The exported log is a local record of input and output, not a consensus-certified receipt.</p>
    <button disabled={!decision} onClick={saveLog}>Download this turn (JSON)</button>
   </details>
  </main>
  <footer className="site-foot">openJev · 151M parameters on the Internet Computer</footer>
 </>;
}

function Board({board,moving,piece,reveal}:{board:number[];moving:[number,number][];piece:number;reveal?:Decision}){
 return <svg viewBox="0 0 240 480" className="board" role="img" aria-label="Tetris board">
  {board.map((v,i)=><rect key={i} x={i%10*24+1} y={Math.floor(i/10)*24+1} width="22" height="22" rx="3" className={v?'cell':'empty'} fill={v?COLORS[v]:undefined}/>)}
  {reveal?.candidates.map((c,k)=>{
   const chosen=k===reveal.selected,cx=c.cells.reduce((s,[x])=>s+x,0)/c.cells.length,cy=Math.min(...c.cells.map(([,y])=>y));
   return <g key={k} className={`option-ghost ${chosen?'chosen':''}`}>
    {c.cells.map(([x,y],i)=><rect key={i} x={x*24+2.5} y={y*24+2.5} width="19" height="19" rx="3"/>)}
    {reveal.candidates.length>1&&<text x={cx*24+12} y={Math.max(14,cy*24-6)}>{LETTERS[k]}</text>}
   </g>;
  })}
  {moving.map(([x,y],i)=><rect className="active" key={`m${i}`} x={x*24+1} y={y*24+1} width="22" height="22" rx="3" fill={COLORS[piece+1]}/>)}
 </svg>;
}

function Icon({d}:{d:string}){
 return <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
}

function PieceIcon({piece}:{piece:number}){
 const shape=rotations(piece)[0],w=Math.max(...shape.map(c=>c[0]))+1,h=Math.max(...shape.map(c=>c[1]))+1;
 return <svg viewBox={`0 0 ${w*16} ${h*16}`} width={w*16} height={h*16} aria-label="Next piece">{shape.map(([x,y],i)=><rect key={i} x={x*16+1} y={y*16+1} width="14" height="14" rx="2.5" fill={COLORS[piece+1]}/>)}</svg>;
}

function MiniBoard({preview,top}:{preview:Preview;top:number}){
 const rows=20-top;
 return <svg viewBox={`0 0 100 ${rows*10}`} className="mini" aria-hidden>
  {preview.cells.slice(top*10).map((c,i)=>{
   const x=i%10*10,y=Math.floor(i/10)*10;
   if(c.next)return <rect key={i} x={x+1.25} y={y+1.25} width="7.5" height="7.5" rx="1.5" className="mini-next" stroke={COLORS[c.value]}/>;
   return <rect key={i} x={x+.5} y={y+.5} width="9" height="9" rx="1.5" className={c.current?'mini-current':c.value?'mini-fill':'mini-empty'} fill={c.current?COLORS[c.value]:undefined}/>;
  })}
 </svg>;
}

function DecisionPanel({decision,phase,game,mode,policy,elapsed}:{decision?:Decision;phase:Phase;game?:Game;mode:number;policy:PlacementPolicy;elapsed:number}){
 const view=useMemo(()=>{
  if(!decision)return null;
  const previews=decision.candidates.map(c=>{const s=(c as {search?:{next_pose:{r:number;x:number;y:number}|null}}).search;return movePreview(decision.before,decision.piece,c.cells,decision.next,s?.next_pose??null);});
  return {previews,top:cropTop(previews),cost:costs(decision),labels:optionLabels(decision)};
 },[decision]);
 const thinking=phase==='thinking';
 const jevMode=(decision?.mode??mode)===0;
 const evaluatorName=POLICY_NAMES[decision?.policy??policy],numeric=usesNumericCosts(decision?.policy??policy);

 if(!decision||!view)return <section className="panel empty" aria-live="polite">
  <div className="panel-head"><h2>This move</h2></div>
  <div className="pipeline">
   <Stage n="1" where="Your browser" what={`${evaluatorName} shortlists up to ${numeric?'two':'four'} moves`} state={thinking&&mode!==0?'active':'wait'}/>
   <Stage n="2" where="ICP canister" what={mode===0?'Jev 151M picks one':'Skipped — evaluator only'} state={mode!==0?'skip':thinking?'active':'wait'}/>
  </div>
  <p className="empty-copy">{game?(mode===0?'Asking the model for the first move. The first call can take a few seconds while the canister warms up.':'Choosing the first move…'):'Start a game to watch the shortlisted placements, what the model was told, and what it chose.'}</p>
 </section>;

 const n=decision.candidates.length,picked=LETTERS[decision.selected],tie=n>1&&view.cost.every(c=>c===0);
 const headline=n===1?'Only one available move':!jevMode?`${evaluatorName} placed ${picked}`:!numeric?`Jev chose ${picked}`:tie?`Same rounded cost — Jev took ${picked}`:view.cost[decision.selected]===0?`Jev took the cheaper move, ${picked}`:`Jev took ${picked}, the costlier move`;
 const v2=decision.value_v2;

 return <section className={`panel ${thinking?'is-thinking':''}`} aria-live="polite">
  <div className="panel-head"><h2>Move {decision.turn+1}</h2>{thinking?<span className="headline pending">{jevMode?'Asking Jev for the next move…':'Scoring the next move…'}</span>:<span className="headline">{headline}</span>}</div>
  <div className="pipeline">
   <Stage n="1" where="Your browser" what={`${evaluatorName} · ${n} of ${decision.legal_count} moves`} meta={`${decision.candidate_ms.toFixed(1)} ms`} state={thinking&&!jevMode?'active':'done'}/>
   <Stage n="2" where="ICP canister" what={jevMode?<>Jev read <code>{view.labels.map((label,i)=>`${n>1?LETTERS[i]+' ':''}${label}`).join(' · ')}</code></>:'Skipped — evaluator only'}
    meta={jevMode?`${(elapsed/1000).toFixed(2)} s · ${decision.input_tokens} tokens · ${(Number(decision.inference_instructions)/1e9).toFixed(2)}B instructions`:undefined} state={!jevMode?'skip':thinking?'active':'done'}/>
  </div>
  <div className={`options n${n}`}>
   {decision.candidates.map((c,i)=>{
    const value=v2?.[i],future=value?expectedLines(value):null,search=(c as {search?:{holes:number;height:number;total_lines:number}}).search;
    const chosen=i===decision.selected,top=i===decision.recommended;
    return <article key={i} className={`option ${chosen?'chosen':''}`} aria-label={`Option ${LETTERS[i]}${chosen?', chosen':''}`}>
     <header><span className="letter">{n>1?LETTERS[i]:'Only move'}</span><span className="cost">{view.labels[i]}</span></header>
     <MiniBoard preview={view.previews[i]} top={view.top}/>
     <dl>
      {future!==null?<><dt title="Expected lines in the 32 pieces after the current piece and NEXT">Forecast after NEXT</dt><dd>{future.toFixed(1)} lines</dd></>:search&&<><dt>After NEXT</dt><dd>{search.holes} {search.holes===1?'hole':'holes'} · h{search.height}</dd></>}
      {search&&search.total_lines>0&&<><dt>Clears with NEXT</dt><dd>{search.total_lines} {search.total_lines===1?'line':'lines'}</dd></>}
      {value&&value.risk>=.05&&<><dt>Top-out risk</dt><dd className="risk">{Math.round(value.risk*100)}%</dd></>}
     </dl>
     <div className="tags">{chosen&&<span className="tag pick">{jevMode?'Jev’s choice':'Placed'}</span>}{top&&n>1&&!tie&&<span className="tag">{evaluatorName} #1</span>}</div>
    </article>;
   })}
  </div>
  <p className="legend"><i className="lg-cur"/>this piece{view.previews.some(p=>p.cells.some(c=>c.next))&&<><i className="lg-next"/>best reply for NEXT</>}{decision.policy==='value-v2'&&<span>· forecast by LightGBM v2</span>}</p>
 </section>;
}

function Stage({n,where,what,meta,state}:{n:string;where:string;what:React.ReactNode;meta?:string;state:'wait'|'active'|'done'|'skip'}){
 return <div className={`stage-step ${state}`}><span className="dot">{n}</span><div><small>{where}</small><p>{what}</p>{meta&&<em>{meta}</em>}</div></div>;
}

function Results(){
 const max=Math.max(...RESULTS.map(r=>r.lines));
 return <section className="results">
  <div className="results-copy">
   <h2 className="section-title">Twice the lines, same model</h2>
   <p>Swapping the hand-written shortlist for LightGBM v2 doubled the score without touching Jev. Across 128 unseen games, every game survived all 512 pieces.</p>
  </div>
  <figure>
   {RESULTS.map(r=><div key={r.label} className={`bar ${r.current?'current':''}`}>
    <span className="bar-label">{r.label}<small>{r.note}</small></span>
    <span className="bar-track"><span style={{width:`${r.lines/max*100}%`}}/></span>
    <b>{r.lines.toFixed(1)}</b>
   </div>)}
   <figcaption>Mean lines cleared in 512 pieces · 128 held-out seeds. LightGBM alone scores 203.0. Jev’s additional gain over that evaluator was not statistically established.</figcaption>
  </figure>
 </section>;
}

createRoot(document.getElementById('root')!).render(<App/>);
