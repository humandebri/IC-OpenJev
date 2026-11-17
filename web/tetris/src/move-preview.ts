// Presentation helpers for the two-option view. They never influence the decision.
import {rotations} from './game';
import {maskFeatures} from './placement-fast';
import type {Decision} from './placement-browser-v2';

export type PreviewCell={value:number;current:boolean;next:boolean};
export type Preview={cells:PreviewCell[];linesNow:number};

/** Board after the current placement (with its cells marked), plus the outlined NEXT response. */
export function movePreview(before:readonly number[],piece:number,cells:readonly [number,number][],next:number,nextPose:{r:number;x:number;y:number}|null):Preview{
 const rows:PreviewCell[][]=Array.from({length:20},(_,y)=>Array.from({length:10},(_,x)=>({value:before[y*10+x],current:false,next:false})));
 for(const [x,y] of cells)rows[y][x]={value:piece+1,current:true,next:false};
 const kept=rows.filter(row=>row.some(c=>!c.value)),linesNow=20-kept.length;
 const board=[...Array.from({length:linesNow},()=>Array.from({length:10},()=>({value:0,current:false,next:false}))),...kept];
 if(nextPose){
  const shape=rotations(next)[nextPose.r];
  if(shape)for(const [x,y] of shape){const cell=board[y+nextPose.y]?.[x+nextPose.x];if(cell)board[y+nextPose.y][x+nextPose.x]={value:next+1,current:false,next:true};}
 }
 return {cells:board.flat(),linesNow};
}

/** First row worth showing so that every preview keeps the same vertical frame. */
export function cropTop(previews:Preview[],minRows=7,margin=2){
 let top=20;
 for(const p of previews)p.cells.forEach((c,i)=>{if(c.value)top=Math.min(top,Math.floor(i/10));});
 return Math.max(0,Math.min(20-minRows,top-margin));
}

/** Rounded nonnegative gap to the best score: exactly the label Jev reads. */
export function costs(decision:Decision):number[]{
 const scores=decision.candidates.map(c=>'search' in c&&c.search?(c.search as {score:number}).score:0);
 const best=Math.max(...scores);return scores.map(s=>Math.max(0,Math.round(best-s)));
}

/** LightGBM v2 residual target is 10 * mean future lines - V0, so future lines = (V0 + residual) / 10. */
export function expectedLines(value:{residual:number;terminal:number[]|null}):number|null{
 if(!value.terminal)return null;
 const f=maskFeatures(value.terminal);return Math.max(0,(-8*f.holes-f.height+value.residual)/10);
}
