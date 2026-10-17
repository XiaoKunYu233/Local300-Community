'use strict';

// This is connection-local delivery bookkeeping, never an ownership grant.
// Only call stage with the authoritative frame and its own Encoder output.
// Call written after socket.write returns (false is accepted backpressure),
// and only after the outer SQLite transaction has committed. Dropped queue
// entries must be discarded. Full 1337 snapshots keep their existing rules.
const ROW_SIZE=182, MESSAGE=1338, FLAGS=0xd3;

function signatures(frame,stream) {
  if(!Buffer.isBuffer(frame)||frame.length<16||frame.readUInt32LE(0)!==frame.length||
    frame.readUInt32LE(4)!==stream||frame.readUInt16LE(8)!==MESSAGE||frame.readUInt16LE(10)!==FLAGS)return null;
  const count=frame.readUInt32LE(12);
  if(count<1||count>4096||frame.length!==16+count*ROW_SIZE)return null;
  const rows=new Map();
  for(let p=16;p<frame.length;p+=ROW_SIZE) {
    const hero=frame.readUInt16LE(p),mask=frame.readUInt32LE(p+8),selected=frame.readUInt16LE(p+180);
    if(hero<1||hero>=65535||rows.has(hero)||!(mask&1)||selected>31||!(mask>>>selected&1))return null;
    rows.set(hero,mask+':'+selected);
  }
  return rows;
}

function createTracker({getSignatures,canApply,stream}) {
  if(typeof getSignatures!=='function'||typeof canApply!=='function'||!Number.isSafeInteger(stream)||stream<1||stream>0xffffffff)
    throw Error('Invalid hero delivery tracker context');
  const pending=new WeakMap();
  function context() {
    try {
      if(canApply()!==true)return null;
      const epoch=getSignatures();
      return epoch instanceof Map?epoch:null;
    }catch{return null;}
  }
  function stage(frame,bytes) {
    if(!Buffer.isBuffer(bytes))return false;
    // A rejected restaging cannot leave an earlier action on a reused key.
    pending.delete(bytes);
    const epoch=context(),rows=signatures(frame,stream);
    if(!epoch||!rows||bytes.length!==frame.length)return false;
    for(const id of rows.keys())if(!epoch.has(id))rows.delete(id);
    if(!rows.size||context()!==epoch)return false;
    pending.set(bytes,{epoch,rows,bytes:Buffer.from(bytes)});
    return true;
  }
  function written(bytes) {
    if(!Buffer.isBuffer(bytes))return 0;
    const action=pending.get(bytes);
    pending.delete(bytes);
    if(!action||context()!==action.epoch||!bytes.equals(action.bytes))return 0;
    let updated=0;
    for(const [id,signature]of action.rows)if(action.epoch.has(id)) {
      action.epoch.set(id,signature);updated++;
    }
    return updated;
  }
  function discard(bytes) {if(Buffer.isBuffer(bytes))pending.delete(bytes);}
  return Object.freeze({stage,written,discard});
}

module.exports={createTracker};
