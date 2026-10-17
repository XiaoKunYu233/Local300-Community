'use strict';
// Native equipment forging. Fixed ceilings follow confirmed user semantics;
// count/ratio bands, material limits and pity are supplied by the client.
const rules=require('./equipment-forge-rules'),enhancement=require('./enhancement-rules');
const {fields}=require('./equipment-inheritance'),{cleanGuid}=require('./equipment-crafting');
const armour=new Map(require('../data/current-client/item_armour.json').map(r=>[r[1],r]));
const clone=structuredClone,hex=v=>Buffer.isBuffer(v)?v.toString('hex'):String(v||'').toLowerCase();
const rowToCode=new Map([...rules.byCode.values()].map(a=>[a.rowId,a.id]));
function applied(state,guid){const a=state.applied?.[hex(guid)];return Array.isArray(a)?clone(a):[];}
function lockMask(state,guid){return state.nativeForge?.[hex(guid)]?.lockMask||0;}
function pending(state,guid){return state.nativeForge?.[hex(guid)]?.candidate||null;}
function validPlans(state,plans,updates={}){
  const counts=new Map();
  for(const [pos,e] of plans){
    const key=hex(e.guid),attrs=Object.hasOwn(updates,key)?updates[key]:applied(state,key);
    if(!attrs?.length)continue;
    const plan=Math.floor(pos/6),guids=counts.get(plan)||new Set();guids.add(key);counts.set(plan,guids);
    if(guids.size>1)return false;
  }
  return true;
}
function inputs(itemId,level){
  const row=armour.get(itemId),base=rules.fromArmour(row);
  const raised=enhancement.attributesFor(itemId,level,{currentClient:true});
  const enhanced=Object.fromEntries(Object.entries(fields).map(([id,col])=>[id,
    raised[Object.keys(enhancement.ARMOUR_FIELDS).find(k=>enhancement.ARMOUR_FIELDS[k]===col)]??base[id]]));
  return {base,enhanced};
}
function prepare(state,tag,payload,instance,{random=Math.random,plans=new Map()}={}){
  try{
    const lengths={13610:16,13612:9,13614:9,13616:12,13618:9};
    if(payload.length!==lengths[tag])throw Error('invalid-forge-packet');
    if((tag===13610||tag===13616)&&payload.readUInt32LE(8)===0)
      throw Error(tag===13610?'forge-material-not-selected':'wash-material-not-selected');
    const guid=cleanGuid(payload.subarray(0,8).toString('hex'));
    if(!instance||hex(instance.guid)!==guid||!armour.has(instance.itemId)||!enhancement.eligibility(instance.itemId).supported)throw Error('invalid-forge-instance');
    // Reforge occupies bytes 76..117; forging occupies 266..485. Keep the
    // independent reforge candidate intact instead of blocking all forge actions.
    if(instance.locked)throw Error('forge-equipment-locked');
    // Check every saved loadout both before spending and on application, so
    // equipping a pending un-forged item cannot bypass the one-item limit.
    if((tag===13610||((tag===13612||tag===13618)&&payload[8]===1&&
      state.nativeForge?.[guid]?.candidateOperation!=='wash'))&&
      [...plans.values()].some(e=>hex(e.guid)===guid))throw Error('forge-equipment-must-be-unequipped');
    const next=clone(state);next.applied??={};next.nativeForge??={};next.pity??={};
    const entry=next.nativeForge[guid]??={lockMask:0,candidate:null};
    const current=applied(next,guid);let costs={},changedApplied=false;
    if(tag===13614){rules.quote(7901,current,payload[8]);entry.lockMask=payload[8];}
    else if(tag===13612||tag===13618){
      if(payload[8]>1)throw Error('invalid-forge-choice');
      if(payload[8]===0){delete next.applied[guid];entry.candidate=null;entry.lockMask=0;changedApplied=true;}
      else{
        if(!entry.candidate)throw Error('no-pending-forge');
        if(!validPlans(next,plans,{[guid]:entry.candidate}))throw Error('one-forged-equipment-per-plan');
        next.applied[guid]=clone(entry.candidate);entry.candidate=null;entry.lockMask=entry.candidateMask||0;changedApplied=true;
      }
    }else if(tag===13616){
      const wash=rules.washCurrent({current,materialId:payload.readUInt32LE(8),lockMask:entry.lockMask,random});
      costs=wash.costs;entry.candidate=wash.candidate.map((a,i)=>entry.lockMask&(1<<i)?a:{...a,ratio:a.maximum?a.value/a.maximum:0});entry.candidateMask=entry.lockMask;
      entry.candidateOperation='wash';
    }else{
      const materialId=payload.readUInt32LE(8),wishId=rowToCode.get(payload.readUInt32LE(12));
      const {base,enhanced}=inputs(instance.itemId,instance.level);
      const selected=rules.selection({current,lockMask:entry.lockMask,materialId,wishId,pity:next.pity[materialId]||0,base,
        random,selectAttribute:(pool,r)=>pool[Math.floor(r()*pool.length)].id});
      costs=selected.costs;next.pity[materialId]=selected.pity;
      if(selected.keptOnlyLocks&&selected.locked.length===current.length)entry.candidate=selected.locked;
      else{
        const maxima=rules.fixedMaxima({base,enhanced,ids:selected.ids,materialId});
        // Keep the exact inputs for investigating a player's displayed maxima.
        // Selection and the current-value RNG remain local policies.
        entry.calculation={itemId:instance.itemId,level:instance.level,materialId,base,enhanced,
          budgets:rules.budget({base,enhanced}),shares:rules.deterministicShares(base,selected.ids),maxima,policy:'deterministic-weighted-ceilings-v3'};
        const rolled=rules.washCurrent({current:maxima,materialId:7905,random}).candidate;
        entry.candidate=rolled.map(attr=>{
          const old=selected.locked.find(a=>a.id===attr.id);
          const ratio=old?(old.ratio??(old.maximum?old.value/old.maximum:0)):(attr.maximum?attr.value/attr.maximum:0);
          const value=old?(old.maximum===attr.maximum?old.value:Math.floor(attr.maximum*ratio)):attr.value;
          return {...attr,value,ratio,quality:selected.level};
        });
      }
      entry.materialId=materialId;
      entry.candidateOperation='forge';
      entry.candidateMask=entry.candidate.reduce((mask,a,i)=>mask|(selected.locked.some(v=>v.id===a.id)?1<<i:0),0);
    }
    return {ok:true,state:next,guid,costs,changedApplied};
  }catch(error){return {ok:false,reason:error.message};}
}
// CEquipment cache includes a 3-byte container prefix. 0x14b5400 reads
// current lock/id/value/max at 0x10d/10e/112/116, candidate +110; stride 22.
// Tooltip 15c2d12 reads slot+18 as 80/90/100/110 and selects white/green/
// yellow/purple. 104fa74 also decodes this byte into cache+11f.
// Never carry another GUID's captured forging into a generated record.
function patchRecord(record,state,guid){
  if(record.length<486)throw Error('short-forge-record');
  record.fill(0,266,486);
  for(const [start,attrs,mask] of [[266,applied(state,guid),lockMask(state,guid)],[376,pending(state,guid)||[],0]]){
    attrs.forEach((attr,i)=>{if(i>=5)throw Error('too-many-forge-entries');const o=start+i*22;
      record[o]=mask&(1<<i)?1:0;record.writeUInt32LE(rules.byCode.get(attr.id).rowId,o+1);
      record.writeUInt32LE(attr.value,o+5);record.writeUInt32LE(attr.maximum,o+9);
      if(Number.isInteger(attr.quality)&&attr.quality>=1&&attr.quality<=4)
        record.writeUInt32LE(70+10*attr.quality,o+18);
    });
  }
  return record;
}
function acknowledgement(tag,payload){return require('./bag').mkFrame(tag+1,payload,{flags:2});}
module.exports={prepare,patchRecord,applied,pending,lockMask,validPlans,inputs,acknowledgement};
