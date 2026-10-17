'use strict';

// Opt-in HeroRuntime definition. The user-authorized installed client UI is the
// arithmetic/rules baseline; BASE_POLICY makes unobserved host choices explicit.
// No default registry mutation, account mutation, service, or native cloud clone.
const snapshot=require('./snapshot.json');
const Energy=require('./kanna-energy-host');
const Q=require('./kanna-q-host');
const rows=new Map(snapshot.skillLevels.map(r=>[`${r.named.nSkillID}:${r.named.nLevel}`,r.named]));
const ROLE={9453:'Q',9470:'Q',9455:'W',9461:'W',9456:'E',9460:'E',9458:'R'};
const IDS=new Set(Object.keys(ROLE).map(Number));
const BASE_POLICY=Object.freeze({basis:'user-authorized installed client UI baseline, pending native acceptance',
  spawnEnergy:0,normalFirstGain:5,chargingFirstGain:1,capClock:'continue',modeChangeResetsClock:true,spendKeepsClock:true,
  qContactDelay:.267,qRefundRounding:'floor-half-actual-spend',qCooldownRefund:'halve-remaining',qRefundOncePerCast:true,
  passiveTrigger:'accepted offensive Q/E-create/R with an eligible nearby first enemy',passiveNearestHop:3,passiveFirstMultiplier:.5,
  passiveDamageLevels:'1..4 by hero level 1/6/11/16; duplicate 5..8 not selected',
  cloudFirstAttack:2,cloudLifetime:8,cloudExpireAfterLastPulse:true,cloudAwayInterpolation:'linear from full at4 to half at8',
  cloudNativePoint:'direction when nativePoint+direction; explicit point otherwise',cloudTowardsScale:1,cloudStunBuildings:false,
  rDelay:1.5,rRangeOrigin:'cast-origin snapshot',rChildSkills:'9459 inner / 9466 outer host baseline mapping',
  rVision:'3 seconds for non-invisible hit heroes, no anti-invisibility',death:'cancel old-life deferred actions and cloud; respawn energy0',
  postHitLife:'freeze world/owner/life/epoch and each target before a damage batch; recheck after damage/control; never carry old jobs into a revive',
  control:'stop W; accepted Q/R persist until own death',basicWindup:.18,basicRawFlyDelayMs:180,basicTiming:'overlap candidate, never add180+180',
  nativeCloud:'current model9456/state9456 compact type13 candidate, flags0/parameter0; native acceptance pending'});
const EPS=1e-8,dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z),point=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.z)&&p.x>=0&&p.z>=0&&p.x<=655.35&&p.z<=655.35;
const fail=reason=>({ok:false,reason}),clamp=(n,a,b)=>Math.max(a,Math.min(b,n)),copyPoint=e=>({x:e.x,z:e.z});
const ap=e=>Number.isFinite(e.attributes?.[31])?e.attributes[31]:Number.isFinite(e.abilityPower)?e.abilityPower:0;
function cdr(e){const cap=40+(e.equipmentCooldownCapBonus||0);return clamp(e.attributes?.[100]||0,0,cap)/100;}
function metadata(id,level){const r=rows.get(`${id}:${level}`);if(!r)return null;const slot=ROLE[id],cd=id===9453||id===9470?4:id===9455?0:id===9461?[8,7,6,5,4][level-1]:id===9456?[22,21,20,19,18][level-1]:id===9460?0:[160,150,140][level-1];
  return {id,slot,level,name:r.strSkillName,type:'hero-specific',mana:r.nCostMP,cooldown:cd,range:r.fRange,targetRange:r.fTargetRange,action:r.strSkillAct,
    damageType:'magic',rawCooldownMs:r.nCDTime,rawShakeMs:r.nSkillShakeTime,rawFlyDelayMs:r.nFlyDelayTime,rawDurationMs:r.nSkillDuration,basis:BASE_POLICY.basis};}
