'use strict';
// Reuses the independently verified common 11007 add/remove envelope.
// These are candidate state packets, not native-client visual acceptance.
const path=require('path'),W=require(path.resolve(__dirname,'../../../battle-wire')),
 P=require(path.resolve(__dirname,'../../../battle-protobuf'));
const snapshot=require('./snapshot.json'),known=new Set(snapshot.statuses.map(x=>`${x.named.nStatusID}:${x.named.nLevel}`));
const previous=new WeakMap(),val=(number,value)=>({number,wire:0,value:BigInt(value)});
function statePacket(entity,state,now,{remove=false}={}){
 if(!known.has(`${state.id}:${state.level}`))throw Error('Unknown Emiya native status');
 const owner=state.owner||entity,skin=owner.skinId??0;
 const fields=[val(2,owner.id),...(remove?[]:[val(3,owner.heroId)]),val(5,state.id),val(6,state.level),
  ...(remove?[val(7,3)]:[]),...(Number.isFinite(state.until)?[val(9,Math.max(1,Math.round((state.until-now)*1000)))]:[]),
  val(10,1),val(11,skin)];
 const body=P.encode(fields);return W.frame(11007,entity.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function states(sim,entity){const next=new Map(),s=entity.emiyaBase;
 const add=(id,level,until,owner=entity)=>{if(until>sim.time)next.set(`${owner.id}:${id}`,{id,level,until,owner});};
 if(entity.alive&&s?.sim===sim){
  if(s.q.stage)add(s.q.stage===1?13954:13955,1,s.q.until);
  if(s.w)add(13959,s.levels.W,s.w.at+4.5);
  if(s.e?.layers>0)add(13966,1,s.e.until);
  if(s.r)add(26041,1,s.r.until);
 }
 if(entity.alive)for(const [owner,d]of entity.emiyaDebuffs||[])if(sim.entities.get(owner.id)===owner&&owner.alive){
  if(d.w?.life===entity.reviveCount)add(13958,1,d.w.until,owner);
  if(d.r?.life===entity.reviveCount)add(26042,d.r.rank,d.r.until,owner);
 }
 return next;
}
function sync(sim,entity,{force=false}={}){
 const next=states(sim,entity),old=previous.get(entity)||new Map(),packets=[];
 for(const [key,state]of old){const current=next.get(key);if(!current||current.level!==state.level||current.owner!==state.owner)
   packets.push(statePacket(entity,state,sim.time,{remove:true}));}
 for(const [key,state]of next){const prior=old.get(key);if(force||!prior||prior.level!==state.level||prior.until!==state.until||prior.owner!==state.owner)
   packets.push(statePacket(entity,state,sim.time));}
 previous.set(entity,next);return packets;
}
module.exports={statePacket,states,sync};
