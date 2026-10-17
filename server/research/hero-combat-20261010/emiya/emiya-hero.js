'use strict';
const UI=require('./emiya-ui-rules');
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x)),distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const slots=['Q','W','E','R'],families={Q:[6521,6522,6523],W:[6527,3964,3965],E:[3966],R:[6529]};
const point=p=>p&&[p.x,p.z].every(x=>Number.isFinite(x)&&x>=0&&x<=655.35);
const bonusAD=e=>Math.max(0,Number(e.attributes?.[127]??e.flatBonusAttackDamage??0));
const totalAD=e=>Math.max(0,Number(e.attackDamage)||0);
function direction(e,aim){
  if(point(aim)&&distance(e,aim)>.01){const d=distance(e,aim);return {x:(aim.x-e.x)/d,z:(aim.z-e.z)/d};}
  const d=Math.hypot(aim?.dirX,aim?.dirZ);return Number.isFinite(d)&&d>1e-9?{x:aim.dirX/d,z:aim.dirZ/d}:null;
}
function segmentDistance(p,a,b){const dx=b.x-a.x,dz=b.z-a.z,l=dx*dx+dz*dz;
  const t=l?clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/l,0,1):0;
  return Math.hypot(p.x-a.x-dx*t,p.z-a.z-dz*t);}
