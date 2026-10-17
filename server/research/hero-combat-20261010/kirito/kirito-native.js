'use strict';
// Current102 states in the common verified11007 envelope. No invented HUD key,
// server HP spoof or guessed client effect mask.12901/12902 use proven enemy
// presentation consumers only in explicit viewer context; effect7 stays off.
const W=require('../../../battle-wire'),P=require('../../../battle-protobuf');
const source=require('../second-batch/snapshot.json').heroes.find(row=>row.heroId===102);
const known=new Set(source.statuses.map(row=>`${row.named.nStatusID}:${row.named.nLevel}`)),previous=new WeakMap(),noViewer=Symbol('no-viewer');
const value=(number,v)=>({number,wire:0,value:BigInt(v)});
function packet(entity,status,now,remove=false){
 if(!known.has(`${status.id}:${status.level}`))throw Error('Unknown current Kirito state');const owner=status.owner||entity;
 const fields=[value(2,owner.id),...(remove?[]:[value(3,102)]),value(5,status.id),value(6,status.level),
  ...(remove?[value(7,3)]:[]),...(Number.isFinite(status.until)?[value(9,Math.max(1,Math.round((status.until-now)*1000)))]:[]),value(10,1),value(11,owner.skinId||0)];
 const bytes=P.encode(fields);return W.frame(11007,entity.id,Buffer.concat([Buffer.from([bytes.length]),bytes]));
}
function states(sim,e,{viewerId}={}){const out=new Map(),s=e.kiritoBase,viewer=sim.entities.get(viewerId);
 const add=(id,level,until,owner=e)=>{if(until>sim.time)out.set(`${owner.id}:${id}`,{id,level,until,owner});};
 if(e.alive&&s?.sim===sim&&s.life===e.reviveCount){if(s.recastUntil>sim.time)add(12865,1,s.recastUntil);if(s.r)add(12868,1,Infinity);if(s.reductionUntil>sim.time)add(13013,s.levels.R,s.reductionUntil);
  if(e.hp>0&&viewer?.kind==='hero'&&viewer!==e)add(e.hp/e.hpMax>.5?12901:12902,1,Infinity);}
 if(e.alive)for(const [owner,effects]of e.kiritoEffects||[])if(sim.entities.get(owner.id)===owner&&owner.alive&&owner.kiritoBase?.sim===sim&&owner.kiritoBase.life===owner.reviveCount){
  if(effects.mark?.life===e.reviveCount)add(12864,1,effects.mark.until,owner);
  if(effects.slow?.life===e.reviveCount)add(12891,1,effects.slow.until,owner);
  if(effects.stun?.life===e.reviveCount)add(12862,effects.stun.rank,effects.stun.until,owner);
 }
 return out;
}
function sync(sim,e,{force=false,viewerId}={}){
 if(sim.heroes.closed||sim.entities.get(e?.id)!==e)return [];
 const viewer=sim.entities.get(viewerId),contextKey=viewer?.kind==='hero'?viewer:noViewer;
 let views=previous.get(sim);if(!views){views=new Map();previous.set(sim,views);}
 let actors=views.get(contextKey);if(!actors){actors=new Map();views.set(contextKey,actors);}
 const next=states(sim,e,{viewerId}),old=actors.get(e.id)?.states||new Map(),packets=[];
 for(const [key,status]of old){const now=next.get(key);if(!now||now.level!==status.level||now.owner!==status.owner)packets.push(packet(e,status,sim.time,true));}
 for(const [key,status]of next){const before=old.get(key);if(force||!before||before.until!==status.until||before.level!==status.level||before.owner!==status.owner)packets.push(packet(e,status,sim.time));}
 if(next.size)actors.set(e.id,{entity:e,viewerId:viewer?.id,states:next});else actors.delete(e.id);return packets;
}
module.exports={states,packet,sync};
