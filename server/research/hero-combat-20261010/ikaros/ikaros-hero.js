'use strict';
// Explicitly opt-in. All arithmetic follows current installed UI; policy choices
// below are executable host baselines, not claims about original-server timing.
const data=require('./parameters.json'),h=data.hero;
const rows=new Map(h.skillLevels.map(r=>[`${r.named.nSkillID}:${r.named.nLevel}`,r.named]));
const ROLE={3593:'Q',3586:'W',3587:'E',3588:'R'},IDS=new Set(Object.keys(ROLE).map(Number));
const POLICY=Object.freeze({basis:'installed complete client UI; native acceptance pending',talent:false,exclusive:false,
  wings:'QWER cast or own base child skill HP damage to enemy hero refreshes two seconds, never stack; D/F/equipment excluded',mark:'per caster; add hit mark before extra damage, refresh all for4s, cap8',
  markCritical:'independent skill critical roll using current ordinary critical damage; no basic/equipment proc callbacks',
  shieldCount:'accepted attack start, including subsequently cancelled windup; armed shield suspends count, triggered shield resumes count',
  shieldCooldown:'count capped6 during active W cooldown; generation permitted only on next attack after cooldown',
  shieldOutOfCombat:'last attack start or received damage, or shield grant, whichever latest; expire at6s then decay every5s',
  shield:'positive post-mitigation damage only consumes first hit; all types including true and guardian sharing',
  eEmpower:'first successful living-target basic hit within3s of cast; reductions on successful hit, hero1.5/nonhero.75',
  eMove:'terrain/actor-aware public route at13, no teleport; movement/cast/attack locked until landing or control',
  qProbe:'prepare.2s then speed18, capsule radius.7 plus body; first hero triggers four locked groups at .15/.30/.45/.60s',
  qGroup:'same target object/life; 70% add mark, otherwise .2s control; damage has no equipment procs',
  rArrow:'prepare.6s then speed18, range999 clipped to world; initial hero hit exclusive, nonhero prior path hits once',
  rExplosion:'fixed collision center, radius6.5 plus body, first tick.5s then every.5s through4s (8 total)',
  rVulnerability:'after initial hit; max active percent across Ikaros sources (no stacking); modifyIncomingDamage after mitigation before every hero defensive hook',
  life:'death/respawn/replace/close cancels owned jobs and all owned marks/vulnerability; no old-life hits',
  basicTiming:'windup .16s overlap candidate; independent raw shake160/flydelay150 retained, never summed',
  sampling:'cast rank is frozen for ray/groups/explosion; current total/bonusAD at each damage trigger; basic extras read current learned rank',
  rounding:'each damage transaction floors once in shared pipeline; post-mitigation W floors remaining damage'});
const EPS=1e-8,clamp=(v,a,b)=>Math.max(a,Math.min(b,v)),dist=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z),pos=e=>({x:e.x,z:e.z});
const point=p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.z)&&p.x>=0&&p.z>=0&&p.x<=655.35&&p.z<=655.35;
const fail=reason=>({ok:false,reason}),bonus=e=>Number(e.attributes?.[127]||0),total=e=>Number(e.attributes?.[30]??e.attackDamage??0);
function metadata(id,level){const r=rows.get(`${id}:${level}`),slot=ROLE[id];if(!r||!slot)return null;return {id,slot,level,type:'hero-specific',name:r.strSkillName,mana:r.nCostMP,
  cooldown:(slot==='Q'?[12,11,10,9,8]:slot==='W'?[30,29,28,27,26]:slot==='E'?[16,15,14,13,12]:[100,90,80])[level-1],
  range:r.fRange,targetRange:r.fTargetRange,action:r.strSkillAct,damageType:'physical',rawCooldownMs:r.nCDTime,rawShakeMs:r.nSkillShakeTime,
  rawFlyDelayMs:r.nFlyDelayTime,rawDurationMs:r.nSkillDuration,basis:POLICY.basis};}
