'use strict';
// Native 17042..17049 and 17060..17067. See research/crafting-20261009.
const {mkFrame}=require('./bag');
const catalog=new Map(require('../data/current-client/item_item.json').map(r=>[r[1],r]));
const guid=item=>Buffer.isBuffer(item?.guid)?item.guid.toString('hex'):String(item?.guid||'').toLowerCase();
const tags=new Map([[17042,['warehouse','list']],[17044,['warehouse','put']],[17046,['warehouse','take']],
  [17048,['warehouse','expand']],[17060,['exstore','list']],[17062,['exstore','put']],
  [17064,['exstore','take']],[17066,['exstore','expand']]]);
function matches(tag,p){return tags.has(tag)||(tag===17003&&p.length===14&&(p[6]===2||p[9]===2));}
function parse(tag,p){
  if(tag===17003){
    if(p.length!==14||![0,2].includes(p[6])||![0,2].includes(p[9]))throw Error('storage-invalid-request');
    return {system:'warehouse',operation:'swap',from:p[6],to:p[9],a:p.readUInt16LE(7),b:p.readUInt16LE(10)};
  }
  const spec=tags.get(tag);if(!spec)throw Error('storage-invalid-request');
  const [system,operation]=spec,r={system,operation,ids:[]};
  if(operation==='list'||operation==='expand'){if(p.length)throw Error('storage-invalid-request');return r;}
  if(system==='warehouse'){if(p.length!==8)throw Error('storage-invalid-request');r.ids=[p.toString('hex')];}
  else {
    if(p.length<2)throw Error('storage-invalid-request');const n=p.readUInt16LE();
    if(n<1||n>170||p.length!==2+n*8)throw Error('storage-invalid-request');
    r.ids=Array.from({length:n},(_,i)=>p.subarray(2+i*8,10+i*8).toString('hex'));
  }
  if(new Set(r.ids).size!==r.ids.length||r.ids.some(id=>/^0+$|^f+$/.test(id)))throw Error('storage-invalid-request');
  return r;
}
function prepare({request:r,state,bag,bagCapacity,reserved=new Set(),equipped=new Set(),locked=()=>false,
  stackable=id=>!['armour','weapon','treasure','magicgemequip'].includes(catalog.get(id)?.[10]),diamonds=0,record}){
  const next=structuredClone(state),slots=new Map([...bag].map(([s,v])=>[s,structuredClone(v)])),changed=new Set();
  let cost=0;
  const validate=item=>{
    if(!item||!/^[a-f0-9]{16}$/.test(guid(item)))throw Error('storage-item-not-found');
    if(equipped.has(guid(item)))throw Error('storage-equipped');
    if(item.locked||Number(item.unlockAt)>0||Number(item.lockEndTime)>0||locked(guid(item)))throw Error('storage-locked');
    if(r.system==='warehouse'&&catalog.get(item.itemId)?.[17]!==1)throw Error('storage-not-storable');
    if(r.system==='exstore'&&(stackable(item.itemId)||item.count!==1))throw Error('storage-stackable');
  };
  const snapshot=(item,slot)=>({...item,instanceHex:record?record(item,slot).subarray(0,490).toString('hex'):item.instanceHex});
  const free=(has,capacity,skip=new Set())=>{for(let i=0;i<capacity;i++)if(!has(i)&&!skip.has(i))return i;throw Error('storage-full');};
  if(r.operation==='expand'){
    if(next.capacity>=168)throw Error('storage-max-capacity');
    // Wallet attribute 72 is stored in hundredths of one displayed diamond.
    cost=(next.capacity<=42?42:next.capacity<=84?84:168)*100;
    if(!Number.isFinite(diamonds)||diamonds<cost)throw Error('storage-diamonds');
    next.capacity=Math.min(168,next.capacity+42);
  }else if(r.operation==='swap'){
    const from=r.from===0?slots:new Map(Object.entries(next.items).map(([s,v])=>[+s,v]));
    const to=r.to===r.from?from:r.to===0?slots:new Map(Object.entries(next.items).map(([s,v])=>[+s,v]));
    if(r.a>=(r.from===0?bagCapacity:next.capacity)||r.b>=(r.to===0?bagCapacity:next.capacity))throw Error('storage-invalid-request');
    const a=from.get(r.a),b=to.get(r.b);if(!a)throw Error('storage-item-not-found');
    for(const [container,slot,item] of [[r.from,r.a,a],[r.to,r.b,b]]){
      if(container===0&&(reserved.has(slot)||(item&&equipped.has(guid(item)))))throw Error('storage-equipped');
      if(item)validate(item);
    }
    if(r.from===r.to&&r.a===r.b)return {state:next,bag:slots,changedSlots:[],cost};
    if(b)from.set(r.a,r.to===0?snapshot(b,r.b):b);else from.delete(r.a);
    to.set(r.b,r.from===0?snapshot(a,r.a):a);
    next.items=Object.fromEntries(r.from===2?from:to);
    if(r.from===0)changed.add(r.a);if(r.to===0)changed.add(r.b);
  }else if(r.operation==='put'||r.operation==='take'){
    for(const id of r.ids){
      if(r.operation==='put'){
        const hit=[...slots].find(([,v])=>guid(v)===id);if(!hit)throw Error('storage-item-not-found');
        const [slot,item]=hit;validate(item);
        if(Object.values(next.items).some(v=>guid(v)===id))throw Error('storage-duplicate');
        const dest=free(s=>Object.hasOwn(next.items,s),next.capacity);
        next.items[dest]=snapshot(item,slot);slots.delete(slot);changed.add(slot);
      }else{
        const hit=Object.entries(next.items).find(([,v])=>guid(v)===id);if(!hit)throw Error('storage-item-not-found');
        if([...slots.values()].some(v=>guid(v)===id))throw Error('storage-duplicate');
        const [slot,item]=hit,dest=free(s=>slots.has(s),bagCapacity,reserved);
        slots.set(dest,{...item});delete slots.get(dest).exstoreSlot;delete next.items[slot];changed.add(dest);
      }
    }
  }
  // The native list reader keys its cache by ordinal, ignoring record slots.
  next.items=Object.fromEntries(Object.entries(next.items).sort((a,b)=>+a[0]-b[0]).map(([,v],i)=>[i,v]));
  return {state:next,bag:slots,changedSlots:[...changed],cost};
}
function listFrame(system,state,record){
  const entries=Object.entries(state.items).sort((a,b)=>+a[0]-b[0]);
  const p=Buffer.alloc(4+493*entries.length);p.writeUInt16LE(state.capacity);p.writeUInt16LE(entries.length,2);
  entries.forEach(([slot,item],i)=>{const at=4+i*493;p[at]=system==='warehouse'?2:0;p.writeUInt16LE(+slot,at+1);record(item,+slot).copy(p,at+3,0,490);});
  return mkFrame(system==='warehouse'?17043:17061,p,{flags:2});
}
function acknowledgement(tag,p,result){
  if(tag===17003)return null;
  if(tag===17044||tag===17046)return mkFrame(tag+1,Buffer.concat([p,Buffer.alloc(4)]),{flags:2});
  if(tag===17048){const b=Buffer.alloc(6);b.writeUInt16LE(result.state.capacity);return mkFrame(17049,b,{flags:2});}
  return mkFrame(tag+1,p,{flags:2});
}
module.exports={matches,parse,prepare,listFrame,acknowledgement};
