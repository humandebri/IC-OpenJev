// Bound the entire transfer, including response bodies. Abort alone is not a
// deadline: a stalled transport must not prevent other policies from starting.
export async function loadAssetWithin<T>(load:(signal:AbortSignal)=>Promise<T>,milliseconds:number):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([load(controller.signal),new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>{reject(new Error('Evaluator loading timed out'));controller.abort();},milliseconds);
 })]);}finally{clearTimeout(timer);controller.abort();}
}
