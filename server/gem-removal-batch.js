'use strict';

// The native one-click button sends four ordinary remove requests (0..3),
// sometimes repeatedly. There is no remove-all bit on the wire. Hold only a
// possible prefix briefly, so TCP fragmentation cannot turn it into four
// independent commits. Right-click requests keep their single-socket meaning.
const allRequests=new WeakSet();
function input(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==17||frame.readUInt32LE(0)!==17||
    frame.readUInt16LE(8)!==13631||frame[12]>2||frame[13]>5||frame[14]>3||
    frame[15]!==0||frame[16]!==1)return null;
  return {plan:frame[12],grid:frame[13],socket:frame[14],header:frame.subarray(4,12).toString('hex')};
}
class GemRemovalBatch {
  constructor({deliver,frameOf=value=>value,waitMs=40,setTimer=setTimeout,clearTimer=clearTimeout}={}){
    if(typeof deliver!=='function')throw TypeError('Gem removal delivery is required');
    Object.assign(this,{deliver,frameOf,waitMs,setTimer,clearTimer});this.pending=[];this.timer=null;this.closed=false;
  }
  flush(){
    if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
    const pending=this.pending;this.pending=[];
    if(pending.length&&!this.closed)this.deliver(pending);
  }
  push(values){
    if(this.closed)return;
    const ready=[];
    const deliverReady=()=>{if(ready.length)this.deliver(ready.splice(0));};
    for(const value of values){
      const next=input(this.frameOf(value));
      if(this.pending.length){
        const first=input(this.frameOf(this.pending[0]));
        if(next&&next.plan===first.plan&&next.grid===first.grid&&next.header===first.header&&next.socket===this.pending.length){
          this.pending.push(value);
          if(this.pending.length===4){
            this.clearTimer(this.timer);this.timer=null;
            const firstValue=this.pending[0];this.pending=[];
            allRequests.add(this.frameOf(firstValue));ready.push(firstValue);
          }
          continue;
        }
        ready.push(...this.pending);this.pending=[];
        this.clearTimer(this.timer);this.timer=null;
      }
      if(next?.socket===0){
        deliverReady();this.pending=[value];this.timer=this.setTimer(()=>this.flush(),this.waitMs);
      }else ready.push(value);
    }
    deliverReady();
  }
  close(){this.closed=true;this.pending=[];if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
}
module.exports={GemRemovalBatch,isRemoveAll:frame=>allRequests.has(frame)};