function createDefinition(){
  const states=new WeakMap();
  const energy=Energy.createDefinition({clock:{evidence:BASE_POLICY.basis,capBehavior:'continue',
    onModeChange:({sim,state,mode})=>({nextGainAt:sim.time+(mode==='charging'?1:5),nextDecayAt:mode==='normal'&&state.energy>3?sim.time+1:null}),
    afterSpend:({sim,state,mode})=>({nextGainAt:state.nextGainAt??sim.time+(mode==='charging'?1:5),nextDecayAt:mode==='normal'&&state.energy>3?state.nextDecayAt??sim.time+1:null})},
    lifecycle:{onRespawn:({sim})=>({energy:0,nextGainAt:sim.time+5,nextDecayAt:null,evidence:BASE_POLICY.basis,wCooldownResolved:true})},
    exitPolicy:({sim,entity,pending})=>({cooldownUntil:sim.time+[8,7,6,5,4][pending.level-1]*(1-cdr(entity)),cooldownSkillId:9455,cooldownEvidence:BASE_POLICY.basis,speedUntil:sim.time+3,speedEvidence:BASE_POLICY.basis}),
    controlPolicy:{stopCharge:true,evidence:BASE_POLICY.basis}});
  const stateFor=(sim,e)=>{const s=states.get(e);return sim?.entities?.get(e?.id)===e&&s?.world===sim?s:null;};
  const ownerToken=(sim,e,s)=>({world:sim,owner:e,life:e.reviveCount,epoch:s.epoch});
  const ownerCurrent=(sim,e,p)=>{const s=stateFor(sim,e);return !!s&&!s.closed&&!sim.heroes?.closed&&e.alive&&p.world===sim&&p.owner===e&&
    (p.life??p.ownerLife)===e.reviveCount&&p.epoch===s.epoch;};
  const targetCurrent=(sim,t,life,allowDead=false)=>sim.entities.get(t?.id)===t&&t.reviveCount===life&&(allowDead||t.alive);
  function syncSlots(sim,e){const s=stateFor(sim,e),es=energy.state(e);if(!s||!es)return;for(const slot of ['Q','W','E','R']){
    const level=es.levels[slot],id=slot==='Q'?(es.charging?9470:9453):slot==='W'?(es.charging?9461:9455):slot==='E'?(s.cloud?9460:9456):9458;
    if(level){e.skills[slot]=metadata(id,level);if(slot==='E'&&id===9456&&es.charging)e.skills[slot].range+=2;}else delete e.skills[slot];}}
  function install(sim,e,settings={}){
    if(e.heroId!==234||sim.entities.get(e.id)!==e)return false;if(states.has(e))return states.get(e).world===sim&&!states.get(e).closed;
    const levels=settings.levels||{},initial=settings.initial||{mode:'normal',energy:0,nextGainAt:sim.time+5,evidence:BASE_POLICY.basis};
    if(!energy.definition.install(sim,e,{levels,initial}))return false;
    const s={world:sim,owner:e,life:e.reviveCount,epoch:0,nextCastId:1,pending:new Map(),cloud:null,reveals:new Map(),nativeLinks:new Map(),closed:false,nativeStatuses:new Map()};states.set(e,s);e.kannaBattle=s;e.cooldowns||={};
    e.attackSkillId=9451;e.attackProfiles||={};e.attackProfiles[9451]={range:5.3,attackWindup:.18,projectileSpeed:20,rawFlyDelayMs:180,rawShakeMs:180,timingBasis:BASE_POLICY.basicTiming};e.attackAliases=[];
    // A bridge may supply equipment-adjusted base range; do not overwrite it.
    if(!Number.isFinite(e.baseRange))e.baseRange=5.3;syncSlots(sim,e);sim.updateBuffs?.(e);return true;
  }
  function resolveSkill(sim,e,value){const s=stateFor(sim,e),id=Number(typeof value==='object'?value?.id:value),slot=ROLE[id],level=energy.state(e)?.levels[slot];if(!s||!slot||!level)return null;
    const skill=metadata(id,level);if(id===9456&&energy.state(e).charging)skill.range+=2;return skill;}
  function nearest(sim,e,center,radius,visited=new Set(),heroesOnly=false){return [...sim.entities.values()].filter(t=>sim.enemies(e,t)&&point(t)&&(!heroesOnly||t.kind==='hero')&&!visited.has(t.id)&&dist(center,t)<=radius+EPS).sort((a,b)=>dist(center,a)-dist(center,b)||a.id-b.id)[0]||null;}
  function activeId(s,es,slot){return slot==='Q'?(es.charging?9470:9453):slot==='W'?(es.charging?9461:9455):slot==='E'?(s.cloud?9460:9456):9458;}
  function aimPoint(sim,e,aim){const selected=aim.point||aim;return point(selected)?copyPoint(selected):point(sim.entities.get(aim.targetId))?copyPoint(sim.entities.get(aim.targetId)):null;}
  function validateCast(sim,e,value,aim={}){
    if(sim.heroes?.closed)return fail('world-closed');const s=stateFor(sim,e),skill=resolveSkill(sim,e,value),es=energy.state(e);if(!s||!skill||s.closed)return fail('unknown-kanna-skill');
    if(!e.alive||s.life!==e.reviveCount||es.energy===null)return fail('dead-or-new-life');if(e.controlUntil>sim.time)return fail('controlled');
    if(activeId(s,es,skill.slot)!==skill.id)return fail('inactive-stage');
    if(skill.slot==='W'){const checked=energy.definition.validateCast(sim,e,skill);return checked.ok?{ok:true,s,es,skill}:checked;}
    if(skill.id!==9460&&(e.cooldowns[skill.slot]||0)>sim.time+EPS)return fail('cooldown');if(!Number.isFinite(e.mp)||e.mp<skill.mana)return fail('mana');
    if(skill.id===9453){const target=sim.entities.get(aim.targetId);if(!target||!sim.enemies(e,target)||!point(target))return fail('invalid-target');if(dist(e,target)>skill.range+EPS)return fail('range');return {ok:true,s,es,skill,target,at:copyPoint(target)};}
    if(skill.id===9470||skill.id===9456){const at=aimPoint(sim,e,aim);if(!at)return fail('invalid-point');if(dist(e,at)>skill.range+EPS)return fail('range');return {ok:true,s,es,skill,at};}
    if(skill.id===9460){if(!s.cloud)return fail('cloud-missing');const target=sim.entities.get(aim.targetId);if(target&&sim.enemies(e,target)&&point(target))return {ok:true,s,es,skill,target,at:copyPoint(target)};
      const raw=Number.isFinite(aim.dirX)&&Number.isFinite(aim.dirZ)?{x:aim.dirX,z:aim.dirZ}:aim.direction&&Number.isFinite(aim.direction.x)&&Number.isFinite(aim.direction.z)?aim.direction:Number.isFinite(aim.direction)?{x:Math.cos(aim.direction),z:Math.sin(aim.direction)}:null;
      const length=raw?Math.hypot(raw.x,raw.z):0,direction=length>EPS?{x:raw.x/length,z:raw.z/length}:null;
      if(aim.nativePoint&&direction)return {ok:true,s,es,skill,direction};const at=aimPoint(sim,e,aim);if(at)return {ok:true,s,es,skill,at};if(direction)return {ok:true,s,es,skill,direction};return fail('invalid-cloud-order');}
    return {ok:true,s,es,skill,at:copyPoint(e)};
  }
  function castEvent(sim,e,skill,at,target,castId){const origin=copyPoint(e);sim.event('cast',{id:e.id,slot:skill.slot,skillId:skill.id,skill,readyAt:skill.id===9460?sim.time:e.cooldowns[skill.slot]??sim.time,
    aim:{...(at||origin),...(target?{targetId:target.id}:{})},castOrigin:origin,targetIds:target?[target.id]:[],hp:e.hp,mp:e.mp,kannaCastId:castId});}
  function chain(sim,e,skill,first,castId,p){if(!first||!ownerCurrent(sim,e,p))return;const firstLife=first.reviveCount;
    if(!targetCurrent(sim,first,firstLife)||!sim.enemies(e,first))return;
    // Freeze the entire potential bounce batch before the first damage callback.
    // A hook reviving/replacing a later target cannot make that new life eligible.
    const candidates=[...sim.entities.values()].filter(t=>sim.enemies(e,t)&&point(t)).map(t=>({target:t,life:t.reviveCount}));
    const spent=energy.consumeForAcceptedSkill(sim,e,{castId,skillId:skill.id,targetId:first.id,accepted:true,evidence:BASE_POLICY.basis});if(!spent.consumed||!ownerCurrent(sim,e,p))return;
    const tier=(e.level||1)>=16?3:(e.level||1)>=11?2:(e.level||1)>=6?1:0,raw=[40,70,100,130][tier]+ap(e)*.25,visited=new Set();let target=first,index=0,previous=e;
    let life=firstLife;while(target){if(!ownerCurrent(sim,e,p)||!targetCurrent(sim,target,life)||!sim.enemies(e,target))break;
      visited.add(target.id);const center=copyPoint(target);addLink(sim,e,20001,previous,target,1,p);sim.damage(e,target,raw*(index===0?.5:1),9463,'magic',undefined,copyPoint(previous),{skillLevel:tier+1});index++;
      if(!ownerCurrent(sim,e,p)||!targetCurrent(sim,target,life,true))break;previous=target;
      const next=candidates.filter(r=>!visited.has(r.target.id)&&targetCurrent(sim,r.target,r.life)&&sim.enemies(e,r.target)&&dist(center,r.target)<=3+EPS)
        .sort((a,b)=>dist(center,a.target)-dist(center,b.target)||a.target.id-b.target.id)[0];target=next?.target;life=next?.life;}
    sim.event('kanna-chain',{id:e.id,castId,targets:[...visited],rawDamage:raw,firstMultiplier:.5,basis:BASE_POLICY.basis});}
  function removeCloud(sim,e,reason){const s=states.get(e);if(s?.world!==sim||!s.cloud)return;s.cloud.ended=true;s.cloud.endedAt=sim.time;s.cloud.endReason=reason;sim.event('kanna-cloud-remove',{id:e.id,cloudId:s.cloud.id,reason});s.cloud=null;syncSlots(sim,e);}
  function createCloud(sim,e,skill,at){const s=stateFor(sim,e);let id=sim.nextId++;while(sim.entities.has(id))id=sim.nextId++;
    s.cloud={id,owner:e,ownerLife:e.reviveCount,world:sim,epoch:s.epoch,ended:false,level:skill.level,x:at.x,z:at.z,createdAt:sim.time,expiresAt:sim.time+8,nextPulseAt:sim.time+2,lastAt:sim.time,goal:null,pulses:0,motion:{speed:0,direction:{x:0,z:0},endpoint:{...at}}};syncSlots(sim,e);
    sim.event('kanna-cloud-create',{id:e.id,cloudId:id,ownerLife:e.reviveCount,epoch:s.epoch,skillId:9456,modelIds:[9456,9457],x:at.x,z:at.z,level:skill.level,expiresAt:s.cloud.expiresAt,nextPulseAt:s.cloud.nextPulseAt,nativeAccepted:false});}
  function applyCast(sim,e,value,aim={}){
    const checked=validateCast(sim,e,value,aim);if(!checked.ok)return checked;const {s,skill,target,at,direction}=checked,castId=s.nextCastId++;
    if(skill.slot==='W'){const result=energy.definition.applyCast(sim,e,skill,aim);if(!result.ok)return result;syncSlots(sim,e);castEvent(sim,e,skill,copyPoint(e),null,castId);return {...result,castId};}
    if(skill.id===9460){const cloud=s.cloud;cloud.goal=target?{mode:'target',entity:target,id:target.id,life:target.reviveCount}:direction?{mode:'direction',...direction}:{mode:'point',...at};sampleCloudMotion(e,cloud);
      castEvent(sim,e,skill,at||copyPoint(cloud),target,castId);sim.event('kanna-cloud-order',{id:e.id,cloudId:cloud.id,goal:{...cloud.goal,entity:undefined},castId});return {ok:true,castId};}
    e.mp-=skill.mana;e.cooldowns[skill.slot]=sim.time+skill.cooldown*(1-cdr(e));
    if(skill.slot==='Q')sim.event('skill-prefire',{id:e.id,skillId:skill.id,skillLevel:skill.level,skill,direction:{x:at.x-e.x,z:at.z-e.z},origin:copyPoint(e)});
    castEvent(sim,e,skill,at,target,castId);
    const origin=copyPoint(e),pending={...ownerToken(sim,e,s),castId,origin,skill,spentMana:skill.mana,refunded:false};
    if(skill.id===9453||skill.id===9470){pending.kind='Q';pending.at=sim.time+.267;pending.point=at;pending.target=target;pending.targetLife=target?.reviveCount;pending.raw=Q.calculateDisplayedDamage(skill.level,{31:ap(e)}).value;s.pending.set(castId,pending);
      chain(sim,e,skill,target||nearest(sim,e,at,2.5),castId,pending);}
    else if(skill.id===9456){createCloud(sim,e,skill,at);chain(sim,e,skill,nearest(sim,e,at,3),castId,pending);}
    else {pending.kind='R';pending.at=sim.time+1.5;pending.raw=150+100*(skill.level-1)+ap(e)*.5;s.pending.set(castId,pending);chain(sim,e,skill,nearest(sim,e,e,Infinity,new Set(),true),castId,pending);}
    return {ok:true,castId,pendingUntil:pending.at};
  }
  function refund(sim,e,p){if(p.refunded||!ownerCurrent(sim,e,p))return;p.refunded=true;e.mp=Math.min(e.mpMax,e.mp+Math.floor(p.spentMana*.5));e.cooldowns.Q=sim.time+Math.max(0,e.cooldowns.Q-sim.time)*.5;
    sim.event('hero-resource',{id:e.id,hp:e.hp,mp:e.mp,reason:'kanna-q-kill-refund'});sim.event('skill-cooldown',{id:e.id,slot:'Q',skillId:p.skill.id,skill:p.skill,readyAt:e.cooldowns.Q,reason:'kanna-q-kill-refund'});}
  function isInvisible(t){return t.invisible===true||t.effectInvisible===true||t.stealthed===true;}
  function addLink(sim,e,statusId,source,target,duration,p){if(!target||!sim.enemies(e,target)||p&&!ownerCurrent(sim,e,p))return;const s=stateFor(sim,e);if(!s||s.closed)return;const key=`${statusId}:${source.id}:${target.id}`;
    const record={id:statusId,actor:target.id,target,targetLife:target.reviveCount,sourceActorId:source.id,sourceObject:source,sourceLife:source.reviveCount??source.ownerLife,owner:e,ownerLife:e.reviveCount,until:sim.time+duration};s.nativeLinks.set(key,record);target.kannaNativeLinks||=new Map();target.kannaNativeLinks.set(`${e.id}:${key}`,record);}
  function removeLink(e,s,key,record){if(record.target.kannaNativeLinks?.get(`${e.id}:${key}`)===record)record.target.kannaNativeLinks.delete(`${e.id}:${key}`);s.nativeLinks.delete(key);}
  function settle(sim,e,p){const s=stateFor(sim,e);if(!ownerCurrent(sim,e,p))return;
    if(p.kind==='Q'){const targets=p.skill.id===9453?(p.target&&sim.entities.get(p.target.id)===p.target&&p.target.reviveCount===p.targetLife&&sim.enemies(e,p.target)?[p.target]:[]):[...sim.entities.values()].filter(t=>sim.enemies(e,t)&&dist(p.point,t)<=2.5+EPS).sort((a,b)=>a.id-b.id);
      const batch=targets.map(t=>({target:t,life:t.reviveCount}));for(const {target:t,life}of batch){if(!ownerCurrent(sim,e,p))break;if(!targetCurrent(sim,t,life)||!sim.enemies(e,t))continue;
        if(p.skill.id===9453)addLink(sim,e,20016,e,t,1,p);sim.damage(e,t,p.raw,p.skill.id===9453?9454:9471,'magic',undefined,p.origin,{skillLevel:p.skill.level});
        if(!ownerCurrent(sim,e,p))break;if(targetCurrent(sim,t,life,true)&&!t.alive)refund(sim,e,p);}return;}
    const targets=[...sim.entities.values()].filter(t=>t.kind==='hero'&&sim.enemies(e,t)).sort((a,b)=>a.id-b.id).map(t=>({target:t,life:t.reviveCount}));
    for(const {target:t,life}of targets){if(!ownerCurrent(sim,e,p))break;if(!targetCurrent(sim,t,life)||!sim.enemies(e,t))continue;
      const inner=dist(p.origin,t)<=25+EPS,visible=!isInvisible(t);sim.damage(e,t,p.raw*(inner?1:.5),inner?9459:9466,'magic',undefined,p.origin,{skillLevel:p.skill.level});
      if(!ownerCurrent(sim,e,p))break;if(visible&&targetCurrent(sim,t,life)&&sim.enemies(e,t)){s.reveals.set(t.id,{target:t,life,until:sim.time+3});t.kannaReveals||=new Map();t.kannaReveals.set(e.id,{source:e,sourceLife:p.life,targetLife:life,until:sim.time+3});sim.event('kanna-vision',{id:e.id,targetId:t.id,until:sim.time+3,antiInvisibility:false});}}
  }
  function baseCloudSpeed(e){const raw=e.attributes?.[129];if(Number.isFinite(raw)&&raw>0)return raw/100;if(Number.isFinite(e.clientBaseMoveSpeed)&&e.clientBaseMoveSpeed>0)return e.clientBaseMoveSpeed/100;return e.baseSpeed||3.01;}
  function cloudScale(e,c,dx,dz){if(dx*(c.x-e.x)+dz*(c.z-e.z)<=0)return 1;return 1-.5*clamp((dist(e,c)-4)/4,0,1);}
  function sampleCloudMotion(e,c){let dx=0,dz=0,endpoint=copyPoint(c);const g=c.goal;if(g?.mode==='target'){const t=c.world.entities.get(g.id);if(t!==g.entity||!t.alive||t.reviveCount!==g.life)c.goal=null;else {dx=t.x-c.x;dz=t.z-c.z;endpoint=copyPoint(t);}}
    else if(g?.mode==='point'){dx=g.x-c.x;dz=g.z-c.z;endpoint={x:g.x,z:g.z};}else if(g?.mode==='direction'){dx=g.x;dz=g.z;let reach=Infinity;for(const key of ['x','z'])if(g[key]>0)reach=Math.min(reach,(655.35-c[key])/g[key]);else if(g[key]<0)reach=Math.min(reach,-c[key]/g[key]);endpoint={x:clamp(c.x+dx*(Number.isFinite(reach)?reach:0),0,655.35),z:clamp(c.z+dz*(Number.isFinite(reach)?reach:0),0,655.35)};}
    const length=Math.hypot(dx,dz);if(length<=EPS){c.motion={speed:0,direction:{x:0,z:0},endpoint:copyPoint(c)};return c.motion;}dx/=length;dz/=length;c.motion={speed:baseCloudSpeed(e)*cloudScale(e,c,dx,dz),direction:{x:dx,z:dz},endpoint};return c.motion;}
  function cloudCurrent(sim,e,c){return !!c&&ownerCurrent(sim,e,c)&&stateFor(sim,e).cloud===c&&!c.ended&&!sim.entities.has(c.id);}
  function moveCloud(sim,e,c,until){if(!cloudCurrent(sim,e,c))return;const dt=Math.max(0,until-c.lastAt);c.lastAt=until;if(!c.goal||dt<=0){sampleCloudMotion(e,c);return;}let dx,dz,remaining=Infinity;
    if(c.goal.mode==='target'){const t=sim.entities.get(c.goal.id);if(t!==c.goal.entity||!t.alive||t.reviveCount!==c.goal.life){c.goal=null;sampleCloudMotion(e,c);return;}dx=t.x-c.x;dz=t.z-c.z;remaining=Math.hypot(dx,dz);}
    else if(c.goal.mode==='point'){dx=c.goal.x-c.x;dz=c.goal.z-c.z;remaining=Math.hypot(dx,dz);}else {dx=c.goal.x;dz=c.goal.z;}
    const magnitude=Math.hypot(dx,dz);if(magnitude<=EPS){if(c.goal.mode!=='target')c.goal=null;sampleCloudMotion(e,c);return;}dx/=magnitude;dz/=magnitude;const speed=baseCloudSpeed(e)*cloudScale(e,c,dx,dz),step=Math.min(remaining,speed*dt);c.x=clamp(c.x+dx*step,0,655.35);c.z=clamp(c.z+dz*step,0,655.35);
    if(step>=remaining-EPS&&c.goal.mode==='point')c.goal=null;sampleCloudMotion(e,c);sim.event('kanna-cloud-move',{id:e.id,cloudId:c.id,x:c.x,z:c.z,speed,nativeAccepted:false});}
  function tickCloud(sim,e){const s=stateFor(sim,e),c=s?.cloud;if(!c)return;if(sim.entities.has(c.id)){removeCloud(sim,e,'reserved-id-collision');return;}if(!cloudCurrent(sim,e,c)){removeCloud(sim,e,'owner-life-ended');return;}
    const now=Math.min(sim.time,c.expiresAt);while(cloudCurrent(sim,e,c)&&c.nextPulseAt<=now+EPS){const scheduledAt=c.nextPulseAt;moveCloud(sim,e,c,scheduledAt);if(!cloudCurrent(sim,e,c))return;
      const t=nearest(sim,e,c,3),targetLife=t?.reviveCount;c.pulses++;c.nextPulseAt+=2;if(t&&targetCurrent(sim,t,targetLife)&&sim.enemies(e,t)){
        addLink(sim,e,20019,c,t,1,c);sim.damage(e,t,30+20*(c.level-1)+ap(e)*.35,9457,'magic',undefined,copyPoint(c),{skillLevel:c.level});
        if(cloudCurrent(sim,e,c)&&targetCurrent(sim,t,targetLife)&&sim.enemies(e,t)&&!['tower','building','base'].includes(t.kind))sim.control(t.id,.1,e);}
      sim.event('kanna-cloud-pulse',{id:e.id,cloudId:c.id,targetId:t?.id,number:c.pulses,scheduledAt,level:c.level,ownerLife:c.ownerLife,epoch:c.epoch});}
    if(!cloudCurrent(sim,e,c))return;moveCloud(sim,e,c,now);if(sim.time>=c.expiresAt-EPS)removeCloud(sim,e,'expired');}
  function clearReveal(sim,e,s,id,record,reason){if(record.target.kannaReveals?.get(e.id)?.source===e)record.target.kannaReveals.delete(e.id);s.reveals.delete(id);sim.event('kanna-vision-end',{id:e.id,targetId:id,reason});}
  function clear(sim,e,reason){const s=states.get(e);if(s?.world!==sim)return;s.pending.clear();s.epoch++;s.life=e.reviveCount;removeCloud(sim,e,reason);for(const [key,r]of [...s.nativeLinks])removeLink(e,s,key,r);for(const [id,r]of [...s.reveals])clearReveal(sim,e,s,id,r,reason);}
  function tick(sim,e,step){const s=stateFor(sim,e);if(!s||s.closed||sim.heroes?.closed)return;energy.definition.tick(sim,e,step);syncSlots(sim,e);if(s.life!==e.reviveCount){clear(sim,e,'new-life');return;}
    const token=ownerToken(sim,e,s);for(const [id,p]of [...s.pending])if(sim.time>=p.at-EPS){s.pending.delete(id);settle(sim,e,p);if(!ownerCurrent(sim,e,token))return;}tickCloud(sim,e);if(!ownerCurrent(sim,e,token))return;
    for(const [key,r]of [...s.nativeLinks])if(r.until<=sim.time+EPS||sim.entities.get(r.actor)!==r.target||!r.target.alive||r.target.reviveCount!==r.targetLife||r.sourceObject.ended||(r.sourceObject.reviveCount??r.sourceObject.ownerLife)!==r.sourceLife)removeLink(e,s,key,r);
    for(const [id,r]of [...s.reveals])if(r.until<=sim.time+EPS||sim.entities.get(id)!==r.target||!r.target.alive||r.target.reviveCount!==r.life)clearReveal(sim,e,s,id,r,'expired-or-new-life');}
  function learn(sim,e,slot,level){const s=stateFor(sim,e),es=energy.state(e);if(!s||!['Q','W','E','R'].includes(slot)||!Number.isInteger(level)||level<0||level>(slot==='R'?3:5))return fail('invalid-learning');es.levels[slot]=level;syncSlots(sim,e);return {ok:true,skill:e.skills[slot]||null};}
  const definition={heroId:234,name:'kanna-client-ui-base',install,isInstalled:e=>states.has(e),affects:e=>!!e.kannaReveals?.size||!!e.kannaNativeLinks?.size,ownsSkill:(_sim,_e,v)=>IDS.has(Number(typeof v==='object'?v?.id:v)),resolveSkill,validateCast,applyCast,tick,
    modifiers:(sim,e)=>stateFor(sim,e)&&!stateFor(sim,e).closed?energy.definition.modifiers(sim,e):{},canAct:(sim,e,a)=>stateFor(sim,e)?energy.definition.canAct(sim,e,a):true,
    onMoveOrder(sim,e,goal){if(!stateFor(sim,e))return;const r=energy.definition.onMoveOrder(sim,e,goal);syncSlots(sim,e);return r;},
    onControl(sim,e,reason){if(!stateFor(sim,e))return;energy.definition.onControl(sim,e,reason);syncSlots(sim,e);},
    onRespawn(sim,e){if(!stateFor(sim,e))return;clear(sim,e,'respawn');energy.definition.onRespawn(sim,e);syncSlots(sim,e);},
    onLeave(sim,e){if(!stateFor(sim,e))return;clear(sim,e,'leave');energy.definition.onLeave(sim,e);const s=stateFor(sim,e);if(s)s.closed=true;syncSlots(sim,e);sim.updateBuffs?.(e);},
    world:{onDeath(sim,killer,victim,context){if(context?.targetCurrent===false)return;const life=context?.targetLife??victim.reviveCount;
      energy.definition.world.onDeath(sim,killer,victim,context);if(stateFor(sim,victim)&&targetCurrent(sim,victim,life,true))clear(sim,victim,'death');}},
    native:{castPosition(event,e){return [9455,9461,9458,9453].includes(event.skillId)?event.castOrigin||e:event.aim||e;},
      sync:(sim,e,settings)=>require('./kanna-native').sync(sim,e,settings),
      beforeCast:(sim,e,event)=>event.type==='cast'?require('./kanna-native').sync(sim,e,{includeLinks:false}):[],
      isProjectileEvent:(_e,event)=>event.type==='kanna-cloud-create',
      projectile:(e,event,id)=>require('./kanna-cloud-native').launch(e,event,id),
      tickProjectile:(state,time)=>require('./kanna-cloud-native').tick(state,time),
      updateProjectile:(state,update)=>require('./kanna-cloud-native').update(state,update),
      finishProjectile:state=>require('./kanna-cloud-native').finish(state),
      damagePresentation(_e,event){return event.skillLevel?{level:event.skillLevel}:undefined;}}
  };
  return {definition,state:e=>states.get(e)||null,energy,learn,metadata,cloudScale,baseCloudSpeed,policy:BASE_POLICY,
    visionFor(sim,target,team){if(sim.heroes?.closed||sim.entities.get(target?.id)!==target||!target?.alive||isInvisible(target))return false;return [...target.kannaReveals?.values()||[]].some(r=>
      stateFor(sim,r.source)&&!stateFor(sim,r.source).closed&&r.source?.team===team&&r.source.alive&&r.sourceLife===r.source.reviveCount&&r.targetLife===target.reviveCount&&r.until>sim.time);}};
}
module.exports={BASE_POLICY,metadata,createDefinition};
