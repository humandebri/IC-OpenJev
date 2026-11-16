import {POP,maskFeatures,type MaskBoard,type FastChoice} from './placement-fast';
export const SUMMARY_NAMES=[...Array.from({length:10},(_,i)=>`height_${i}`),...Array.from({length:10},(_,i)=>`holes_${i}`),...Array.from({length:9},(_,i)=>`slope_${i}`),...Array.from({length:10},(_,i)=>`well_${i}`),...Array.from({length:20},(_,i)=>`row_${i}`),'aggregate_height','bumpiness','hole_depth','row_transitions','column_transitions','closed_components','max_well','sum_well','base_value'];
export const OCCUPANCY_NAMES=Array.from({length:200},(_,i)=>`cell_${i}`);
export const featureNames=(geometry:boolean)=>geometry?[...SUMMARY_NAMES,...OCCUPANCY_NAMES]:SUMMARY_NAMES.slice();
export function valueFeatures(board:MaskBoard,geometry=true):number[]{
 const heights=Array(10).fill(0),holes=Array(10).fill(0),rows:number[]=[],bits=Array(200).fill(0);let holeDepth=0,rowTransitions=0,columnTransitions=0,previous=0;
 for(let y=0;y<20;y++){
  const row=board[y];rows.push(POP[row]);columnTransitions+=POP[row^previous];previous=row;let left=1;
  for(let x=0;x<10;x++){
   const occupied=(row>>>x)&1;bits[y*10+x]=occupied;if(occupied!==left)rowTransitions++;left=occupied;
   if(occupied&&!heights[x])heights[x]=20-y;
   if(!occupied&&heights[x]){holes[x]++;holeDepth+=heights[x]-(20-y);}
  }
  if(left!==1)rowTransitions++;
 }
 columnTransitions+=POP[previous^1023];
 const slope=heights.slice(1).map((h,i)=>h-heights[i]);
 const wells=heights.map((h,x)=>Math.max(0,Math.min(x?heights[x-1]:20,x<9?heights[x+1]:20)-h));
 const seen=new Uint8Array(200),queue=new Uint16Array(200);let components=0;
 for(let i=0;i<200;i++)if(!bits[i]&&!seen[i]){
  let head=0,tail=1,open=false;queue[0]=i;seen[i]=1;
  while(head<tail){const at=queue[head++],x=at%10,y=Math.floor(at/10);if(y===0)open=true;
   for(const n of [x?at-1:-1,x<9?at+1:-1,y?at-10:-1,y<19?at+10:-1])if(n>=0&&!bits[n]&&!seen[n]){seen[n]=1;queue[tail++]=n;}
  }
  if(!open)components++;
 }
 const f=maskFeatures(board),result=[...heights,...holes,...slope,...wells,...rows,heights.reduce((a,b)=>a+b,0),slope.reduce((s,v)=>s+Math.abs(v),0),holeDepth,rowTransitions,columnTransitions,components,Math.max(...wells),wells.reduce((a,b)=>a+b,0),-8*f.holes-f.height];
 return geometry?[...result,...bits]:result;
}
// Flat nodes: [feature index (-1 for leaf), threshold/leaf value, left index, right index].
export type Forest={trees:number[][][];link:'identity'|'sigmoid'};
export type ValueBundle={version:2;geometry:boolean;feature_names:string[];residual:Forest;risk:Forest;alpha:number;beta:number;horizon:32;metadata:Record<string,unknown>};
export const sigmoid=(v:number)=>v>=0?1/(1+Math.exp(-v)):Math.exp(v)/(1+Math.exp(v));
export function forestPredict(forest:Forest,values:number[]){
 let sum=0;
 for(const tree of forest.trees){let at=0;for(;;){const n=tree[at];if(n[0]===-1){sum+=n[1];break;}at=values[n[0]]<=n[1]?n[2]:n[3];}}
 return forest.link==='sigmoid'?sigmoid(sum):sum;
}
export function validateBundle(b:ValueBundle){
 if(b.version!==2||b.horizon!==32||JSON.stringify(b.feature_names)!==JSON.stringify(featureNames(b.geometry))||![0,.25,.5,1].includes(b.alpha)||![0,10,40].includes(b.beta))throw new Error('Invalid v2 schema');
 for(const forest of [b.residual,b.risk]){
  if(!['identity','sigmoid'].includes(forest.link)||!forest.trees.length)throw new Error('Invalid forest');
  for(const tree of forest.trees){
   const visit=(at:number,ancestors:Set<number>)=>{
    if(!Number.isInteger(at)||at<0||at>=tree.length||ancestors.has(at))throw new Error('Invalid tree structure');
    const n=tree[at];if(n.length!==4||!n.every(Number.isFinite))throw new Error('Invalid node');
    if(n[0]===-1)return;
    if(!Number.isInteger(n[0])||n[0]<0||n[0]>=b.feature_names.length)throw new Error('Invalid feature');
    const next=new Set(ancestors);next.add(at);visit(n[2],next);visit(n[3],next);
   };visit(0,new Set());
  }
 }
 if(b.residual.link!=='identity'||b.risk.link!=='sigmoid')throw new Error('Invalid model links');
}
export function predictValue(bundle:ValueBundle,board:MaskBoard){
 const values=valueFeatures(board,bundle.geometry),residual=forestPredict(bundle.residual,values),risk=forestPredict(bundle.risk,values);
 if(!Number.isFinite(residual)||!Number.isFinite(risk)||risk<0||risk>1)throw new Error('Invalid prediction');return {residual,risk};
}
export function v2Score(c:FastChoice,bundle:ValueBundle){
 if(!c.next)return {...c,residual:0,risk:1};
 const p=predictValue(bundle,c.next.board);return {...c,...p,score:10*c.total_lines+c.base+bundle.alpha*p.residual-bundle.beta*p.risk};
}
export function topTwo<T extends FastChoice>(choices:T[]):T[]{
 const selected=[...choices].sort((a,b)=>b.score-a.score||a.key-b.key).slice(0,2);return selected.sort((a,b)=>a.key-b.key);
}
export function costRequest(choices:FastChoice[]){
 const best=Math.max(...choices.map(c=>c.score));return {question:'',state:'Min cost',abstention:false,temperature:1,options:choices.map((c,i)=>({id:String(i),text:`cost ${Math.max(0,Math.round(best-c.score))}`}))};
}
