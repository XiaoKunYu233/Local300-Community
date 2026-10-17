'use strict';
// Equipment restrictions must use the same normal client table as item identity
// and combat statistics. Keep the old capture only for legacy-only item IDs.
const {loadConfig}=require('./runtime/catalogs');
const rows=new Map(loadConfig('legacy-equipment-items').data.map(r=>[r[1],r]));
for(const row of loadConfig('current-items').data)rows.set(row[1],row);
const guidHex=value=>Buffer.isBuffer(value)?value.toString('hex'):String(value||'').toLowerCase();
// SItem_Item field 55 = nEquipType. Native 永恒神器 is type 7,
// independently of the broad armour/treasure item family.
function exclusiveGroup(id){const row=rows.get(id);return row?.[55]===7?'eternal-artifact':row?.[10]==='treasure'?'treasure':null;}
function conflicts(a,b){const group=exclusiveGroup(a);return !!group&&group===exclusiveGroup(b);}
function eternalConflict(item,equipped){
  if(exclusiveGroup(item.itemId)!=='eternal-artifact')return null;
  return [...equipped].find(e=>e&&exclusiveGroup(e.itemId)==='eternal-artifact'&&guidHex(e.guid)!==guidHex(item.guid))||null;
}
function normalize(slots){
  const groups=new Set(),guids=new Set(),out=[];
  for(const e of [...slots].sort((a,b)=>a.slot-b.slot)){
    const group=exclusiveGroup(e.itemId),guid=guidHex(e.guid);
    if((group&&groups.has(group))||(guid&&guids.has(guid)))continue;
    if(group)groups.add(group);if(guid)guids.add(guid);out.push(e);
  }
  return out;
}
function planEquip(inventory,equipped,bagSlot,pos,{capacity=192,records=552,forgeFor=e=>e?.forge}={}){
  const item=inventory.get(bagSlot);
  if(!Number.isInteger(bagSlot)||bagSlot<0||bagSlot>=capacity||!Number.isInteger(pos)||pos<0||pos>=6||!item)
    return {ok:false,reason:'invalid-input'};
  if(eternalConflict(item,equipped.values()))return {ok:false,reason:'eternal-conflict'};
  const next=new Map(equipped);
  for(const [other,e]of next)if(other!==pos&&
    (guidHex(e.guid)===guidHex(item.guid)||conflicts(item.itemId,e.itemId)))next.delete(other);
  next.set(pos,{bagSlot,itemId:item.itemId,count:item.count,guid:Buffer.from(guidHex(item.guid),'hex')});
  if([...next.values()].filter(e=>forgeFor(inventory.get(e.bagSlot)||e)?.length).length>1)
    return {ok:false,reason:'one-forged-equipment-per-plan'};
  return require('./inventory-capacity').recoverVisible(inventory,next,{capacity,records});
}
module.exports={exclusiveGroup,conflicts,eternalConflict,normalize,planEquip};