function createDefinition(){
  const states=new WeakMap();
  const state=(sim,e)=>{const s=states.get(e);return sim.entities.get(e?.id)===e&&s?.world===sim?s:null;};
  const current=(sim,e,life)=>!sim.heroes.closed&&sim.entities.get(e?.id)===e&&e.alive&&e.reviveCount===life;
  const refresh=(sim,e)=>sim.updateBuffs(e);
  function syncSlots(e,s){for(const [id,slot]of Object.entries(ROLE)){if(s.levels[slot])e.skills[slot]=metadata(Number(id),s.levels[slot]);else delete e.skills[slot];}}
  function install(sim,e,settings={}){if(e.heroId!==138||sim.entities.get(e.id)!==e)return false;if(states.has(e))return states.get(e).world===sim&&!states.get(e).closed;
    if(settings.talent||settings.exclusive)throw Error('Ikaros base has no talent or exclusive equipment implementation');
    const levels={Q:0,W:0,E:0,R:0,...settings.levels};for(const [slot,l]of Object.entries(levels))if(!['Q','W','E','R'].includes(slot)||!Number.isInteger(l)||l<0||l>(slot==='R'?3:5))throw Error('Invalid Ikaros skill level');
    const s={world:sim,owner:e,life:e.reviveCount,levels,closed:false,wingsUntil:0,wingsActive:false,count:0,shield:null,lastCombatAt:sim.time,decayAt:null,
      empowerUntil:0,glide:null,nextNonce:1,projectiles:new Map(),groups:[],explosions:new Map(),nativeActors:new Map(),effects:new Map(),nativeStatuses:new Map()};
    states.set(e,s);e.ikarosBattle=s;e.cooldowns||={};e.attackSkillId=3581;e.attackAliases=[];e.attackProfiles||={};
    e.attackProfiles[3581]={range:5.5,attackWindup:.16,projectileSpeed:20,rawShakeMs:160,rawFlyDelayMs:150,timingBasis:POLICY.basicTiming};
    if(!Number.isFinite(e.baseRange))e.baseRange=5.5;syncSlots(e,s);refresh(sim,e);return true;}
  function wings(sim,e){const s=state(sim,e);if(!s||!current(sim,e,s.life))return;s.wingsUntil=sim.time+2;s.wingsActive=true;refresh(sim,e);}
  function resolveSkill(sim,e,value){const s=state(sim,e),id=Number(typeof value==='object'?value?.id:value),slot=ROLE[id];return s?.levels[slot]?metadata(id,s.levels[slot]):null;}
  function aimPoint(sim,e,aim){const p=aim.point||aim;if(point(p))return pos(p);const t=sim.entities.get(aim.targetId);return point(t)?pos(t):null;}
  function direction(sim,e,aim){const t=aimPoint(sim,e,aim),v=Number.isFinite(aim.dirX)&&Number.isFinite(aim.dirZ)?{x:aim.dirX,z:aim.dirZ}:aim.direction&&Number.isFinite(aim.direction.x)&&Number.isFinite(aim.direction.z)?aim.direction:t?{x:t.x-e.x,z:t.z-e.z}:null;
    const l=v?Math.hypot(v.x,v.z):0;return l>EPS?{x:v.x/l,z:v.z/l}:null;}
  function validateCast(sim,e,value,aim={}){const s=state(sim,e),skill=resolveSkill(sim,e,value);if(!s||!skill||s.closed)return fail('unknown-ikaros-skill');if(!current(sim,e,s.life))return fail('dead-or-new-life');
    if(e.controlUntil>sim.time)return fail('controlled');if(s.glide)return fail('gliding');if((e.cooldowns[skill.slot]||0)>sim.time+EPS)return fail('cooldown');if(e.mp<skill.mana)return fail('mana');
    if(skill.slot==='Q'||skill.slot==='R'){const d=direction(sim,e,aim);return d?{ok:true,s,skill,d}:fail('invalid-direction');}
    if(skill.slot==='E'){const p=aimPoint(sim,e,aim);if(!p)return fail('invalid-point');if(dist(e,p)>skill.range+EPS)return fail('range');const route=sim.planRoute(e,p);if(!route)return fail('blocked');return {ok:true,s,skill,p,route};}return {ok:true,s,skill};}
  function castEvent(sim,e,skill,aim,d,nonce){sim.event('cast',{id:e.id,slot:skill.slot,skillId:skill.id,skill,readyAt:e.cooldowns[skill.slot],castOrigin:pos(e),aim:aim||pos(e),direction:d,hp:e.hp,mp:e.mp,ikarosCastId:nonce});}
  function grantShield(sim,e,s,level,reason){s.shield={level,grantedAt:sim.time,triggered:false,until:Infinity};s.shieldCastUntil=reason==='active'?sim.time+.6:0;s.count=0;s.lastCombatAt=sim.time;s.decayAt=null;sim.event('ikaros-shield',{id:e.id,reason,level});}
  function endpoint(origin,d,range){let reach=range;for(const k of ['x','z'])if(d[k]>EPS)reach=Math.min(reach,(655.35-origin[k])/d[k]);else if(d[k]<-EPS)reach=Math.min(reach,-origin[k]/d[k]);return {x:clamp(origin.x+d.x*reach,0,655.35),z:clamp(origin.z+d.z*reach,0,655.35)};}
  function projectile(sim,e,s,skill,d,nonce){const origin=pos(e),end=endpoint(origin,d,skill.slot==='Q'?7:999);let id=sim.nextId++;while(sim.entities.has(id))id=sim.nextId++;
    const p={id,owner:e,ownerLife:s.life,world:sim,nonce,kind:skill.slot,skill,level:skill.level,x:origin.x,z:origin.z,origin,direction:d,endpoint:end,speed:18,
      launchAt:sim.time+(skill.slot==='Q'?.2:.6),lastAt:sim.time+(skill.slot==='Q'?.2:.6),ended:false,launched:false,hit:new Map(),hitLife:new WeakMap()};s.projectiles.set(id,p);s.nativeActors.set(id,p);return p;}
  function applyCast(sim,e,value,aim={}){const checked=validateCast(sim,e,value,aim);if(!checked.ok)return checked;const {s,skill,d,p,route}=checked,nonce=s.nextNonce++;
    sim.cancelWindup(e);e.mp-=skill.mana;const cdr=clamp(e.attributes?.[100]||0,0,40+(e.equipmentCooldownCapBonus||0))/100;e.cooldowns[skill.slot]=sim.time+skill.cooldown*(1-cdr);
    if(d)sim.event('skill-prefire',{id:e.id,skillId:skill.id,skillLevel:skill.level,skill,direction:d,origin:pos(e)});
    castEvent(sim,e,skill,p||d&&endpoint(e,d,skill.slot==='Q'?7:999),d,nonce);wings(sim,e);
    if(d)projectile(sim,e,s,skill,d,nonce);
    else if(skill.slot==='W')grantShield(sim,e,s,skill.level,'active');
    else {e.targetId=null;e.path=[];sim.stopMotion(e);s.empowerUntil=sim.time+3;s.glide={goal:route.at(-1),startedAt:sim.time,level:skill.level};
      // setRoute owns actual collision-safe route and emits the native path once.
      refresh(sim,e);sim.setRoute(e,route,s.glide.goal);}
    return {ok:true,nonce};}
  function record(sim,e,target){const s=state(sim,e);let r=s.effects.get(target);if(!r){r={owner:e,ownerLife:s.life,world:sim,target,targetLife:target.reviveCount,marks:0,markUntil:0,vulnerability:0,vulnerabilityUntil:0,rank:1};s.effects.set(target,r);target.ikarosSources||=new Map();target.ikarosSources.set(e,r);}return r;}
  function addMark(sim,e,t,count=1){if(!current(sim,e,state(sim,e)?.life)||!sim.enemies(e,t)||t.hp<=0)return;const r=record(sim,e,t);if(r.markUntil<=sim.time+EPS)r.marks=0;r.marks=Math.min(8,r.marks+count);r.markUntil=sim.time+4;return r;}
  function validRecord(sim,r){return r.world===sim&&current(sim,r.owner,r.ownerLife)&&current(sim,r.target,r.targetLife)&&!r.owner.ikarosBattle?.closed;}
  function removeRecord(s,t,r){if(t.ikarosSources?.get(r.owner)===r)t.ikarosSources.delete(r.owner);if(s.effects.get(t)===r)s.effects.delete(t);}
  function hit(sim,e,t,raw,id,level,origin,options={}){const s=state(sim,e);if(!s||!current(sim,e,s.life)||!sim.enemies(e,t)||t.hp<=0)return 0;
    return sim.skillDamage(e,t,raw,id,'physical',origin,{skillLevel:level,allowCritical:false,equipmentProcs:false,...options});}
  function onBasicHit(sim,e,t,event){const s=state(sim,e);if(!s||!current(sim,e,s.life)||!sim.enemies(e,t)||t.hp<=0||
    event.sourceCurrent===false||event.attackerLife!==undefined&&event.attackerLife!==e.reviveCount||event.targetLife!==undefined&&event.targetLife!==t.reviveCount)return;
    const ownerLife=e.reviveCount,targetLife=t.reviveCount;s.lastCombatAt=sim.time;s.decayAt=null;
    const q=s.levels.Q,empowered=s.empowerUntil>sim.time+EPS;if(q)addMark(sim,e,t);if(empowered){s.empowerUntil=0;if(q)addMark(sim,e,t);hit(sim,e,t,20*s.levels.E+.4*bonus(e),3594,s.levels.E,pos(e));}
    if(!current(sim,e,ownerLife)||sim.entities.get(t.id)!==t||t.reviveCount!==targetLife)return;
    if(q&&t.alive&&t.hp>0){const r=s.effects.get(t);if(r)hit(sim,e,t,(q+.1*bonus(e))*r.marks,3591,q,pos(e),{skillCritical:true,allowCritical:true});}
    if(!current(sim,e,ownerLife)||sim.entities.get(t.id)!==t||t.reviveCount!==targetLife)return;
    if(s.levels.E&&(e.cooldowns.E||0)>sim.time){e.cooldowns.E=Math.max(sim.time,e.cooldowns.E-(t.kind==='hero'?1.5:.75));sim.event('skill-cooldown',{id:e.id,slot:'E',skillId:3587,skill:metadata(3587,s.levels.E),readyAt:e.cooldowns.E,reason:'ikaros-basic-hit'});}}
  function onAttackStart(sim,e){const s=state(sim,e);if(!s)return {};s.lastCombatAt=sim.time;s.decayAt=null;if(s.levels.W&&(!s.shield||s.shield.triggered)){s.count=Math.min((e.cooldowns.W||0)>sim.time+EPS?6:7,s.count+1);if(s.count>=7)grantShield(sim,e,s,s.levels.W,'seven-attacks');}return {};}
  function modifyIncomingDamage(sim,t,a,event){const vulnerabilities=[...t.ikarosSources?.values()||[]].filter(r=>validRecord(sim,r)&&r.vulnerabilityUntil>sim.time+EPS).map(r=>r.vulnerability);
    return {received:vulnerabilities.length?Math.floor(event.received*(1+Math.max(...vulnerabilities)/100)+EPS):event.received};}
  function beforeDamage(sim,t,a,event){let received=event.received,absorbed=0;
    const s=state(sim,t);if(s&&current(sim,t,s.life)&&received>0){s.lastCombatAt=sim.time;s.decayAt=null;const sh=s.shield;if(sh){let ratio=0;if(!sh.triggered){ratio=[55,65,75,85,95][sh.level-1]/100;sh.triggered=true;sh.until=sim.time+[.5,.65,.8,.95,1.1][sh.level-1];}
      else if(sh.until>sim.time+EPS)ratio=.2;else s.shield=null;if(ratio){const left=Math.floor(received*(1-ratio)+EPS);absorbed=received-left;received=left;}}}
    return {received,absorbed};}
  function stopProjectile(sim,e,s,p,reason){if(p.ended)return;p.ended=true;p.endedAt=sim.time;p.endReason=reason;s.projectiles.delete(p.id);sim.event('ikaros-projectile-end',{id:e.id,projectileId:p.id,reason});}
  function sweep(a,b,t,r){const dx=b.x-a.x,dz=b.z-a.z,l2=dx*dx+dz*dz,k=l2?clamp(((t.x-a.x)*dx+(t.z-a.z)*dz)/l2,0,1):0;
    return dist({x:a.x+k*dx,z:a.z+k*dz},t)<=r+(t.bodyRadius||0)+EPS?{t,k}:null;}
  function tickProjectile(sim,e,s,p){if(!current(sim,e,p.ownerLife)||sim.entities.has(p.id)){stopProjectile(sim,e,s,p,'owner-life-or-id');return;}if(sim.time<p.launchAt-EPS)return;
    if(!p.launched){p.launched=true;sim.event('ikaros-projectile-create',{id:e.id,projectileId:p.id,skillId:p.skill.id,nonce:p.nonce});}
    const old=pos(p),move=Math.min(dist(p,p.endpoint),p.speed*Math.max(0,sim.time-p.lastAt));p.lastAt=sim.time;p.x+=p.direction.x*move;p.z+=p.direction.z*move;
    const candidates=[...sim.entities.values()].filter(t=>sim.enemies(e,t)&&t.hp>0&&!p.hit.has(t)).map(t=>sweep(old,p,t,p.kind==='Q'?.7:1)).filter(Boolean).sort((a,b)=>a.k-b.k||a.t.id-b.t.id)
      .map(({t,k})=>({t,k,life:t.reviveCount}));
    for(const {t,k,life}of candidates){if(!current(sim,e,p.ownerLife))break;if(!current(sim,t,life)||!sim.enemies(e,t))continue;p.hit.set(t,life);
      const raw=p.kind==='Q'?30*p.level+.7*total(e):100+75*(p.level-1)+.7*bonus(e);hit(sim,e,t,raw*(p.kind==='Q'&&t.kind!=='hero'?1.5:1),p.kind==='Q'?3584:t.kind==='hero'?3589:3580,p.level,old,{equipmentProcs:true});
      if(!current(sim,e,p.ownerLife))break;if(t.kind==='hero'){
        if(p.kind==='Q'){for(let n=1;n<=4;n++)s.groups.push({target:t,targetLife:life,ownerLife:p.ownerLife,rank:p.level,at:sim.time+n*.15,number:n,origin:pos(e),cast:p.nonce});}
        else {const center={x:old.x+(p.x-old.x)*k,z:old.z+(p.z-old.z)*k};if(current(sim,t,life)&&t.hp>0){const r=record(sim,e,t);r.vulnerability=[20,25,30][p.level-1];r.vulnerabilityUntil=sim.time+4;r.rank=p.level;sim.control(t.id,.5,e);}
          if(current(sim,e,p.ownerLife)){let id=sim.nextId++;while(sim.entities.has(id))id=sim.nextId++;const explosion={id,kind:'explosion',owner:e,ownerLife:p.ownerLife,world:sim,level:p.level,...center,createdAt:sim.time,expiresAt:sim.time+4,nextPulseAt:sim.time+.5,pulses:0,ended:false};s.explosions.set(id,explosion);s.nativeActors.set(id,explosion);sim.event('ikaros-explosion-create',{id:e.id,projectileId:id,skillId:3590});}}
        p.x=old.x+(p.x-old.x)*k;p.z=old.z+(p.z-old.z)*k;stopProjectile(sim,e,s,p,'first-hero');break;}}
    if(!p.ended&&dist(p,p.endpoint)<=EPS)stopProjectile(sim,e,s,p,'range');}
  function tickGroups(sim,e,s){const due=s.groups.filter(g=>g.at<=sim.time+EPS);s.groups=s.groups.filter(g=>g.at>sim.time+EPS);for(const g of due){if(!current(sim,e,g.ownerLife)||!current(sim,g.target,g.targetLife)||!sim.enemies(e,g.target))continue;
    hit(sim,e,g.target,5+5*g.rank+.2*bonus(e),3598,g.rank,g.origin);if(!current(sim,e,g.ownerLife)||!current(sim,g.target,g.targetLife)||g.target.hp<=0)continue;
    if(sim.random()<.7)addMark(sim,e,g.target);else sim.control(g.target.id,.2,e);sim.event('ikaros-q-group',{id:e.id,targetId:g.target.id,number:g.number,cast:g.cast});}}
  function endExplosion(sim,e,s,p,reason){if(p.ended)return;p.ended=true;p.endedAt=sim.time;p.endReason=reason;s.explosions.delete(p.id);sim.event('ikaros-projectile-end',{id:e.id,projectileId:p.id,reason});}
  function tickExplosions(sim,e,s){for(const p of [...s.explosions.values()]){if(!current(sim,e,p.ownerLife)||sim.entities.has(p.id)){endExplosion(sim,e,s,p,'owner-life-or-id');continue;}
    while(current(sim,e,p.ownerLife)&&!p.ended&&p.nextPulseAt<=Math.min(sim.time,p.expiresAt)+EPS){const targets=[...sim.entities.values()].filter(t=>sim.enemies(e,t)&&dist(p,t)<=6.5+(t.bodyRadius||0)+EPS).map(t=>({t,life:t.reviveCount})).sort((a,b)=>a.t.id-b.t.id);
      for(const {t,life}of targets)if(current(sim,e,p.ownerLife)&&current(sim,t,life))hit(sim,e,t,15+10*p.level+.35*bonus(e),3590,p.level,pos(p));
      p.pulses++;p.nextPulseAt+=.5;}if(sim.time>=p.expiresAt-EPS)endExplosion(sim,e,s,p,'expired');}}
  function clear(sim,e,reason){const s=states.get(e);if(!s||s.world!==sim)return;for(const p of [...s.projectiles.values()])stopProjectile(sim,e,s,p,reason);for(const p of [...s.explosions.values()])endExplosion(sim,e,s,p,reason);
    for(const [t,r]of [...s.effects])removeRecord(s,t,r);s.groups=[];s.wingsUntil=0;s.wingsActive=false;s.empowerUntil=0;s.shield=null;s.count=0;s.decayAt=null;s.life=e.reviveCount;s.lastCombatAt=sim.time;
    if(s.glide){s.glide=null;if(sim.entities.get(e.id)===e)sim.stopMotion(e);}if(sim.entities.get(e.id)===e)refresh(sim,e);}
  function tick(sim,e,step){for(const r of [...e.ikarosSources?.values()||[]])if(r.world===sim&&states.has(r.owner)&&!validRecord(sim,r)){
      const ownerState=states.get(r.owner);if(sim.entities.get(r.owner.id)!==r.owner){clear(sim,r.owner,'replaced');ownerState.closed=true;}else removeRecord(ownerState,e,r);}
    const s=state(sim,e);if(!s||s.closed||sim.heroes.closed)return;if(s.life!==e.reviveCount){clear(sim,e,'new-life');return;}
    if(s.wingsActive&&s.wingsUntil<=sim.time+EPS){s.wingsActive=false;refresh(sim,e);}if(s.empowerUntil<=sim.time+EPS)s.empowerUntil=0;
    if(s.glide){const g=s.glide;if(e.controlUntil>sim.time){s.glide=null;sim.stopMotion(e);refresh(sim,e);}else {sim.stepToward(e,g.goal,step);if(dist(e,g.goal)<=EPS||!e.navigation?.length){s.glide=null;sim.stopMotion(e);refresh(sim,e);}}}
    if(s.shield?.triggered&&s.shield.until<=sim.time+EPS)s.shield=null;
    if(s.shield&&!s.shield.triggered&&sim.time>=Math.max(s.lastCombatAt,e.lastCombatAt??-Infinity,s.shield.grantedAt)+6-EPS){s.shield=null;s.count=6;s.decayAt=sim.time+5;}
    if(!s.shield&&s.count>0&&s.decayAt!==null)while(s.count>0&&sim.time>=s.decayAt-EPS){s.count--;s.decayAt+=5;}
    for(const [t,r]of [...s.effects]){if(!validRecord(sim,r)){removeRecord(s,t,r);continue;}if(r.markUntil<=sim.time+EPS)r.marks=0;if(r.vulnerabilityUntil<=sim.time+EPS)r.vulnerability=0;if(!r.marks&&!r.vulnerability)removeRecord(s,t,r);}
    for(const p of [...s.projectiles.values()])tickProjectile(sim,e,s,p);tickGroups(sim,e,s);tickExplosions(sim,e,s);}
  function learn(sim,e,slot,l){const s=state(sim,e);if(!s||!['Q','W','E','R'].includes(slot)||!Number.isInteger(l)||l<0||l>(slot==='R'?3:5))return fail('invalid-learning');s.levels[slot]=l;syncSlots(e,s);return {ok:true,skill:e.skills[slot]||null};}
  const definition={heroId:138,name:'ikaros-current-ui-base',install,isInstalled:e=>states.has(e),affects:e=>!!e.ikarosSources?.size,ownsSkill:(_s,_e,v)=>IDS.has(Number(typeof v==='object'?v?.id:v)),
    resolveSkill,validateCast,applyCast,tick,onAttackStart,onBasicHit,modifyIncomingDamage,beforeDamage,
    modifiers(sim,e){const s=state(sim,e);if(!s||!current(sim,e,s.life))return {};const m=s.glide?{moveSpeedOverride:13}:{};if(s.wingsUntil<=sim.time+EPS)return m;
      const tier=(e.level||1)>=16?3:(e.level||1)>=11?2:(e.level||1)>=6?1:0;return {...m,attackSpeed:[16,24,32,40][tier],speedPercent:18};},
    canAct:(sim,e,a)=>!state(sim,e)?.glide,onMoveOrder:(sim,e)=>state(sim,e)?.glide?fail('gliding'):undefined,
    onControl(sim,e){const s=state(sim,e);if(s?.glide){s.glide=null;sim.stopMotion(e);refresh(sim,e);}},
    onDamage(sim,e,t,ev){if(ev.sourceCurrent===false||ev.attackerLife!==undefined&&ev.attackerLife!==e.reviveCount||ev.targetLife!==undefined&&ev.targetLife!==t.reviveCount)return;
      if(!ev.basic&&!ev.equipmentProc&&[3580,3584,3585,3589,3590,3591,3594,3598].includes(ev.skillId)&&t.kind==='hero'&&ev.amount>0)wings(sim,e);},
    onRespawn(sim,e){clear(sim,e,'respawn');},onLeave(sim,e){clear(sim,e,'leave');const s=state(sim,e);if(s)s.closed=true;},
    world:{onDeath(sim,_killer,t,context){const life=context?.targetLife??t.reviveCount;
      if(context?.targetCurrent===false||sim.entities.get(t.id)!==t||t.reviveCount!==life)return;
      if(state(sim,t))clear(sim,t,'death');for(const r of [...t.ikarosSources?.values()||[]]){
        if(r.target!==t||r.targetLife!==life||context?.recipientCurrent&&!context.recipientCurrent(r.owner))continue;
        const s=state(sim,r.owner);if(s&&r.ownerLife===r.owner.reviveCount)removeRecord(s,t,r);}}},
    native:{castPosition:(ev,e)=>ev.castOrigin||e,sync:(sim,e,opts)=>require('./ikaros-native').sync(sim,e,opts),beforeCast:(sim,e)=>require('./ikaros-native').sync(sim,e),
      isProjectileEvent:(_e,ev)=>['ikaros-projectile-create','ikaros-explosion-create'].includes(ev.type),projectile:(e,ev,id)=>require('./ikaros-projectile-native').launch(e,ev,id),
      tickProjectile:(s,time)=>require('./ikaros-projectile-native').tick(s,time),finishProjectile:s=>require('./ikaros-projectile-native').finish(s),
      damagePresentation:(_e,ev)=>ev.skillLevel?{level:ev.skillLevel}:undefined}};
  return {definition,state:e=>states.get(e)||null,learn,metadata,policy:POLICY,validRecord};
}
module.exports={POLICY,metadata,createDefinition};