function createDefinition(options={}){
 const policy={...UI.policies,...options.policies};
 const live=(sim,e)=>!sim.heroes?.closed&&sim.winner===null&&sim.entities.get(e?.id)===e&&e?.alive&&e.emiyaBase?.sim===sim;
 const validAction=(sim,e,action)=>live(sim,e)&&action?.life===e.reviveCount&&action.epoch===e.emiyaBase.epoch;
 const notify=(sim,e,effect,more={})=>sim.event('emiya-state',{id:e.id,effect,...more});
 const row=(e,slot)=>UI[slot][e.emiyaBase.levels[slot]-1];
 const skill=(e,slot,id)=>{const r=row(e,slot);return {id:id??families[slot][0],slot,level:r.rank,type:'hero-specific',
   mana:slot==='Q'&&e.emiyaBase.q.stage>0?0:r.mana,cooldown:r.cooldown,
   range:slot==='Q'?r.ranges[e.emiyaBase.q.stage]:slot==='W'?r.maxRange:slot==='E'?r.range:r.globalRange,
   ...(slot==='W'?{aliases:families.W.filter(value=>value!==(id??families.W[0]))}:{})};};
 const expire=(sim,e)=>{const s=e.emiyaBase;if(!s)return;
  if(s.q.stage&&sim.time+1e-9>=s.q.until){s.q.stage=0;e.skills.Q=skill(e,'Q');
   sim.event('skill-cooldown',{id:e.id,skill:e.skills.Q,readyAt:e.cooldowns.Q||sim.time});notify(sim,e,'q-expired');}
  if(s.e&&sim.time+1e-9>=s.e.until){s.e=null;notify(sim,e,'shield-expired');}
  if(s.stacksUntil<=sim.time)s.stacks=0;
 };
 const cooldown=(sim,e,slot,seconds)=>{const reduced=seconds*(1-clamp(e.attributes?.[100]||0,0,100)/100);
  e.cooldowns[slot]=sim.time+reduced;sim.event('skill-cooldown',{id:e.id,skill:e.skills[slot],readyAt:e.cooldowns[slot]});return reduced;};
 const resources=(sim,e,mana)=>{e.mp-=mana;sim.event('hero-resource',{id:e.id,hp:e.hp,mp:e.mp});};
 const castEvent=(sim,e,sk,aim,more={})=>sim.event('cast',{id:e.id,slot:sk.slot,skill:{...sk},aim:{...aim},readyAt:e.cooldowns[sk.slot],...more});
 const movement=(sim,e,p)=>{if(!point(p))return false;e.x=p.x;e.z=p.z;e.lastMovedAt=sim.time;
  sim.event('position',{id:e.id,x:e.x,z:e.z,teleport:true,emiyaDash:true});return true;};
 const cleanEffects=(sim,e)=>{for(const target of sim.entities.values())if(target.emiyaDebuffs?.delete(e))sim.updateBuffs(target);};
 const clear=(sim,e,reason)=>{const s=e.emiyaBase;if(!s)return;s.epoch++;s.jobs=[];s.dash=null;s.w=null;s.r=null;s.e=null;s.inQ=false;
  s.issuedJobs=new WeakSet();
  s.q={stage:0,until:0,recastAt:0};s.stacks=0;s.stacksUntil=0;s.attackCount=0;s.contributions.clear();
  cleanEffects(sim,e);if(!sim.heroes?.closed&&sim.entities.get(e.id)===e){e.skills.Q=skill(e,'Q');e.skills.W=skill(e,'W');notify(sim,e,'clear',{reason});}};
 const launchBlade=(sim,e,dir)=>{if(!live(sim,e)||!dir)return;
  const s=e.emiyaBase,rank=1+UI.passive.levelThresholds.filter(x=>(e.level||1)>=x).length;
  const job={kind:'blade',epoch:s.epoch,leg:'out',p:{x:e.x,z:e.z},origin:{x:e.x,z:e.z},dir:{...dir},traveled:0,
    hits:new Set(),bonus:bonusAD(e),rank,life:e.reviveCount,nativeSpeed:policy.bladeSpeed,
    end:{x:clamp(e.x+dir.x*policy.bladeRange,0,655.35),z:clamp(e.z+dir.z*policy.bladeRange,0,655.35)}};
  s.jobs.push(job);s.issuedJobs.add(job);
  sim.event('emiya-projectile',{id:e.id,kind:'blade',bulletId:3961,skillId:3968,rank,origin:job.origin,direction:job.dir,modelJob:job});
 };
 const launchVisual=(sim,e,kind,center,bulletId,skillId,lifetime)=>{if(!live(sim,e))return;
  const s=e.emiyaBase,job={kind,epoch:s.epoch,life:e.reviveCount,origin:{...center},p:{...center},end:{...center},
   nativeSpeed:0,bulletId,stateId:bulletId,until:sim.time+lifetime};s.jobs.push(job);s.issuedJobs.add(job);
  sim.event('emiya-projectile',{id:e.id,kind,bulletId,skillId,origin:{...center},modelJob:job});
 };
 const hitBladeSegment=(sim,e,job,a,b)=>{for(const target of [...sim.entities.values()]){
  if(!validAction(sim,e,job))break;
  if(!sim.enemies(e,target)||job.hits.has(target)||segmentDistance(target,a,b)>policy.bladeWidth+(target.bodyRadius||0))continue;
  job.hits.add(target);const outgoing=job.leg==='out',base=(outgoing?UI.passive.outgoingBase:UI.passive.returnBase)[job.rank-1];
  sim.damage(e,target,base+job.bonus*(outgoing?UI.passive.outgoingBonusAd:UI.passive.returnBonusAd),3968,'physical',undefined,a,
    {allowCritical:false,skillLevel:job.rank});if(!validAction(sim,e,job))break;
 }};
 const tickBlade=(sim,e,job,step)=>{const old={...job.p};let next;
  if(job.leg==='out'){const travel=Math.min(policy.bladeSpeed*step,policy.bladeRange-job.traveled);
   next={x:clamp(old.x+job.dir.x*travel,0,655.35),z:clamp(old.z+job.dir.z*travel,0,655.35)};job.traveled+=travel;
  }else{job.returnEnd={x:e.x,z:e.z};const d=distance(old,job.returnEnd),travel=Math.min(policy.bladeSpeed*step,d);next=d?{x:old.x+(job.returnEnd.x-old.x)*travel/d,z:old.z+(job.returnEnd.z-old.z)*travel/d}:{...old};}
  hitBladeSegment(sim,e,job,old,next);if(!validAction(sim,e,job))return;job.p=next;
  if(job.leg==='out'&&job.traveled>=policy.bladeRange-1e-9){job.leg='return';job.hits=new Set();job.returnEnd={x:e.x,z:e.z};
   sim.event('emiya-projectile-turn',{id:e.id,bulletId:3960,position:next,modelJob:job});}
  else if(job.leg==='return'&&distance(next,e)<1e-6)job.done=true;
 };
 const vuln=(sim,e,target,percent)=>{target.emiyaDebuffs??=new Map();const previous=target.emiyaDebuffs.get(e)||{};
  target.emiyaDebuffs.set(e,{...previous,w:{percent,until:sim.time+2,maxUntil:sim.time+5,life:target.reviveCount}});
  notify(sim,target,'w-vulnerability',{sourceId:e.id,percent});};
 const explodeW=(sim,e,job,center)=>{if(!validAction(sim,e,job))return;job.p={...center};job.done=true;
  const targets=[...sim.entities.values()].map(target=>({target,life:target.reviveCount}));
  for(const {target,life}of targets)if(sim.entities.get(target.id)===target&&target.reviveCount===life&&sim.enemies(e,target)&&distance(center,target)<=policy.wExplosionRadius+(target.bodyRadius||0)){
   sim.damage(e,target,job.damage,3970,'physical',undefined,center,{allowCritical:false,skillLevel:job.rank});
   if(!validAction(sim,e,job))return;
   if(sim.entities.get(target.id)===target&&target.reviveCount===life&&target.alive&&target.kind==='hero'&&job.vulnerability>0)vuln(sim,e,target,job.vulnerability);
   if(job.kannaRatio)sim.event('emiya-kanna-extra-damage-unresolved',{id:e.id,targetId:target.id,ratio:job.kannaRatio,basis:null});
  }
  sim.event('emiya-projectile-end',{id:e.id,kind:'w',position:center,modelJob:job});
  launchVisual(sim,e,'w-impact',center,3969,3970,policy.wImpactVisualLife);
 };
 const tickWProjectile=(sim,e,job,step)=>{const old={...job.p},left=distance(old,job.end),travel=Math.min(policy.wProjectileSpeed*step,left);
  const next=left?{x:old.x+(job.end.x-old.x)*travel/left,z:old.z+(job.end.z-old.z)*travel/left}:{...old};
  for(const ally of sim.entities.values())if(ally.alive&&ally.team===e.team&&ally.heroId===234&&segmentDistance(ally,old,next)<=policy.wProjectileWidth+(ally.bodyRadius||0)){
   const empowered=options.kannaEmpowered?.(sim,ally)===true;job.kannaRatio=Math.max(job.kannaRatio||0,empowered?.04:.02);
  }
  const hits=[...sim.entities.values()].filter(t=>t.kind==='hero'&&sim.enemies(e,t)&&segmentDistance(t,old,next)<=policy.wProjectileWidth+(t.bodyRadius||0));
  hits.sort((a,b)=>distance(old,a)-distance(old,b)||a.id-b.id);
  if(hits[0])return explodeW(sim,e,job,{x:hits[0].x,z:hits[0].z});
  if(sim.terrain&&!sim.terrain.segment(old,next,0))return explodeW(sim,e,job,old);
  job.p=next;if(left<=travel+1e-9)explodeW(sim,e,job,next);
 };
 const releaseW=(sim,e,aim,{cancel=false}={})=>{const s=e.emiyaBase,w=s.w;if(!w)return {ok:false,reason:'not-charging'};
  const dir=direction(e,aim)||w.dir;if(!dir&&!cancel)return {ok:false,reason:'direction'};
  const r=row(e,'W'),charged=clamp(sim.time-w.at,0,r.maxCharge),range=r.startRange+(r.maxRange-r.startRange)*Math.min(1,charged/r.rampSeconds);
  const targetDistance=point(aim)?Math.min(range,distance(e,aim)):range;
  const end={x:clamp(e.x+(dir?.x||0)*targetDistance,0,655.35),z:clamp(e.z+(dir?.z||0)*targetDistance,0,655.35)};
  s.w=null;e.skills.W=skill(e,'W');const cd=cooldown(sim,e,'W',r.cooldown+r.maxExtraCooldown*charged/r.maxCharge);
  if(cancel){sim.event('cast-cancel',{id:e.id,slot:'W',skill:e.skills.W,aim,reason:'charge-cancel'});return {ok:true,cancelled:true};}
  const sk={...e.skills.W,id:3965,mana:0,cooldown:cd,range};castEvent(sim,e,sk,aim);
  const job={kind:'w',epoch:s.epoch,life:e.reviveCount,rank:r.rank,p:{x:e.x,z:e.z},end,
    damage:r.baseDamage+r.bonusAdRatio*bonusAD(e),vulnerability:Math.min(r.vulnerabilityCap,Math.floor(charged/.1+1e-9)),kannaRatio:0,
    origin:{x:e.x,z:e.z},nativeSpeed:policy.wProjectileSpeed};
  s.jobs.push(job);s.issuedJobs.add(job);sim.event('emiya-projectile',{id:e.id,kind:'w',bulletId:3968,skillId:3970,origin:{...job.p},end,modelJob:job});
  return {ok:true,charged,range};
 };
 const qContact=(sim,e,dash)=>{const target=dash.target,s=e.emiyaBase;
  if(!validAction(sim,e,dash)||!sim.enemies(e,target)||sim.entities.get(target.id)!==target||target.reviveCount!==dash.targetLife)return;
  dash.contacted=true;s.inQ=true;try{sim.damage(e,target,totalAD(e)*row(e,'Q').coefficient,dash.skillId,'physical',undefined,{x:e.x,z:e.z},
    {basic:true,skillLevel:s.levels.Q,...(dash.stage===2?{forceCritical:true}:{allowCritical:false})});}finally{if(validAction(sim,e,dash))s.inQ=false;}
  if(!validAction(sim,e,dash))return;
  if(dash.stage===2&&target.alive&&sim.entities.get(target.id)===target&&target.reviveCount===dash.targetLife){const end={x:clamp(target.x+dash.dir.x*policy.qKnockback,0,655.35),z:clamp(target.z+dash.dir.z*policy.qKnockback,0,655.35)};
   if(!sim.terrain||sim.terrain.segment(target,end,target.bodyRadius||0)){sim.stopMotion(target);movement(sim,target,end);}}
  launchBlade(sim,e,dash.dir);
 };
 const tickDash=(sim,e,step)=>{const s=e.emiyaBase,d=s.dash;if(!d)return;
  if(d.epoch!==s.epoch||d.life!==e.reviveCount){s.dash=null;return;}
  if(sim.time<d.startsAt)return;
  const old={x:e.x,z:e.z},left=distance(old,d.end),travel=Math.min(d.speed*step,left),next=left?{x:old.x+(d.end.x-old.x)*travel/left,z:old.z+(d.end.z-old.z)*travel/left}:{...old};
  if(sim.terrain&&!sim.terrain.segment(old,next,e.bodyRadius||0)){s.dash=null;return;}
  movement(sim,e,next);
  if(d.kind==='q'&&!d.contacted&&sim.entities.get(d.target.id)===d.target&&d.target.reviveCount===d.targetLife&&
    segmentDistance(d.target,old,next)<=(d.target.bodyRadius||.2)+(e.bodyRadius||.2)+.05)qContact(sim,e,d);
  if(!validAction(sim,e,d))return;if(left<=travel+1e-9&&s.dash===d)s.dash=null;
 };
 const rHit=(sim,e,target,r,field)=>{if(!validAction(sim,e,field)||!sim.enemies(e,target))return;
  const center={x:target.x,z:target.z};for(const {enemy,life}of [...sim.entities.values()].map(enemy=>({enemy,life:enemy.reviveCount})))if(sim.entities.get(enemy.id)===enemy&&enemy.reviveCount===life&&sim.enemies(e,enemy)&&distance(center,enemy)<=policy.rBlastRadius+(enemy.bodyRadius||0)){
    sim.damage(e,enemy,r.baseDamage+r.totalAdRatio*totalAD(e),6531,'physical',undefined,center,{criticalMultiplier:r.criticalMultiplier,skillLevel:r.rank});
    if(!validAction(sim,e,field))return;
  }
  sim.event('emiya-r-projection',{id:e.id,targetId:target.id,skillId:6531,position:center});
  launchVisual(sim,e,'r-projection',center,6530,6531,policy.rProjectionVisualLife);
 };
 const tickR=(sim,e)=>{const s=e.emiyaBase,field=s.r;if(!field)return;const r=row(e,'R');
  const currentField=()=>s.r===field&&validAction(sim,e,field);
  const enemies=()=>[...sim.entities.values()].filter(t=>t.kind==='hero'&&sim.enemies(e,t)&&distance(e,t)<=r.globalRange);
  for(const t of enemies()){t.emiyaDebuffs??=new Map();const old=t.emiyaDebuffs.get(e)||{};
   t.emiyaDebuffs.set(e,{...old,r:{slow:r.slow,until:field.until,life:t.reviveCount,rank:r.rank}});sim.updateBuffs(t);}
  while(currentField()&&field.farIndex<policy.rFarPulseAt.length&&sim.time+1e-9>=field.at+policy.rFarPulseAt[field.farIndex]){
   field.farIndex++;for(const {t,life}of enemies().map(t=>({t,life:t.reviveCount}))){if(!currentField())return;if(sim.entities.get(t.id)!==t||t.reviveCount!==life)continue;const count=field.farHits.get(t)||0;if(count<r.globalPerHero){field.farHits.set(t,count+1);rHit(sim,e,t,r,field);}}
  }
  while(currentField()&&field.nearCount<r.nearMaximum&&sim.time+1e-9>=field.nearAt&&field.nearAt<=field.until+1e-9){
   field.nearAt+=policy.rNearInterval;const candidates=enemies().filter(t=>distance(e,t)<=policy.rNearRadius);
   candidates.sort((a,b)=>(field.nearHits.get(a)||0)-(field.nearHits.get(b)||0)||distance(e,a)-distance(e,b)||a.id-b.id);
   if(candidates[0]){const t=candidates[0];field.nearCount++;field.nearHits.set(t,(field.nearHits.get(t)||0)+1);rHit(sim,e,t,r,field);}
  }
  if(currentField()&&sim.time+1e-9>=field.until){s.r=null;notify(sim,e,'r-expired');}
 };
 const validate=(sim,e,value,aim={})=>{if(!live(sim,e))return {ok:false,reason:'stale-or-dead'};expire(sim,e);
  const supplied=typeof value==='object'?value.id:Number(value),id=aim.requestedSkillId??supplied,
   slot=slots.find(k=>families[k].includes(id));
  if(slot&&!families[slot].includes(supplied))return {ok:false,reason:'slot-skill-mismatch'};
  if(!slot)return {ok:false,reason:'base-skill-only'};const s=e.emiyaBase;
  if(e.controlUntil>sim.time)return {ok:false,reason:'controlled'};
  if(s.dash)return {ok:false,reason:'dashing'};
  if(s.w&&slot!=='W')return {ok:false,reason:'charging'};
  if((aim.x!==undefined||aim.z!==undefined)&&!point(aim))return {ok:false,reason:'invalid-aim'};
  const sk=skill(e,slot,slot==='Q'?families.Q[s.q.stage]:id),r=row(e,slot),release=slot==='W'&&!!s.w;
  if(slot==='Q'&&id!==sk.id)return {ok:false,reason:'q-stage'};
  if(slot==='W'&&id===3965&&!release)return {ok:false,reason:'not-charging'};
  if(!release&&(slot!=='Q'||s.q.stage===0)&&(e.cooldowns[slot]||0)>sim.time+1e-9)return {ok:false,reason:'cooldown'};
  if(slot==='Q'&&s.q.stage>0&&sim.time<s.q.recastAt)return {ok:false,reason:'recast-delay'};
  const mana=release?0:sk.mana;if(e.mp<mana)return {ok:false,reason:'mana'};
  let target,dir;
  if(slot==='Q'){target=sim.entities.get(aim.targetId);if(!target||!sim.enemies(e,target)||distance(e,target)>sk.range+(target.bodyRadius||0))return {ok:false,reason:'range-or-target'};
   dir=direction(e,target);if(!dir)return {ok:false,reason:'direction'};}
  if(slot==='E'||slot==='W'){dir=direction(e,aim)||(release?s.w.dir:null);if(!dir)return {ok:false,reason:'direction'};}
  return {ok:true,id,slot,skill:sk,r,mana,target,dir,release};
 };
 return {heroId:156,name:'emiya-current-ui-base',complete:false,playable:false,managesBasicAttack:true,
  install(sim,e,{levels={Q:1,W:1,E:1,R:1}}={}){
   if(e.heroId!==156||slots.some(slot=>!Number.isInteger(levels[slot])||levels[slot]<1||levels[slot]>UI[slot].length))return false;
   if(e.emiyaBase?.sim===sim)return true;
   e.emiyaBase={sim,levels:{...levels},epoch:0,jobs:[],issuedJobs:new WeakSet(),dash:null,w:null,r:null,e:null,q:{stage:0,until:0,recastAt:0},
    attackCount:0,stacks:0,stacksUntil:0,contributions:new Map(),awardedDeaths:new WeakMap()};
   for(const slot of slots)e.skills[slot]=skill(e,slot);
   e.attackSkillId=3961;e.attackAliases=[];e.baseRange=1.3;
   e.attackProfiles={3961:{range:1.3,attackWindup:.2,projectileSpeed:0}};sim.updateBuffs(e);return true;
  },isInstalled:e=>!!e.emiyaBase,affects:e=>!!e.emiyaDebuffs?.size,
  ownsSkill:(_sim,_e,sk)=>slots.some(slot=>families[slot].includes(sk?.id)),
  resolveSkill(sim,e,value){const id=typeof value==='object'?value.id:Number(value);expire(sim,e);
   const slot=slots.find(k=>families[k].includes(id));return slot?skill(e,slot,id):null;},
  validateCast:validate,
  applyCast(sim,e,value,aim={}){const p=validate(sim,e,value,aim);if(!p.ok)return p;const s=e.emiyaBase;
   if(p.release)return releaseW(sim,e,aim);sim.cancelWindup(e);sim.stopMotion(e);e.targetId=null;e.path=[];
   resources(sim,e,p.mana);
   if(p.slot==='Q'){const stage=s.q.stage;if(stage===0)cooldown(sim,e,'Q',p.r.cooldown);
    const offset=(p.target.bodyRadius||.2)+(e.bodyRadius||.2)+policy.qLandingOffset;
    s.dash={kind:'q',epoch:s.epoch,life:e.reviveCount,stage,skillId:p.skill.id,target:p.target,targetLife:p.target.reviveCount,
      dir:p.dir,end:{x:clamp(p.target.x+p.dir.x*offset,0,655.35),z:clamp(p.target.z+p.dir.z*offset,0,655.35)},
      speed:policy.qDashSpeeds[stage],startsAt:sim.time+policy.qWindup,contacted:false};
    s.q={stage:stage===2?0:stage+1,until:stage===2?0:sim.time+2,recastAt:sim.time+policy.qRecastDelay};
    e.skills.Q=skill(e,'Q',families.Q[s.q.stage]);castEvent(sim,e,p.skill,aim,{targetIds:[p.target.id],readyAt:stage===2?e.cooldowns.Q:sim.time+policy.qRecastDelay});
   }else if(p.slot==='W'){s.w={at:sim.time,aim:{...aim},dir:p.dir};e.skills.W=skill(e,'W',3965);
    castEvent(sim,e,p.skill,aim,{readyAt:sim.time});notify(sim,e,'charge-start');
   }else if(p.slot==='E'){cooldown(sim,e,'E',p.r.cooldown);s.e={layers:7,until:sim.time+3,threshold:p.r.thresholdBase+p.r.bonusAdRatio*bonusAD(e)};
    const length=point(aim)?Math.min(p.r.range,distance(e,aim)):p.r.range;
    s.dash={kind:'e',epoch:s.epoch,life:e.reviveCount,end:{x:clamp(e.x+p.dir.x*length,0,655.35),z:clamp(e.z+p.dir.z*length,0,655.35)},
      speed:policy.eDashSpeed,startsAt:sim.time+.033};castEvent(sim,e,p.skill,aim);notify(sim,e,'shield-start',{layers:7});
   }else{cooldown(sim,e,'R',p.r.cooldown);s.r={life:e.reviveCount,epoch:s.epoch,at:sim.time,until:sim.time+5,farIndex:0,nearCount:0,nearAt:sim.time+policy.rNearFirstAt,
      farHits:new Map(),nearHits:new Map()};castEvent(sim,e,p.skill,aim);tickR(sim,e);}
   return {ok:true,slot:p.slot};
  },
  tick(sim,e,step){if(e.emiyaDebuffs)for(const [owner,d]of e.emiyaDebuffs){if(sim.entities.get(owner.id)!==owner||!owner.alive){e.emiyaDebuffs.delete(owner);continue;}
    if(d.w&&(d.w.until<=sim.time||d.w.life!==e.reviveCount))delete d.w;
    if(d.r&&(d.r.until<=sim.time||d.r.life!==e.reviveCount))delete d.r;
    if(!d.w&&!d.r)e.emiyaDebuffs.delete(owner);}
   if(!live(sim,e))return;expire(sim,e);const s=e.emiyaBase;tickDash(sim,e,step);
   if(s.w&&sim.time+1e-9>=s.w.at+row(e,'W').maxCharge)releaseW(sim,e,s.w.aim);
   for(const job of [...s.jobs])if(!job.done&&job.epoch===s.epoch&&job.life===e.reviveCount){
    if(job.kind==='blade')tickBlade(sim,e,job,step);else if(job.kind==='w')tickWProjectile(sim,e,job,step);
    else if(sim.time+1e-9>=job.until)job.done=true;}
   s.jobs=s.jobs.filter(j=>!j.done&&j.epoch===s.epoch&&j.life===e.reviveCount);tickR(sim,e);
  },
  modifiers(sim,e){const s=e.emiyaBase,slow=Math.max(0,...[...(e.emiyaDebuffs?.entries()||[])].filter(([owner])=>sim.entities.get(owner.id)===owner&&owner.alive).map(([_owner,d])=>d.r?.until>sim.time&&d.r.life===e.reviveCount?d.r.slow:0));
   return {attackPercent:s&&s.stacksUntil>sim.time?s.stacks*8:0,speedPercent:-slow};},
  canAct(sim,e,action){expire(sim,e);const s=e.emiyaBase;if(!s)return true;
   return !s.dash&&!s.w&&(action!=='attack'||s.q.stage===0);},
  onMoveOrder(sim,e){if(e.emiyaBase?.w)releaseW(sim,e,e.emiyaBase.w.aim,{cancel:true});},
  onControl(sim,e){const s=e.emiyaBase;if(s?.w)releaseW(sim,e,s.w.aim,{cancel:true});if(s?.dash){s.dash=null;s.q.stage=0;e.skills.Q=skill(e,'Q');}},
  basicAttackSkill:()=>3961,
  onBasicHit(sim,e,target,event){const s=e.emiyaBase;if(!live(sim,e)||s.inQ||!(event.amount>0))return;
   s.attackCount++;if(s.attackCount%3===0)launchBlade(sim,e,direction(e,target));},
  onDamage(sim,e,target,event){if(!live(sim,e)||!(event.amount>0))return;const s=e.emiyaBase;
   if(target.kind==='hero')s.contributions.set(target,sim.time);
   const w=target.emiyaDebuffs?.get(e)?.w;if(w&&w.until>sim.time&&w.life===target.reviveCount)w.until=Math.min(w.maxUntil,sim.time+2);},
  modifyIncomingDamage(sim,target,attacker,event){let received=event.received;const boosts=[...(target.emiyaDebuffs?.entries()||[])].filter(([owner,d])=>sim.entities.get(owner.id)===owner&&owner.alive&&d.w?.until>sim.time&&d.w.life===target.reviveCount);
   if(attacker.kind==='hero'&&target.kind==='hero')received=Math.floor(received*(1+Math.max(0,...boosts.map(([_owner,d])=>d.w.percent))/100)+1e-9);
   return {received};},
  beforeDamage(sim,target,_attacker,event){const received=event.received;
   const shield=target.emiyaBase?.sim===sim?target.emiyaBase.e:null;if(!shield||shield.until<=sim.time||shield.layers<=0)return {received,absorbed:0,blocked:false};
   const lost=received>shield.threshold?Math.min(shield.layers,Math.max(0,Math.ceil(received/shield.threshold)-1)):0;
   shield.layers=Math.max(0,shield.layers-lost);notify(sim,target,'shield-hit',{lostLayers:lost,layers:shield.layers});
   return {received:0,absorbed:received,blocked:true};
  },
  onLeave:(sim,e)=>clear(sim,e,'leave'),onRespawn:(sim,e)=>clear(sim,e,'respawn'),
  world:{onDeath(sim,killer,victim,context){for(const e of sim.entities.values())if(live(sim,e)&&e!==victim&&victim.kind==='hero'&&killer&&e.team===killer.team&&e.team!==victim.team){
    if(context?.recipientCurrent?.(e)===false||e===killer&&context?.sourceCurrent===false)continue;
    const s=e.emiyaBase,prior=s.awardedDeaths.get(victim);if(prior===victim.reviveCount)continue;
    const kill=e===killer,assist=(s.contributions.get(victim)??-Infinity)>=sim.time-policy.assistWindow;
    if(!kill&&!assist)continue;s.awardedDeaths.set(victim,victim.reviveCount);s.stacks=Math.min(7,(s.stacksUntil>sim.time?s.stacks:0)+1);s.stacksUntil=sim.time+8;
    e.cooldowns.Q=Math.max(sim.time,(e.cooldowns.Q||0)-(kill?6:3));if(s.q.stage===0)sim.event('skill-cooldown',{id:e.id,skill:e.skills.Q,readyAt:e.cooldowns.Q});
    sim.updateBuffs(e);notify(sim,e,'kill-stack',{stacks:s.stacks,assist:!kill});}
   if(context?.targetCurrent!==false){if(victim.emiyaBase?.sim===sim)clear(sim,victim,'death');victim.emiyaDebuffs?.clear();}}},
  native:{sync:(sim,e,opts)=>require('./emiya-native').sync(sim,e,opts),
   beforeCast:(sim,e)=>require('./emiya-native').sync(sim,e),
   isProjectileEvent:(_e,event)=>event.type==='emiya-projectile',
   projectile:(e,event,id)=>require('./emiya-projectiles-native').launch(e,event,id),
   tickProjectile:(state,time)=>require('./emiya-projectiles-native').tick(state,time),
   finishProjectile:state=>require('./emiya-projectiles-native').finish(state)},
  policies:policy,uiRules:UI,
 };
}
module.exports={createDefinition,UI,direction,segmentDistance};
