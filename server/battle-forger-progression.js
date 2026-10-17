'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const stateFiles=require('./persistence/state-files'),fs=stateFiles.io;
const equipmentTypes=new Set(['equip','armour','weapon','treasure']);
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function project(entries,enhancement,{catalog=require('./current-item-catalog').load().byId}={}){
  const owned=new Map(),qualifying=new Set(),unresolvedItemIds=new Set();
  for(const entry of entries){
    if(!entry||!Number.isSafeInteger(entry.itemId)||entry.itemId<1||!Number.isSafeInteger(entry.count)||entry.count<1||!(/^[a-f0-9]{16}$/i.test(entry.guid||''))||/^0{16}$/.test(entry.guid))throw Error('Invalid forger owned instance');
    const guid=entry.guid.toLowerCase(),old=owned.get(guid);
    if(old&&old.itemId!==entry.itemId)throw Error('Forger owned GUID identity changed');
    if(old)continue;
    const level=enhancement.get(guid,entry.itemId),row=catalog[entry.itemId];
    owned.set(guid,{itemId:entry.itemId,guid,level});
    if(!row){unresolvedItemIds.add(entry.itemId);continue;}
    if(equipmentTypes.has(row.type)&&level>=15)qualifying.add(entry.itemId);
  }
  // charmexeffect 21: every qualifying item type counts once; the first 100
  // grant 1 AD/1.5 AP each and only the subsequent items grant 2 AD/3 AP.
  const count=qualifying.size,units=Math.min(count,100)+Math.max(0,count-100)*2;
  return {count,attack:100+units,abilityPower:150+units*1.5,profile:{
    rule:'bag-and-warehouse-owned-unique-itemId-enhancement-at-least-15',
    count,itemIds:[...qualifying].sort((a,b)=>a-b),ownedInstanceCount:owned.size,
    unresolvedItemIds:[...unresolvedItemIds].sort((a,b)=>a-b),
    complete:unresolvedItemIds.size===0,ownershipSha256:sha([...owned.values()].sort((a,b)=>a.guid.localeCompare(b.guid)))}};
}
function readJSON(file,missing){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return missing;throw error;}}
function bind(directory,file){
  if(!path.isAbsolute(file)||path.dirname(path.resolve(file))!==directory)throw Error('Forger state is outside current loadout account');
  if(require('node:fs').realpathSync(path.dirname(file))!==require('node:fs').realpathSync(directory))throw Error('Forger state directory binding mismatch');
  return file;
}
function read(file,{enhancementFile=path.join(path.dirname(file),'enhancement-state.json'),
  bagFile=path.join(path.dirname(file),'bag-state.live.json'),warehouseFile=path.join(path.dirname(file),'warehouse-state.json')}={}){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('Forger absolute loadout path required');
  const directory=path.dirname(path.resolve(file));
  for(const input of [enhancementFile,bagFile,warehouseFile])bind(directory,input);
  return stateFiles.readSnapshot(()=>{
    const snapshot=readJSON(file+'.snapshot',{}),base=readJSON(path.join(directory,'bag-state.json'),{});
    const inventory={...(snapshot.inventory||base.slots||{})},live=readJSON(bagFile,{});
    // The live file is a delta: explicit tombstones remove old snapshot items.
    for(const [slot,item]of Object.entries(live.slots||{})){if(item===null)delete inventory[slot];else inventory[slot]=item;}
    const warehouse=readJSON(warehouseFile,{version:1,items:{}});
    if(warehouse.version!==1||!warehouse.items||Array.isArray(warehouse.items)||typeof warehouse.items!=='object')throw Error('Invalid forger warehouse state');
    const enhancement=new(require('./enhancement-state').EnhancementState)(enhancementFile);
    const result=project([...Object.values(inventory),...Object.values(warehouse.items)].filter(Boolean),enhancement);
    result.profile.sources={bag:path.basename(bagFile),warehouse:path.basename(warehouseFile),enhancement:path.basename(enhancementFile)};
    return result;
  });
}
module.exports={read,project};
