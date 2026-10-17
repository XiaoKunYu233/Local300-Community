'use strict';

// The default opened bag is 192. The native cache can hold 352 instances;
// role storage has 552 records. Worn instances count against opened capacity.
const VISIBLE_CAPACITY = 192, CACHE_CAPACITY = 352, RECORD_CAPACITY = 552;
function validLimits(capacity, records = RECORD_CAPACITY) {
  return Number.isInteger(capacity) && capacity > 0 && capacity <= CACHE_CAPACITY &&
    Number.isInteger(records) && records >= capacity && records <= RECORD_CAPACITY;
}
function findStack(bag, capacity, stackMax, reserved, matches) {
  return [...bag].find(([slot,item]) => Number.isInteger(slot) && slot >= 0 && slot < capacity &&
    !reserved.has(slot) && Number.isSafeInteger(item?.count) && item.count > 0 &&
    item.count < stackMax && matches(item))?.[0];
}
function findFree(bag, capacity, reserved) {
  for(let slot=0;slot<capacity;slot++) if(!bag.has(slot)&&!reserved.has(slot))return slot;
  return undefined;
}

// Offline recovery is a pure plan: preserve every instance, GUID and metadata.
// Equipped items are also displayed in the ordinary bag. Never hide a worn
// instance to make room for a reward or a returned item.
function recoverVisible(inventory, equipment, {capacity=VISIBLE_CAPACITY,records=RECORD_CAPACITY}={}) {
  if(!(inventory instanceof Map)||!(equipment instanceof Map)||!validLimits(capacity,records))
    return {ok:false,reason:'invalid-capacity'};
  const bag=new Map(inventory),equipped=new Map(equipment),reserved=new Set(),moves=[];
  for(const [slot,item]of bag)if(!Number.isInteger(slot)||slot<0||slot>=records||!item)
    return {ok:false,reason:'invalid-record'};
  const hex=guid=>Buffer.isBuffer(guid)?guid.toString('hex'):String(guid||'').toLowerCase();
  for(const [pos,e]of equipped){
    const held=bag.get(e.bagSlot);
    if(!held||held.itemId!==e.itemId||held.count!==e.count||hex(held.guid)!==hex(e.guid)||
      reserved.has(e.bagSlot))return {ok:false,reason:'invalid-equipment'};
    reserved.add(e.bagSlot);
  }
  const hidden=[...bag].filter(([slot])=>slot>=capacity).sort((a,b)=>a[0]-b[0]);
  let free=Array.from({length:capacity},(_,slot)=>slot).filter(slot=>!bag.has(slot)&&!reserved.has(slot));
  if(free.length<hidden.length)return {ok:false,reason:'bag-full',overflow:hidden.length-free.length};
  free.sort((a,b)=>a-b);
  hidden.forEach(([from,item],index)=>{
    const to=free[index];bag.set(to,item);bag.delete(from);
    for(const [pos,e]of equipped)if(e.bagSlot===from){
      equipped.set(pos,{...e,bagSlot:to});
    }
    moves.push({kind:'bag',from,to,itemId:item.itemId,count:item.count,guid:hex(item.guid)});
  });
  return {ok:true,bag,equipped,moves};
}
module.exports={VISIBLE_CAPACITY,CACHE_CAPACITY,RECORD_CAPACITY,validLimits,findStack,findFree,recoverVisible};
