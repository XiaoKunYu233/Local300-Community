'use strict';
const {UI,POLICY}=require('./kirito-ui-rules');
const snapshot=require('../second-batch/snapshot.json').heroes.find(row=>row.heroId===102);
const rows=new Map(snapshot.skillLevels.map(row=>[`${row.named.nSkillID}:${row.named.nLevel}`,row.named]));
const slots=['Q','W','E','R'],families={Q:[2862],W:[2863],E:[2864,2866],R:[2868]},structures=new Set(['tower','base','barracks','fountain','building']);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value)),distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const point=p=>p&&[p.x,p.z].every(value=>Number.isFinite(value)&&value>=0&&value<=655.35);
const totalAD=e=>Math.max(0,Number(e.attackDamage)||0),bonusAD=e=>Math.max(0,Number(e.attributes?.[127]??e.flatBonusAttackDamage??0));
function direction(origin,aim){const dx=point(aim)?aim.x-origin.x:aim?.dirX,dz=point(aim)?aim.z-origin.z:aim?.dirZ,length=Math.hypot(dx,dz);return length>1e-8&&Number.isFinite(length)?{x:dx/length,z:dz/length}:null;}
function segmentParameter(p,a,b){const dx=b.x-a.x,dz=b.z-a.z,l=dx*dx+dz*dz;return l?clamp(((p.x-a.x)*dx+(p.z-a.z)*dz)/l,0,1):0;}
function segmentDistance(p,a,b){const t=segmentParameter(p,a,b);return distance(p,{x:a.x+(b.x-a.x)*t,z:a.z+(b.z-a.z)*t});}
function createDefinition(options={}){
 const policy={...POLICY,...options.policies},states=new WeakMap();
 const state=e=>states.get(e)||null;
 const current=(sim,e)=>!sim.heroes.closed&&sim.entities.get(e?.id)===e&&state(e)?.sim===sim;
 const live=(sim,e)=>current(sim,e)&&e.alive&&sim.winner===null;
 const workCurrent=(sim,e,work)=>live(sim,e)&&work?.life===e.reviveCount&&work?.epoch===state(e).epoch;
 const targetCurrent=(sim,target,life)=>sim.entities.get(target?.id)===target&&target?.alive&&target.reviveCount===life;
 const rule=(e,slot)=>UI[slot][state(e).levels[slot]-1];
 const skill=(e,slot,id)=>{const r=rule(e,slot),chosen=id??(slot==='E'&&state(e).recastUntil>state(e).sim.time?2866:families[slot][0]),config=rows.get(`${chosen}:${r.rank}`);
  return {id:chosen,slot,level:r.rank,type:'hero-specific',mana:0,cooldown:chosen===2866?r.recastCooldown:r.cooldownSeconds,range:config.fRange,
   damageType:slot==='R'?'true':'physical',action:config.strSkillAct,...(slot==='E'?{aliases:[2864,2866].filter(value=>value!==chosen)}:{})};};
 const notify=(sim,e,effect,data={})=>sim.event('kirito-state',{id:e.id,effect,...data});
 const castEvent=(sim,e,sk,aim)=>sim.event('cast',{id:e.id,slot:sk.slot,skillId:sk.id,skill:{...sk},aim:{...aim},castOrigin:{x:e.x,z:e.z},readyAt:sk.id===2866?state(e).recastAt:e.cooldowns[sk.slot],targetIds:aim.targetId?[aim.targetId]:[]});
 const cooldown=(sim,e,slot,seconds)=>{const cap=40+(e.equipmentCooldownCapBonus||0),cdr=clamp(e.attributes?.[100]||0,0,cap);e.cooldowns[slot]=sim.time+seconds*(1-cdr/100);sim.event('skill-cooldown',{id:e.id,skill:e.skills[slot],readyAt:e.cooldowns[slot]});};
 const move=(sim,e,to,reason)=>{if(!point(to))return false;sim.cancelWindup(e);sim.stopMotion(e);e.targetId=null;e.path=[];e.x=to.x;e.z=to.z;e.lastMovedAt=sim.time;sim.event('position',{id:e.id,x:e.x,z:e.z,teleport:true,kirito:reason});return true;};
 const displace=(sim,e,to,{ignore=[],reason='knockback'}={})=>{
  if(options.displace)return options.displace(sim,e,to,{ignore,reason});
  if(sim.displace)return sim.displace(e,to,{mode:reason==='q-dash'?'dash':'push',ignoreIds:ignore.map(other=>other.id)});
  const from={x:e.x,z:e.z},radius=e.bodyRadius||0,steps=Math.max(1,Math.ceil(distance(from,to)/.05));let last=from,blocked=false;
  for(let i=1;i<=steps;i++){const next={x:clamp(from.x+(to.x-from.x)*i/steps,0,655.35),z:clamp(from.z+(to.z-from.z)*i/steps,0,655.35)};
   if(sim.terrain&&!sim.terrain.segment(last,next,radius)||[...sim.entities.values()].some(other=>other!==e&&!ignore.includes(other)&&other.alive&&(other.bodyRadius||0)>0&&distance(next,other)<radius+other.bodyRadius-1e-6)){blocked=true;break;}last=next;}
  move(sim,e,last,reason);return {position:last,blocked};
 };
 const blink=(sim,e,anchor,reason)=>{if(sim.displace)return sim.displace(e,anchor,{mode:'blink'}).ok;const landing=sim.freeSpawn(anchor,e.bodyRadius||0,e.id);return move(sim,e,landing,reason);};
 const revealed=(sim,e,team)=>{if(options.visibleToTeam)return options.visibleToTeam(sim,e,team)===true;
  if(sim.vision?.visibleToTeam)return sim.vision.visibleToTeam(e,team)===true;
  return [...sim.entities.values()].some(other=>other!==e&&other.team===team&&other.alive&&distance(other,e)<=policy.visionRadius&&(!sim.terrain||sim.terrain.segment(other,e,0)));
 };
 const cleanEffects=(sim,e)=>{for(const target of sim.entities.values()){if(target.kiritoEffects?.delete(e))sim.updateBuffs(target);}}
 const releaseReveal=(sim,record)=>{if(record?.reveal)sim.vision?.release(record.reveal);};
 const removeShadow=(sim,e,shadow,reason)=>{if(shadow.done)return;shadow.done=true;if(shadow.interaction)sim.objects?.remove(shadow.interaction);notify(sim,e,'shadow-remove',{shadowId:shadow.id,reason});};
 const clear=(sim,e,reason)=>{const s=state(e);if(!s)return;s.epoch++;s.dash=null;s.pending=[];s.jobs.forEach(job=>{job.done=true;});s.jobs=[];
  for(const shadow of s.shadows.values())removeShadow(sim,e,shadow,reason);s.shadows.clear();s.marks.forEach(mark=>releaseReveal(sim,mark));s.marks.clear();
  s.recastUntil=0;s.recastAt=0;s.r=null;s.reductionUntil=0;s.speedDisabledUntil=0;s.wUntil=0;s.issued=new WeakSet();
  e.buffs=e.buffs.filter(buff=>!String(buff.slot).startsWith('kirito:'));cleanEffects(sim,e);
  if(current(sim,e)){e.skills.E=skill(e,'E',2864);notify(sim,e,'clear',{reason});}
 };
 const syncLife=(sim,e)=>{const s=state(e);if(current(sim,e)&&s.life!==e.reviveCount){clear(sim,e,'new-life');s.life=e.reviveCount;}};
 const expire=(sim,e)=>{const s=state(e);if(!s)return;
  for(const [target,mark]of s.marks)if(mark.until<=sim.time||sim.entities.get(target.id)!==target||!target.alive||target.reviveCount!==mark.life){releaseReveal(sim,mark);s.marks.delete(target);}
  for(const [id,shadow]of s.shadows)if(shadow.until<=sim.time||shadow.done){removeShadow(sim,e,shadow,'expired');s.shadows.delete(id);}
  if(s.recastUntil&&sim.time+1e-9>=s.recastUntil){s.recastUntil=0;e.skills.E=skill(e,'E',2864);sim.event('skill-cooldown',{id:e.id,skill:e.skills.E,readyAt:e.cooldowns.E});notify(sim,e,'e-window-end');}
 };
 const addEffect=(sim,e,target,key,effect)=>{target.kiritoEffects??=new Map();const all=target.kiritoEffects.get(e)||{};all[key]={...effect,life:target.reviveCount};target.kiritoEffects.set(e,all);sim.updateBuffs(target);};
 const mark=(sim,e,target,rank)=>{const s=state(e),until=sim.time+rule(e,'E').markSeconds,record={target,life:target.reviveCount,until,rank};
  if(options.reveal)record.reveal=options.reveal(sim,e,target,until);else if(sim.vision)record.reveal=sim.vision.reveal(e,target,rule(e,'E').markSeconds,{revealInvisible:false});releaseReveal(sim,s.marks.get(target));s.marks.set(target,record);
  addEffect(sim,e,target,'mark',{until,rank});notify(sim,e,'e-mark',{targetId:target.id,until});};
 const shadow=(sim,e,at,rank)=>{const s=state(e);let id=sim.nextId++;while(sim.entities.has(id)||s.shadows.has(id))id=sim.nextId++;
  const job={id,kind:'shadow',owner:e,sim,epoch:s.epoch,life:e.reviveCount,p:{...at},end:{...at},until:sim.time+rule(e,'E').emptyShadowSeconds,rank,bulletId:2865,nativeSpeed:0};
  if(sim.objects){job.interaction=sim.objects.create(e,{kind:'kirito-shadow',position:at,duration:rule(e,'E').emptyShadowSeconds,onInteract:(_world,owner,view)=>interact(sim,owner,view.id)});job.id=job.interaction.id;}
  s.jobs.push(job);s.issued.add(job);s.shadows.set(job.id,job);
  if(options.registerInteraction&&!job.interaction)job.interaction=options.registerInteraction(sim,e,job,()=>interact(sim,e,job.id));
  sim.event('kirito-projectile',{id:e.id,kind:'shadow',modelJob:job,bulletId:2865,skillId:2867,rank});notify(sim,e,'shadow-create',{shadowId:job.id,until:job.until,position:at});return job;};
 const launchSword=(sim,e,dir,rank)=>{const s=state(e),origin={x:e.x,z:e.z},job={kind:'sword',owner:e,sim,epoch:s.epoch,life:e.reviveCount,rank,p:{...origin},origin,dir,
  end:{x:clamp(origin.x+dir.x*policy.eRange,0,655.35),z:clamp(origin.z+dir.z*policy.eRange,0,655.35)},nativeSpeed:policy.eSpeed,
  startsAt:sim.time+policy.eCastDelay,damage:rule(e,'E').damageBase+bonusAD(e)*rule(e,'E').bonusAdRatio,bulletId:2864};
  s.jobs.push(job);s.issued.add(job);};
 const tickSword=(sim,e,job,step)=>{if(!workCurrent(sim,e,job)){syncLife(sim,e);return;}if(sim.time<job.startsAt)return;if(!job.emitted){job.emitted=true;sim.event('kirito-projectile',{id:e.id,kind:'sword',modelJob:job,bulletId:2864,skillId:2865,rank:job.rank});}
  const from={...job.p},remaining=distance(from,job.end),travel=Math.min(policy.eSpeed*step,remaining);let next={x:from.x+job.dir.x*travel,z:from.z+job.dir.z*travel},terrainBlocked=false;
  if(sim.terrain&&!sim.terrain.segment(from,next,0)){terrainBlocked=true;let low=0,high=1;for(let i=0;i<18;i++){const middle=(low+high)/2,p={x:from.x+(next.x-from.x)*middle,z:from.z+(next.z-from.z)*middle};if(sim.terrain.segment(from,p,0))low=middle;else high=middle;}next={x:from.x+(next.x-from.x)*low,z:from.z+(next.z-from.z)*low};}
  const candidates=[...sim.entities.values()].filter(target=>sim.enemies(e,target)&&segmentDistance(target,from,next)<=policy.eWidth+(target.bodyRadius||0)&&(!sim.terrain||sim.terrain.segment(from,target,0)));
  candidates.sort((a,b)=>segmentParameter(a,from,next)-segmentParameter(b,from,next)||a.id-b.id);
  const target=candidates[0];if(target){job.p={x:target.x,z:target.z};job.done=true;const life=target.reviveCount;sim.damage(e,target,job.damage,2865,'physical',undefined,job.origin,{allowCritical:false,skillLevel:job.rank});
   if(!workCurrent(sim,e,job)){syncLife(sim,e);return;}if(targetCurrent(sim,target,life))mark(sim,e,target,job.rank);return;}
  if(terrainBlocked){job.p=next;job.done=true;shadow(sim,e,next,job.rank);return;}
  job.p=next;if(remaining<=travel+1e-8){job.done=true;shadow(sim,e,next,job.rank);}
 };
 const push=(sim,e,target,dir,r,dash,life)=>{if(!workCurrent(sim,e,dash)||!targetCurrent(sim,target,life)||structures.has(target.kind))return;const to={x:clamp(target.x+dir.x*policy.qPushDistance,0,655.35),z:clamp(target.z+dir.z*policy.qPushDistance,0,655.35)};
  const result=displace(sim,target,to,{ignore:[e],reason:'q-push'});if(result.blocked&&workCurrent(sim,e,dash)&&targetCurrent(sim,target,life)){sim.damage(e,target,r.wallBonusBase+bonusAD(e)*r.wallBonusAdRatio,2879,'physical',undefined,{x:e.x,z:e.z},{allowCritical:false,skillLevel:r.rank});
   if(workCurrent(sim,e,dash)&&targetCurrent(sim,target,life)&&sim.control(target.id,r.wallStunSeconds,e)&&workCurrent(sim,e,dash)&&targetCurrent(sim,target,life))addEffect(sim,e,target,'stun',{until:target.controlUntil,rank:r.rank});}
 };
 const tickDash=(sim,e,step)=>{const s=state(e),dash=s.dash;if(!dash)return;if(!workCurrent(sim,e,dash)){syncLife(sim,e);return;}const from={x:e.x,z:e.z},remaining=distance(from,dash.end),travel=Math.min(policy.qSpeed*step,remaining),goal={x:from.x+dash.dir.x*travel,z:from.z+dash.dir.z*travel};
  const movableEnemies=[...sim.entities.values()].filter(target=>sim.enemies(e,target)&&!structures.has(target.kind));
  const trace=sim.traceDisplacement?.(e,goal,{mode:'dash',ignoreIds:movableEnemies.map(target=>target.id)}),next=trace?.position||goal;
  const candidates=[...sim.entities.values()].filter(target=>sim.enemies(e,target)&&!dash.hits.has(target)&&segmentDistance(target,from,next)<=policy.qWidth+(target.bodyRadius||0)&&(!sim.terrain||sim.terrain.segment(from,target,0)));
  candidates.sort((a,b)=>segmentParameter(a,from,next)-segmentParameter(b,from,next)||a.id-b.id);
  for(const {target,life}of candidates.map(target=>({target,life:target.reviveCount}))){if(!workCurrent(sim,e,dash)){syncLife(sim,e);return;}if(!targetCurrent(sim,target,life))continue;dash.hits.add(target);sim.damage(e,target,dash.damage,2862,'physical',undefined,from,{allowCritical:false,skillLevel:dash.rank});
   if(!workCurrent(sim,e,dash)){syncLife(sim,e);return;}if(targetCurrent(sim,target,life))push(sim,e,target,dash.dir,rule(e,'Q'),dash,life);
   if(!workCurrent(sim,e,dash)){syncLife(sim,e);return;}}
  if(sim.terrain&&!sim.terrain.segment(from,next,e.bodyRadius||0)){s.dash=null;notify(sim,e,'q-blocked');return;}
  const motion=displace(sim,e,next,{reason:'q-dash',ignore:[...dash.hits]});if(trace?.blocked||motion.blocked||remaining<=travel+1e-8){s.dash=null;notify(sim,e,trace?.blocked||motion.blocked?'q-blocked':'q-end');}
 };
 const wContact=(sim,e,p)=>{if(!workCurrent(sim,e,p)){syncLife(sim,e);return;}const r=rule(e,'W'),targets=[...sim.entities.values()].filter(target=>sim.enemies(e,target)&&distance(p.origin,target)<=p.range+(target.bodyRadius||0)).map(target=>({target,life:target.reviveCount}));
  for(const {target,life}of targets){if(!workCurrent(sim,e,p)){syncLife(sim,e);return;}if(!targetCurrent(sim,target,life))continue;
   const d=direction(p.origin,target),dot=d?p.dir.x*d.x+p.dir.z*d.z:1;if(dot+1e-8<Math.cos(policy.wHalfAngle))continue;
   sim.damage(e,target,p.damage,2863,'physical',undefined,p.origin,{allowCritical:false,skillLevel:r.rank});if(!workCurrent(sim,e,p)){syncLife(sim,e);return;}
   if(targetCurrent(sim,target,life))addEffect(sim,e,target,'slow',{until:sim.time+r.slowSeconds,percent:r.slowPercent,rank:r.rank});}
  if(!workCurrent(sim,e,p)){syncLife(sim,e);return;}
  e.buffs=e.buffs.filter(buff=>buff.slot!=='kirito:w-attack');e.buffs.push({slot:'kirito:w-attack',until:sim.time+r.selfAttackSeconds,attackBonus:r.selfAttackFlat});state(e).wUntil=sim.time+r.selfAttackSeconds;sim.updateBuffs(e);
 };
 const endR=(sim,e,reason)=>{const s=state(e);if(!s.r)return;s.r=null;sim.updateBuffs(e);notify(sim,e,'r-end',{reason});};
 const tickR=(sim,e)=>{const s=state(e),r=s.r;if(!r)return;if(!workCurrent(sim,e,r)){syncLife(sim,e);return;}const target=r.target;
  if(sim.entities.get(target.id)!==target||!target.alive||target.reviveCount!==r.targetLife){endR(sim,e,'target-unavailable');return;}
  while(s.r&&r.nextAt<=sim.time+1e-8){const center={x:target.x,z:target.z};if(policy.rFollowTarget)blink(sim,e,{x:clamp(center.x+(target.bodyRadius||.2)+(e.bodyRadius||.2)+.15,0,655.35),z:center.z},'r-follow');
   const victims=[...sim.entities.values()].filter(victim=>sim.enemies(e,victim)&&distance(center,victim)<=policy.rRadius+(victim.bodyRadius||0)).map(victim=>({victim,life:victim.reviveCount}));
   for(const {victim,life}of victims){if(!targetCurrent(sim,victim,life))continue;
    sim.damage(e,victim,r.damage,2869,'true',undefined,center,{allowCritical:false,skillLevel:r.rank});if(!workCurrent(sim,e,r)){syncLife(sim,e);return;}}
   r.pairs++;s.reductionUntil=sim.time+rule(e,'R').damageReductionSeconds;
   const job={kind:'r-pair',owner:e,sim,epoch:s.epoch,life:e.reviveCount,p:{...center},end:{...center},until:sim.time+policy.rVisualLife,rank:r.rank,bulletId:2869,nativeSpeed:0};
   s.jobs.push(job);s.issued.add(job);sim.event('kirito-projectile',{id:e.id,kind:'r-pair',modelJob:job,bulletId:2869,skillId:2869,rank:r.rank});
   notify(sim,e,'r-pair',{pair:r.pairs,center,damage:r.damage});r.nextAt+=policy.rPairInterval;
   if(r.pairs===policy.rPairCount){endR(sim,e,'completed');return;}
   if(!targetCurrent(sim,target,r.targetLife)){endR(sim,e,'target-life-ended');return;}
  }
 };
 const validMark=(sim,e,target)=>{const mark=state(e).marks.get(target);return mark&&mark.until>sim.time&&mark.life===target.reviveCount&&sim.entities.get(target.id)===target&&sim.enemies(e,target)&&distance(e,target)<=rule(e,'E').recastRange;};
 function interact(sim,e,id){if(!live(sim,e))return {ok:false,reason:'inactive'};expire(sim,e);const s=state(e),job=s.shadows.get(id);
  if(!job||job.done||job.owner!==e||job.life!==e.reviveCount||job.epoch!==s.epoch||job.until<=sim.time)return {ok:false,reason:'invalid-shadow'};
  if(s.r||s.dash||e.controlUntil>sim.time)return {ok:false,reason:'controlled'};
  if(distance(e,job.p)>policy.eShadowClickRange)return {ok:false,reason:'range'};
  blink(sim,e,job.p,'shadow-click');if(policy.eShadowConsumedOnClick){removeShadow(sim,e,job,'clicked');s.shadows.delete(id);}return {ok:true,shadowId:id};
 }
 function validateCast(sim,e,value,aim={}){if(!live(sim,e))return {ok:false,reason:'inactive'};syncLife(sim,e);expire(sim,e);const s=state(e),id=Number(typeof value==='object'?value.id:value),slot=slots.find(k=>families[k].includes(id));
  if(!slot)return {ok:false,reason:'base-skill-only'};if(s.r||s.dash)return {ok:false,reason:'casting'};if(e.controlUntil>sim.time)return {ok:false,reason:'controlled'};
  const sk=skill(e,slot,id),r=rule(e,slot);if((aim.x!==undefined||aim.z!==undefined)&&!point(aim))return {ok:false,reason:'invalid-aim'};
  const recast=id===2866;if(recast){if(s.recastUntil<=sim.time)return {ok:false,reason:'recast-window'};if(s.recastAt>sim.time+1e-8)return {ok:false,reason:'cooldown'};}
  else if((e.cooldowns[slot]||0)>sim.time+1e-8)return {ok:false,reason:'cooldown'};
  let target,dir;
  if(slot==='Q'||slot==='R'){target=sim.entities.get(aim.targetId);if(!target||!sim.enemies(e,target)||slot==='R'&&target.kind!=='hero'||distance(e,target)>sk.range+(target.bodyRadius||0))return {ok:false,reason:'range-or-target'};dir=direction(e,target);if(!dir)return {ok:false,reason:'direction'};}
  if(slot==='W'||slot==='E'&&!recast){dir=direction(e,aim);if(!dir)return {ok:false,reason:'direction'};}
  if(recast){target=aim.targetId?sim.entities.get(aim.targetId):[...s.marks.keys()].filter(target=>validMark(sim,e,target)).sort((a,b)=>distance(e,a)-distance(e,b)||a.id-b.id)[0];
   if(!target||!validMark(sim,e,target))return {ok:false,reason:'marked-target-required'};}
  return {ok:true,skill:sk,slot,r,target,dir,recast};
 }
 const definition={heroId:102,name:'kirito-current-ui-base',complete:false,playable:false,managesBasicAttack:true,
  install(sim,e,{levels={Q:1,W:1,E:1,R:1},talent=false,exclusiveEquipment=false}={}){
   if(e.heroId!==102||talent||exclusiveEquipment||slots.some(slot=>!Number.isInteger(levels[slot])||levels[slot]<1||levels[slot]>UI[slot].length))return false;
   if(states.get(e)?.sim===sim)return true;const s={sim,owner:e,levels:{...levels},epoch:0,life:e.reviveCount,dash:null,pending:[],jobs:[],issued:new WeakSet(),marks:new Map(),shadows:new Map(),recastUntil:0,recastAt:0,r:null,reductionUntil:0,speedDisabledUntil:0,wUntil:0};
   states.set(e,s);e.kiritoBase=s;for(const slot of slots)e.skills[slot]=skill(e,slot);
   e.attackSkillId=2861;e.attackAliases=[];e.attackProfiles={2861:{range:1.5,attackWindup:policy.basicWindup,projectileSpeed:policy.basicProjectileSpeed}};
   e.attackWindup=policy.basicWindup;e.projectileSpeed=policy.basicProjectileSpeed;e.baseRange=1.5;sim.updateBuffs(e);return true;
  },isInstalled:e=>states.has(e),affects:e=>!!e.kiritoEffects?.size,
  ownsSkill:(_sim,_e,sk)=>slots.some(slot=>families[slot].includes(sk?.id)),resolveSkill(sim,e,value){expire(sim,e);const id=Number(typeof value==='object'?value.id:value),slot=slots.find(k=>families[k].includes(id));return slot?skill(e,slot,id):null;},validateCast,
  applyCast(sim,e,value,aim={}){const checked=validateCast(sim,e,value,aim);if(!checked.ok)return checked;const {slot,r,target,dir,recast}=checked,s=state(e),sk=checked.skill;
   sim.cancelWindup(e);sim.stopMotion(e);e.path=[];e.targetId=null;
   if(recast){s.recastAt=sim.time+r.recastCooldown;const d=direction(e,target)||{x:1,z:0},gap=(target.bodyRadius||.2)+(e.bodyRadius||.2)+policy.eBlinkOffset;
    blink(sim,e,{x:clamp(target.x-d.x*gap,0,655.35),z:clamp(target.z-d.z*gap,0,655.35)},'e-recast');
    castEvent(sim,e,sk,{...aim,targetId:target.id});sim.damage(e,target,r.damageBase+bonusAD(e)*r.bonusAdRatio,2865,'physical',undefined,{x:e.x,z:e.z},{allowCritical:false,skillLevel:r.rank});return {ok:true,slot,recast:true};}
   cooldown(sim,e,slot,r.cooldownSeconds);castEvent(sim,e,sk,aim);
   if(slot==='Q'){const reach=distance(e,target)+(target.bodyRadius||.2)+(e.bodyRadius||.2)+policy.qLandingOffset;
    s.dash={epoch:s.epoch,life:e.reviveCount,end:{x:clamp(e.x+dir.x*reach,0,655.35),z:clamp(e.z+dir.z*reach,0,655.35)},dir,hits:new Set(),rank:r.rank,damage:r.damageBase+totalAD(e)*r.totalAdRatio};}
   else if(slot==='W')s.pending.push({kind:'w',at:sim.time+policy.wContactDelay,epoch:s.epoch,life:e.reviveCount,origin:{x:e.x,z:e.z},dir,range:sk.range,damage:r.damageBase+bonusAD(e)*r.bonusAdRatio});
   else if(slot==='E'){s.recastUntil=sim.time+r.recastWindowSeconds;s.recastAt=sim.time+r.recastCooldown;e.skills.E=skill(e,'E',2866);
    for(const d of [dir,{x:-dir.z,z:dir.x},{x:-dir.x,z:-dir.z},{x:dir.z,z:-dir.x}])launchSword(sim,e,d,r.rank);notify(sim,e,'e-window-start',{until:s.recastUntil});}
   else{s.r={epoch:s.epoch,life:e.reviveCount,target,targetLife:target.reviveCount,rank:r.rank,pairs:0,nextAt:sim.time+policy.rFirstAt,damage:r.pairedDamageBase+totalAD(e)*r.totalAdRatio};notify(sim,e,'r-start');sim.updateBuffs(e);}
   return {ok:true,slot};
  },
  tick(sim,e,step){if(e.kiritoEffects)for(const [owner,effects]of e.kiritoEffects){if(!live(sim,owner)){e.kiritoEffects.delete(owner);continue;}for(const [key,effect]of Object.entries(effects))if(effect.until<=sim.time||effect.life!==e.reviveCount)delete effects[key];if(!Object.keys(effects).length)e.kiritoEffects.delete(owner);}
   if(!live(sim,e))return;syncLife(sim,e);const s=state(e);expire(sim,e);tickDash(sim,e,step);
   for(const p of [...s.pending])if(p.at<=sim.time+1e-8){s.pending=s.pending.filter(other=>other!==p);if(p.epoch===s.epoch&&p.life===e.reviveCount)wContact(sim,e,p);}
   for(const job of [...s.jobs])if(!job.done&&job.epoch===s.epoch&&job.life===e.reviveCount){if(job.kind==='sword')tickSword(sim,e,job,step);else if(job.until<=sim.time){if(job.kind==='shadow')removeShadow(sim,e,job,'expired');else job.done=true;}}
   s.jobs=s.jobs.filter(job=>!job.done);tickR(sim,e);
  },
  modifiers(sim,e){const s=state(e),enemyTeams=[1,2,3].filter(team=>team!==e.team),passive=s&&live(sim,e)&&sim.time>=s.speedDisabledUntil&&!enemyTeams.some(team=>revealed(sim,e,team));
   const slows=[...(e.kiritoEffects?.entries()||[])].filter(([owner])=>live(sim,owner)).map(([_owner,d])=>d.slow?.until>sim.time&&d.slow.life===e.reviveCount?d.slow.percent:0);
   return {speedPercent:(passive?10:0)-Math.max(0,...slows),untargetable:!!s?.r,controlImmune:!!s?.r};},
  canAct(sim,e,action){const s=state(e);return !s?.r&&!s?.dash;},onControl(sim,e){const s=state(e);if(s?.dash){s.dash=null;notify(sim,e,'q-cancel');}},
  beforeDamage(sim,target,_attacker,event){const s=state(target);if(s?.sim!==sim)return;const reduction=s.reductionUntil>sim.time?rule(target,'R').damageReductionPercent:0;
   if(s.r)return {received:0,absorbed:event.received,blocked:true};return reduction?{received:Math.floor(event.received*(1-reduction/100)+1e-8),absorbed:0,blocked:false}:undefined;},
  onDamageTaken(sim,e,_attacker,event){const s=state(e);if(s&&event.landed===true){s.speedDisabledUntil=sim.time+UI.passive.disabledAfterAttackedSeconds;sim.updateBuffs(e);}},
  basicAttackSkill:()=>2861,onRespawn(sim,e){clear(sim,e,'respawn');state(e).life=e.reviveCount;},onLeave:clear,
  world:{onDeath(sim,_killer,victim,context){if(context?.targetCurrent===false||typeof context?.recipientCurrent==='function'&&!context.recipientCurrent(victim))return;if(states.has(victim))clear(sim,victim,'death');victim.kiritoEffects?.clear();}},
  native:{sync:(sim,e,opts)=>require('./kirito-native').sync(sim,e,opts),beforeCast:(sim,e,_event,_skill,opts)=>require('./kirito-native').sync(sim,e,opts),
   isProjectileEvent:(_e,event)=>event.type==='kirito-projectile',projectile:(e,event,id)=>require('./kirito-projectiles-native').launch(e,event,id),
   tickProjectile:(native,time)=>require('./kirito-projectiles-native').tick(native,time),finishProjectile:native=>require('./kirito-projectiles-native').finish(native)},
  interact,observerView(sim,e,viewer){const hidden=viewer?.id!==e.id;return {hideAttributes:hidden,hideEquipment:hidden,hp:hidden&&e.alive&&e.hp>0?(e.hp/e.hpMax>.5?e.hpMax:e.hpMax*.5):e.hp,hpMax:e.hpMax};},policies:policy,uiRules:UI};
 return {definition,state,interact,visibleToTeam:revealed,policy};
}
module.exports={createDefinition,direction,segmentDistance,UI,POLICY};
