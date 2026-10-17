'use strict';
const crypto=require('node:crypto');
// Current 300.exe c527ae76: db6ff0 reads cached item +4f/+56/+5d
// (applied), +da/+e1/+e8 (pending). Cache entry has a 3-byte bag prefix;
// its item ID is +3 and GUID +b, so the raw 490-byte record uses 76/215.
function patch(record,held,state){
 if(!Buffer.isBuffer(record)||record.length<257||!held?.guid||
    record.readUInt32LE(0)!==held.itemId||record.subarray(8,16).toString('hex')!==held.guid.toLowerCase())return false;
 const applied=state.getApplied(held.guid),pending=state.get(held.guid),valid=v=>v?.itemId===held.itemId&&/^[0-9a-f]{84}$/.test(v.candidateHex);
 if(valid(applied))Buffer.from(applied.candidateHex,'hex').copy(record,76);
 // Always clear historical capture candidates, including after apply/cancel.
 record.fill(0,215,257);
 if(valid(pending)&&pending.baselineHash===crypto.createHash('sha256').update(record.subarray(76,118)).digest('hex'))
  Buffer.from(pending.candidateHex,'hex').copy(record,215);
 return true;
}
module.exports={patch};
