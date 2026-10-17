'use strict';
// The generic 11007 status envelope is the same one checked against the
// original captures by black-rock-native. Only installed level-1 status IDs
// are projected; saved succinct grades are not native status levels.
const entries=require('./war-soul-entry-effects');
const {statusPacket}=require('./black-rock-native');
const available=new Set(require('../data/current-client/skill_statuslist.json')
  .filter(row=>Number(row[2])===1).map(row=>Number(row[1])));
const synchronized=new WeakMap();
function snapshot(sim,hero){
  const out=new Map();if(!hero?.alive)return out;
  const add=(id,until)=>{
    if(!available.has(id)||!(until>sim.time))return;
    const old=out.get(id);if(!old||until>old.until)out.set(id,{id,level:1,instance:1,until});
  };
  const model=entries.aggregate(hero),forest=model.elements.forest.core;
  if(forest?.eligible)add(forest.statusId,Infinity);
  for(const buff of hero.buffs||[])if(buff.warSoulEntry)
    add(Number(buff.nativeStatusId||buff.statusId),buff.until);
  return out;
}
function sync(sim,hero,{force=false}={}){
  if(hero?.kind!=='hero')return [];
  const saved=force?null:synchronized.get(hero),sameLife=saved?.sim===sim&&saved.life===hero.reviveCount;
  const next=snapshot(sim,hero),old=sameLife?saved.snapshot:new Map(),packets=[];
  for(const [id,entry]of old)if(!next.has(id))packets.push(statusPacket(hero,entry,sim.time,{remove:true,skin:hero.skinId??0}));
  for(const [id,entry]of next){
    const before=old.get(id);if(!before||before.until!==entry.until)
      packets.push(statusPacket(hero,entry,sim.time,{skin:hero.skinId??0}));
  }
  synchronized.set(hero,{sim,life:hero.reviveCount,snapshot:next});return packets;
}
module.exports={snapshot,sync};
