'use strict';
// Current Data9 status IDs, schema-correct candidate frames; client acceptance
// and original-server duration/overlap conventions remain pending.
const P=require('../../../battle-protobuf'),W=require('../../../battle-wire'),data=require('./parameters.json');
const known=new Set(data.hero.statuses.map(r=>`${r.named.nStatusID}:${r.named.nLevel}`)),caches=new WeakMap();
const v=(number,value)=>({number,wire:0,value:BigInt(value)}),EPS=1e-8;
function packet(entry,now,remove=false){if(!known.has(`${entry.id}:${entry.level}`))throw Error('Unknown Ikaros status rank');
  const body=P.encode([v(2,entry.source.id),v(3,138),v(5,entry.id),v(6,entry.level),...(remove?[v(7,3)]:[]),
    ...(!remove&&Number.isFinite(entry.until)?[v(9,Math.max(1,Math.round((entry.until-now)*1000)))]:[]),v(10,entry.overlap),v(11,entry.source.skinId??entry.source.skin??0)]);
  return W.frame(11007,entry.actor.id,Buffer.concat([Buffer.from([body.length]),body]));}
function snapshot(sim){const next=new Map(),add=(source,actor,id,level,until,overlap=1)=>{if(until<=sim.time+EPS)return;const key=`${actor.id}:${id}`,
    r={source,actor,sourceLife:source.reviveCount,life:actor.reviveCount,id,level,until,overlap};const prev=next.get(key);
    // A single visible status is aggregate; numeric marks stay per caster.
    const strength=id===13589?level:overlap,previousStrength=prev?(id===13589?prev.level:prev.overlap):-1;
    if(!prev||strength>previousStrength||strength===previousStrength&&until>prev.until)next.set(key,r);};
  for(const e of sim.entities.values()){const s=e.ikarosBattle;if(!s||s.world!==sim||s.closed||!e.alive||s.life!==e.reviveCount)continue;
    if(s.levels.Q)add(e,e,13596,1,Infinity);if(s.levels.W)add(e,e,13597,1,Infinity);
    if(s.wingsUntil>sim.time+EPS){add(e,e,13566,1,s.wingsUntil);add(e,e,13593,1,s.wingsUntil);}
    if(s.count)add(e,e,13586,1,Infinity,s.count);
    if(s.shield){if(s.shield.triggered)add(e,e,13588,s.shield.level,s.shield.until);else add(e,e,13587,1,Math.max(s.lastCombatAt,e.lastCombatAt??-Infinity,s.shield.grantedAt)+6);}
    if(s.shieldCastUntil>sim.time+EPS)add(e,e,13595,1,s.shieldCastUntil);
    if(s.empowerUntil>sim.time+EPS){add(e,e,13590,s.levels.E,s.empowerUntil);add(e,e,13591,1,s.empowerUntil);}
    if(s.glide)add(e,e,13594,1,Infinity);
    for(const r of s.effects.values()){const t=r.target;if(sim.entities.get(t.id)!==t||!t.alive||t.reviveCount!==r.targetLife)continue;
      if(r.marks)add(e,t,13585,1,r.markUntil,r.marks);if(r.vulnerability)add(e,t,13589,r.rank,r.vulnerabilityUntil);}}
  return next;}
function sync(sim,_e,{force=false}={}){const next=snapshot(sim),old=caches.get(sim)||new Map(),out=[],changed=(a,b)=>!a||a.level!==b.level||a.overlap!==b.overlap||a.source!==b.source||a.actor!==b.actor||a.life!==b.life||a.sourceLife!==b.sourceLife;
  for(const [k,r]of old)if(changed(next.get(k),r))out.push(packet(r,sim.time,true));
  for(const [k,r]of next){const prev=old.get(k);if(force||changed(prev,r)||prev.until!==r.until)out.push(packet(r,sim.time));}caches.set(sim,next);return out;}
module.exports={packet,snapshot,sync};
