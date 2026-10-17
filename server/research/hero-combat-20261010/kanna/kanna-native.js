'use strict';
// SStatusNotice fields come from the installed protocol schema. These are
// candidate native Kanna status frames, tested structurally but not in client.
// A cloud is not cloned from BRS type13/ray frames here.
const P=require('../../../battle-protobuf'),W=require('../../../battle-wire'),snapshot=require('./snapshot.json');
const statuses=new Set(snapshot.statuses.map(r=>`${r.named.nStatusID}:${r.named.nLevel}`));
const visionSynced=new WeakMap(),linksSynced=new WeakMap(),val=(number,value)=>({number,wire:0,value:BigInt(value)});
function statusPacket(source,entry,now,{remove=false,skin=source.skinId??source.skin??0}={}){
  if(!statuses.has(`${entry.id}:${entry.level||1}`))throw Error('Unknown installed Kanna status');
  const fields=[...(entry.sourceActorId?[val(2,entry.sourceActorId)]:[]),...(remove?[]:[val(3,234)]),val(5,entry.id),val(6,entry.level||1),...(remove?[val(7,3)]:[]),
    ...(!remove&&Number.isFinite(entry.until)?[val(9,Math.max(1,Math.round((entry.until-now)*1000)))]:[]),val(10,entry.overlap||1),val(11,skin)];
  const body=P.encode(fields);return W.frame(11007,entry.actor??source.id,Buffer.concat([Buffer.from([body.length]),body]));
}
function ownSnapshot(sim,e){const out=new Map(),s=e.kannaBattle,es=e.kannaEnergy;if(!s||s.closed||!es||!e.alive||s.life!==e.reviveCount)return out;
  const add=(id,until=Infinity,overlap=1)=>{if(until>sim.time+1e-8)out.set(id,{id,level:1,actor:e.id,life:e.reviveCount,until,overlap});};
  if(es.charging){add(20002);add(20031);}if(es.energy>0)add(20012,Infinity,es.energy);if(es.speedUntil>sim.time)add(20026,es.speedUntil);
  if(s.cloud)add(20005,s.cloud.expiresAt);const falling=[...s.pending.values()].filter(p=>p.kind==='R').sort((a,b)=>b.at-a.at)[0];if(falling)add(20004,falling.at);
  return out;
}
function visionSnapshot(sim){const out=new Map();for(const t of sim.entities.values()){
  if(!t.alive||!t.kannaReveals)continue;const active=[...t.kannaReveals.values()].filter(r=>r.source?.alive&&!r.source.kannaBattle?.closed&&r.source.reviveCount===r.sourceLife&&r.targetLife===t.reviveCount&&r.until>sim.time+1e-8);
  if(active.length){const latest=active.sort((a,b)=>b.until-a.until||a.source.id-b.source.id)[0];out.set(t.id,{id:20010,level:1,actor:t.id,life:t.reviveCount,until:latest.until,overlap:1,source:latest.source});}}return out;}
function linkSnapshot(sim){const out=new Map();for(const owner of sim.entities.values()){
  if(!owner.alive||owner.kannaBattle?.closed)continue;for(const r of owner.kannaBattle?.nativeLinks?.values()||[]){const source=r.sourceObject,sourceIsCloud=source.world===sim&&source.owner===owner;
    if(r.owner!==owner||r.ownerLife!==owner.reviveCount||r.until<=sim.time+1e-8||sim.entities.get(r.actor)!==r.target||!r.target.alive||r.target.reviveCount!==r.targetLife||
      sourceIsCloud&&(source.ended||sim.entities.has(source.id)||owner.kannaBattle.cloud!==source||source.ownerLife!==r.sourceLife)||!sourceIsCloud&&(sim.entities.get(source.id)!==source||source.reviveCount!==r.sourceLife))continue;
    const key=`${r.actor}:${r.id}`,entry={id:r.id,level:1,actor:r.actor,life:r.targetLife,sourceActorId:r.sourceActorId,sourceLife:r.sourceLife,until:r.until,overlap:1,source:owner};
    const old=out.get(key);if(!old||entry.until>old.until||entry.until===old.until&&entry.sourceActorId<old.sourceActorId)out.set(key,entry);}}
  return out;}
function diff(sim,source,next,previous,{force=false,skin}={}){const frames=[];const changed=(a,b)=>!a||a.level!==b.level||a.overlap!==b.overlap||a.life!==b.life||a.sourceActorId!==b.sourceActorId||a.sourceLife!==b.sourceLife;
  for(const [key,old]of previous){const current=next.get(key);if(changed(current,old))frames.push(statusPacket(old.source||source,old,sim.time,{remove:true,skin}));}
  for(const [key,current]of next){const old=previous.get(key);if(force||changed(old,current)||old.until!==current.until)frames.push(statusPacket(current.source||source,current,sim.time,{skin}));}return frames;}
function sync(sim,e,settings={}){const frames=[];if(e.kannaBattle){const next=ownSnapshot(sim,e),previous=e.kannaBattle.nativeStatuses;frames.push(...diff(sim,e,next,previous,settings));e.kannaBattle.nativeStatuses=next;}
  // Vision expiry belongs to the target aggregate. One source expiring must
  // not remove another living Kanna's still-active reveal of the same target.
  const vision=visionSnapshot(sim),oldVision=visionSynced.get(sim)||new Map();frames.push(...diff(sim,e,vision,oldVision,settings));visionSynced.set(sim,vision);
  if(settings.includeLinks!==false){const links=linkSnapshot(sim),oldLinks=linksSynced.get(sim)||new Map();frames.push(...diff(sim,e,links,oldLinks,settings));linksSynced.set(sim,links);}return frames;}
module.exports={statusPacket,ownSnapshot,visionSnapshot,linkSnapshot,sync};
