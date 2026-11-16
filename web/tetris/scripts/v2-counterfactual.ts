import {readFileSync,mkdirSync,existsSync} from 'node:fs';
import {Teacher,pieceStream,type MaskBoard} from '../src/placement-fast';
import {ROOT,OUT,read,atomic,freeze,sha,derive} from './v2-common';
process.chdir(ROOT);const summary=read(`${OUT}/test-summary.json`),protocol=read(`${OUT}/counterfactual-protocol.json`);
if(!summary.complete||protocol.source_sha256!==sha(readFileSync(import.meta.filename)))throw new Error('Counterfactual protocol mismatch');
type Result={seed:number;spec:string;source:string;source_sha256:string;states:{turn:number;selected:number;recommended:number;disagreed:boolean;line_difference:number;survival_difference:number;outcomes:unknown[]}[]};
const teacher=new Teacher(),directory=`${OUT}/episodes/counterfactual`;mkdirSync(directory,{recursive:true});const results:Result[]=[];
for(const source of summary.sources){
 const episode=read(`${OUT}/${source.path}`).episode;if(episode.mode!=='jev')continue;
 const output=`${directory}/${episode.seed}-${episode.spec}.json`;
 if(existsSync(output)){results.push(read(output));continue;}
 const count=Math.min(8,episode.trace.length),indices=Array.from({length:count},(_,i)=>Math.floor((i+.5)*episode.trace.length/count)),states=[];
 for(const index of indices){
  const state=episode.trace[index];let lineDifference=0,survivalDifference=0;const outcomes=[];
  if(state.selected!==state.recommended){
   for(let k=0;k<8;k++){
    const seed=derive('counterfactual-v2',episode.seed,index,k),stream=pieceStream(seed,33),pair=[];
    for(const selected of [state.selected,state.recommended]){
     const c=state.candidates[selected];let board:MaskBoard=Uint16Array.from(c.terminal??c.after),lines=c.total_lines,survived=0;
     if(c.safe)for(let t=0;t<32;t++){const action=teacher.choose(board,stream[t],stream[t+1]);if(!action)break;lines+=action.lines;survived++;board=action.board;if(!action.safe)break;}
     pair.push({lines,survived});
    }
    lineDifference+=(pair[0].lines-pair[1].lines)/8;survivalDifference+=(pair[0].survived-pair[1].survived)/8;outcomes.push({seed,jev:pair[0],evaluator:pair[1]});
   }
  }
  states.push({turn:index,selected:state.selected,recommended:state.recommended,disagreed:state.selected!==state.recommended,line_difference:lineDifference,survival_difference:survivalDifference,outcomes});
 }
 const result={seed:episode.seed,spec:episode.spec,source:source.path,source_sha256:source.sha256,states};atomic(output,result);results.push(result);
 if(results.length%32===0)console.log(`counterfactual ${results.length} games`);
}
const metrics=[...new Set(results.map(r=>r.spec))].map(spec=>{
 const states=results.filter(r=>r.spec===spec).flatMap(r=>r.states),differences=states.filter(s=>s.disagreed),mean=(list:any[],key:string)=>list.length?list.reduce((s,v)=>s+v[key],0)/list.length:0;
 return {spec,states:states.length,disagreements:differences.length,mean_line_difference:mean(states,'line_difference'),mean_survival_difference:mean(states,'survival_difference'),mean_disagreement_line_difference:mean(differences,'line_difference')};
});
atomic(`${OUT}/counterfactual-summary.json`,{complete:true,interpretation:'Same board and same two candidates. Known two clears plus 32 further placements, 8 independent common-random sequences, fixed-search continuation. This is a controlled rollout estimate, not a full Jev continuation.',metrics,protocol_sha256:sha(JSON.stringify(protocol)),test_summary_sha256:sha(readFileSync(`${OUT}/test-summary.json`)),sources:results.map(r=>({path:`episodes/counterfactual/${r.seed}-${r.spec}.json`,sha256:sha(readFileSync(`${directory}/${r.seed}-${r.spec}.json`))}))});
console.log(metrics);
