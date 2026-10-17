'use strict';
const projectiles=require('./black-rock-projectiles');

// Normal-client Data9 skill_skilllevel rows, hero 101. Attributes 30/127 are
// total/bonus AD. R is physical in the current table; no BRS damage scales AP.
const rows=new Map(require('../data/current-client/skill_skilllevel.json')
  .filter(row=>row[23]===101||row[1]===20183).map(row=>[`${row[1]}:${row[2]}`,row]));
const ids=new Set([2839,2840,2843,2940,2848,2849,2850,2854,2837,2838,2856,20183,20185,20186,20187,20188,20189]);
const shooterIds=new Set([20183,20185,20186,20187,20188,20189]),classicIds=new Set([2839,2840]);
const slots={2839:'QOff',2840:'QClassic',2843:'Q',2940:'QPierce',2848:'W',2849:'W2',2850:'E',2854:'R',2837:'R2',2838:'R3',
  2856:'Passive',20183:'TalentSwitch',20185:'ShooterOn',20186:'ShooterOff',20187:'ShooterPierce',20188:'ShooterEnergy',20189:'ShooterSwitch'};
const RULES=Object.freeze({heartCap:5,allyRange:12,enemyCastRange:12,eExplosionRadius:2,
  qPierceWidth:.4,rRecastWindow:4,wRecastWindow:4,meleeRange:2,eLockDuration:1.5,eArmorDuration:3,eCooldownProc:10});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const active=(until,now)=>until>now+1e-9;
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const owns=id=>ids.has(Number(typeof id==='object'?id?.id:id));
const notify=(sim,e,effect,data={})=>sim.event('passive',{id:e.id,effect:`black-rock:${effect}`,...data});
const refresh=(sim,e)=>sim.updateBuffs?.(e);
const bonusAD=e=>Math.max(0,e.attributes?.[127]??e.bonusAttackDamage??0);
const totalAD=e=>Math.max(0,e.attributes?.[30]??e.attackDamage??0);
const allies=(sim,e)=>[...sim.entities.values()].filter(other=>other.id!==e.id&&other.alive&&
  other.kind==='hero'&&other.team===e.team&&distance(other,e)<=RULES.allyRange);
function enemy(sim,e,t){
  // Collision and damage must use the same target eligibility. In particular
  // an entity rejected by the world cannot become E's first explosion center.
  if(typeof sim.enemies==='function')return sim.enemies(e,t);
  const hidden=t.effectUntargetable||t.blackRock&&active(t.blackRock.untargetableUntil,sim.time);
  return t.alive&&t.id!==e.id&&t.team!==e.team&&t.targetable!==false&&
    (!hidden||active(e.trueSightUntil||0,sim.time));
}
function levelFor(e,id){const l=e.blackRock?.levels||{};return [2854,2837,2838].includes(id)?l.R||1
  :[2848,2849].includes(id)?l.W||1:[2850,20189,20188].includes(id)?l.E||1:l.Q||1;}
function resolveSkill(e,value){
  const id=Number(typeof value==='object'?value?.id:value);if(!owns(id))return null;
  const requestedLevel=levelFor(e,id),row=rows.get(`${id}:${requestedLevel}`)||rows.get(`${id}:1`);
  if(!row)return null;
  const level=row[2];
  const type=[2839,2840,2843,2848,2849,20183,20185,20186,20189].includes(id)?'buff':'line';
  const skill={id,slot:slots[id],level,name:row[37],type,blackRock:true,cooldownKey:[20187,20188].includes(id)?'ShooterShot':id===2840?'Q':slots[id],mana:row[6]||0,
    cooldown:(row[18]||0)/1000,range:row[8]||0,width:row[58]||0,
    prepare:(row[74]||0)/1000,damageType:'physical'};
  if(id===2849)skill.cooldown=0; // Full description explicitly says no cooldown.
  if(id===2940){skill.range=(e.baseRange||5.5)+(.1+level*.1);skill.width=RULES.qPierceWidth;}
  if(id===20185)skill.cooldown=1;
  if(id===20189)skill.cooldown=.5;
  if([20187,20188].includes(id)){
    skill.range=id===20187?(6.8+levelFor(e,20185)*.2):10;
    skill.width=id===20187?RULES.qPierceWidth:.8;
    skill.mana=id===20187?20:30;
  }
  return skill;
}
function skills(e){return Object.fromEntries([...ids].filter(id=>id!==2856&&
  (!shooterIds.has(id)||e.blackRock?.shooterModeAvailable===true)&&
  (!classicIds.has(id)||e.blackRock?.classicModeAvailable===true))
  .map(id=>[slots[id],resolveSkill(e,id)]).filter(([,skill])=>skill));}
function install(sim,e,{levels={Q:5,W:5,E:5,R:3},hearts,shooterModeAvailable=false,classicModeAvailable=false}={}){
  if(e.heroId!==101)return false;
  if(typeof shooterModeAvailable!=='boolean'||typeof classicModeAvailable!=='boolean')throw Error('Invalid BRS talent policy');
  if(!e.blackRock){
    const lv={Q:clamp(levels.Q??5,0,5),W:clamp(levels.W??5,0,5),E:clamp(levels.E??5,0,5),R:clamp(levels.R??3,0,3)};
    e.blackRock={levels:lv,hearts:clamp(hearts??Math.max(0,(e.level||1)-1)+lv.W,0,5),
      lastLevel:e.level||1,lastWLevel:lv.W,shooterModeAvailable,classicModeAvailable,modeChoice:'machine-gun',
      locks:new Map(),pending:[],inFlight:[],r:null,rStacks:0,rSpeedUntil:0,shooter:null,
      qUntil:0,classicGun:false,classicSpeedUntil:0,blueUntil:0,untargetableUntil:0,forcedUntil:0,forcedRemaining:0,
      castingUntil:0,wSecondReady:false,wSecondUntil:0,penUntil:0,penAmount:0,nextCooldownProc:0};
  }
  e.skills={...e.skills,...skills(e)};
  if(e.blackRock.modeChoice==='shooter')e.skills.Q={...resolveSkill(e,20185),slot:'Q'};
  return true;
}
function gainHeart(sim,e,count=1,reason='ally-event'){
  const s=e.blackRock;if(!s)return;
  const before=s.hearts;s.hearts=clamp(s.hearts+count,0,RULES.heartCap);
  if(s.hearts!==before){notify(sim,e,'hearts',{hearts:s.hearts,reason});refresh(sim,e);}
}
function modifiers(sim,e){
  const now=sim.time,s=e.blackRock;
  let armorReduction=0;
  for(const debuff of e.blackRockDebuffs?.values()||[])if(active(debuff.until,now)&&(debuff.life===undefined||debuff.life===e.reviveCount))
    armorReduction+=debuff.stacks*debuff.amount;
  if(!s||!e.alive)return {armorReduction};
  const activeQ=s.classicGun||active(s.qUntil,now),blue=active(s.blueUntil,now),shoot=s.shooter;
  const defense=shoot?(5+s.levels.Q*5+bonusAD(e)*.08):0;
  return {attackSpeed:s.modeChoice==='machine-gun'?(s.levels.Q?5+s.levels.Q*3:0)+
      (s.classicGun?(active(s.classicSpeedUntil,now)?s.levels.Q*7:0):(activeQ?s.levels.Q*5:0)):0,
    attackPercent:s.hearts*2,critChance:s.hearts,
    rangeBonus:activeQ?(.1+s.levels.Q*.1):0,
    speedPercent:(blue?15+s.levels.W*5:0)+(active(s.rSpeedUntil,now)?s.rStacks*10:0),
    damageReduction:blue?10:0,flatPen:active(s.penUntil,now)?s.penAmount:0,
    healthRegen:allies(sim,e).length*5,armor:defense,magicResistance:defense,armorReduction,
    guaranteedCrit:active(s.forcedUntil,now)&&s.forcedRemaining>0&&!shoot,
    undodgeable:activeQ||!!shoot,rooted:!!shoot,untargetable:active(s.untargetableUntil,now),
    aerialVision:active(s.forcedUntil,now)&&s.forcedRemaining>0};
}
function direction(e,aim){
  let dx=Number(aim.dirX)||0,dz=Number(aim.dirZ)||0;
  if(Math.hypot(dx,dz)<1e-9&&Number.isFinite(aim.x)&&Number.isFinite(aim.z)){dx=aim.x-e.x;dz=aim.z-e.z;}
  const length=Math.hypot(dx,dz);return length>1e-9?{x:dx/length,z:dz/length}:null;
}
function resolveCastAim(e,skill,aim){
  // Current E/R use operator 0. That sender can retain the previous facing
  // in dirX/Z while x/z carries the selected world point. Resolve a distinct
  // point from the authoritative caster position; the original self-point
  // sender still needs its explicit direction. Ignore sub-centimetre roundoff
  // at the self point (native world positions are quantized to centimetres).
  if(!aim.nativePoint||![2850,2854,2837,2838].includes(skill.id))return aim;
  const dx=aim.x-e.x,dz=aim.z-e.z,length=Math.hypot(dx,dz);
  if(Number.isFinite(length)&&length>.01)return {...aim,dirX:dx/length,dirZ:dz/length};
  const facingLength=Math.hypot(aim.dirX,aim.dirZ);
  return Number.isFinite(facingLength)&&facingLength>1e-9?
    {...aim,dirX:aim.dirX/facingLength,dirZ:aim.dirZ/facingLength}:null;
}
function rayTargets(sim,e,aim,range,width){
  const dir=direction(e,aim);if(!dir)return [];
  return [...sim.entities.values()].filter(target=>{
    if(!enemy(sim,e,target))return false;
    const dx=target.x-e.x,dz=target.z-e.z,along=dx*dir.x+dz*dir.z;
    return along>=0&&along<=range+(target.bodyRadius||0)&&
      Math.abs(dx*dir.z-dz*dir.x)<=width+(target.bodyRadius||0);
  }).sort((a,b)=>distance(e,a)-distance(e,b)||a.id-b.id);
}
function validateCast(sim,e,value,aim={}){
  const s=e?.blackRock,skill=resolveSkill(e,value);
  if(!s||!skill||!e.alive)return {ok:false,reason:'unknown-skill'};
  const id=skill.id,now=sim.time;
  if((aim.x!==undefined||aim.z!==undefined)&&![aim.x,aim.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35))
    return {ok:false,reason:'invalid-aim'};
  if(['dirX','dirZ'].some(key=>aim[key]!==undefined&&(!Number.isFinite(aim[key])||Math.abs(aim[key])>655.35)))
    return {ok:false,reason:'invalid-direction'};
  if(id===2856)return {ok:false,reason:'passive-skill'};
  // Only the host can authorize talent/variant forms. In particular 20183
  // must not grant its own shooter permission when received from a client.
  if(shooterIds.has(id)&&s.shooterModeAvailable!==true||classicIds.has(id)&&s.classicModeAvailable!==true)
    return {ok:false,reason:'talent-unavailable'};
  if(e.controlUntil>now)return {ok:false,reason:'controlled'};
  if(active(s.castingUntil,now))return {ok:false,reason:'casting'};
  if(id===2940&&!s.classicGun&&!active(s.qUntil,now))return {ok:false,reason:'machine-gun-inactive'};
  if(id===2940&&s.classicGun&&e.mp<15)return {ok:false,reason:'mana'};
  if(id===2839&&!s.classicGun&&!active(s.qUntil,now))return {ok:false,reason:'machine-gun-inactive'};
  if(id===2849&&(!s.wSecondReady||!active(s.wSecondUntil??s.blueUntil,now)||!(s.hearts>0)))return {ok:false,reason:s.hearts>0?'second-stage-inactive':'no-hearts'};
  if([20186,20187,20188,20189].includes(id)&&!s.shooter)return {ok:false,reason:'shooter-inactive'};
  if((id===20187&&s.shooter?.bullet==='energy')||(id===20188&&s.shooter?.bullet!=='energy'))return {ok:false,reason:'wrong-bullet'};
  if(id===20185&&s.shooter)return {ok:false,reason:'shooter-already-active'};
  if([2837,2838].includes(id)&&(!s.r||!active(s.r.expires,now)||s.r.next!==(id===2837?2:3)))return {ok:false,reason:'ultimate-stage'};
  const cooldownKey=[20187,20188].includes(id)?'ShooterShot':id===2840?'Q':skill.slot;
  let cooldown=skill.cooldown,mana=skill.mana;
  if(id===2940)cooldown=Math.max(.3,2.5-Math.floor(Math.max(0,(e.clientAttackSpeed||100)-100)/25)*.1);
  if([20187,20188].includes(id))cooldown=(1.5-s.levels.Q*.1)*(1-clamp(e.attributes?.[100]||0,0,100)/100);
  else if(![2849,2837,2838,20186,20189,2940].includes(id))cooldown*=1-clamp(e.attributes?.[100]||0,0,100)/100;
  if((e.cooldowns?.[cooldownKey]||0)>now+1e-9)return {ok:false,reason:'cooldown'};
  if(e.mp<mana)return {ok:false,reason:'mana'};
  const resolved=skill.type==='line'?resolveCastAim(e,skill,aim):aim;
  if(skill.type==='line'&&(!resolved||!direction(e,resolved)))return {ok:false,reason:'direction'};
  return {ok:true,skill,cooldownKey,cooldown,mana};
}
function empowerment(sim,e,{basic=false}={}){
  const s=e.blackRock;if(!s)return {forceCritical:false,undodgeable:false};
  s.untargetableUntil=0;
  const enabled=active(s.forcedUntil,sim.time)&&s.forcedRemaining>0;
  if(enabled){s.forcedRemaining--;notify(sim,e,'empowered-attack',{remaining:s.forcedRemaining});}
  return {forceCritical:enabled&&basic,undodgeable:s.classicGun||active(s.qUntil,sim.time)||!!s.shooter,
    brsEmpowered:enabled,damageMultiplier:enabled&&!basic?1.5:1};
}
function onAttackStart(sim,e,target){
  const s=e.blackRock;if(!s)return {forceCritical:false,undodgeable:false};
  if(s.classicGun){
    if(e.mp<15){s.classicGun=false;s.classicSpeedUntil=0;s.qUntil=0;}
    else{e.mp-=15;s.classicSpeedUntil=sim.time+4;sim.event('hero-resource',{id:e.id,hp:e.hp,mp:e.mp});}
  }
  const result=empowerment(sim,e,{basic:true});
  // Native Q changes the ordinary ranged attack to 2842. Its piercing must
  // also apply to those normal attacks, not only to manually cast skill 2940.
  result.brsPiercing=basicAttackSkill(sim,e,target)===2842;
  result.brsPierceWidth=RULES.qPierceWidth;
  refresh(sim,e);return result;
}
function basicAttackSkill(sim,e,target){
  if(!e?.blackRock)return e?.attackSkillId;
  // Current 2857 has range=2, zero missile speed and the sword attack pair;
  // 2841/2842 both have range=5.5, speed=27 and 200ms windup. Select only
  // the strike animation/projectile profile; the hero's pursuit range stays.
  if(target&&distance(e,target)<=RULES.meleeRange)return 2857;
  return e.blackRock.classicGun||active(e.blackRock.qUntil,sim.time)?2842:2841;
}
function impactE(sim,e,s,flight){
  const currentSource=()=>!sim.heroes?.closed&&e.alive&&sim.entities.get(e.id)===e&&
    e.reviveCount===flight.life&&e.blackRock===s;
  const {first,firstLife,impact,damage,ratio}=flight;
  if(!currentSource()||sim.entities.get(first.id)!==first||first.reviveCount!==firstLife||!enemy(sim,e,first)||
    distance(impact,first)>RULES.eExplosionRadius+(first.bodyRadius||0))return;
  // Keep the existing launch-selected collision point. Recheck occupants at
  // arrival, so leaving the explosion area does not cause a delayed remote hit.
  const targets=[...sim.entities.values()].filter(target=>enemy(sim,e,target)&&
    distance(impact,target)<=RULES.eExplosionRadius+(target.bodyRadius||0))
    .map(target=>({target,life:target.reviveCount}));
  for(const {target,life}of targets){
    if(!currentSource())break;
    if(sim.entities.get(target.id)!==target||target.reviveCount!==life||!enemy(sim,e,target))continue;
    sim.damage(e,target,damage,2850,'physical',undefined,impact,{adRatio:ratio,apRatio:0,skillLevel:flight.level});
  }
}
function fire(sim,e,skill,aim){
  const s=e.blackRock,id=skill.id,lv=skill.level;
  const life=e.reviveCount,currentSource=()=>!sim.heroes?.closed&&e.alive&&sim.entities.get(e.id)===e&&e.reviveCount===life&&e.blackRock===s;
  const damageBatch=(candidates,apply)=>{const accepted=[];for(const {target,life:targetLife}of candidates.map(target=>({target,life:target.reviveCount}))){
    if(!currentSource())break;if(sim.entities.get(target.id)!==target||target.reviveCount!==targetLife||!enemy(sim,e,target))continue;
    apply(target);accepted.push(target);}return accepted;};
  const ranged=[2940,20187,20188,2850,2854,2837,2838].includes(id);
  if(!ranged)return [];
  let targets=rayTargets(sim,e,aim,skill.range,skill.width||RULES.qPierceWidth);
  if([2940,20187,2850,2854,2837,2838].includes(id)){
    const origin={x:e.x,z:e.z},dir=direction(e,aim),first=id===2850?targets[0]:undefined;
    // The collision's center may lie to the side of the ray. End the missile
    // on the ray rather than bending it toward that center.
    const along=first?Math.max(0,Math.min(skill.range,(first.x-e.x)*dir.x+(first.z-e.z)*dir.z)):0;
    const endpoint=first?{x:e.x+dir.x*along,z:e.z+dir.z*along}:undefined;
    sim.event('brs-projectile',{id:e.id,ownerLife:life,skill,aim:{...aim,origin,endpoint},origin,endpoint,
      targetId:id===2850?targets[0]?.id:undefined});
    if(id===2850){
      if(first){
        const ratio=1+.5*clamp(distance(origin,first)/skill.range,0,1);
        // Simulation and native presentation share the movement-word speed
        // and arrival deadline. The tail-byte parameter is not travel speed.
        s.inFlight.push({at:sim.time+projectiles.travelDuration(id,origin,endpoint),life,
          first,firstLife:first.reviveCount,impact:{x:first.x,z:first.z},
          damage:(20+skill.level*35+bonusAD(e))*ratio,ratio,level:skill.level});
      }
      return [];
    }
  }
  if(id===20188){
    const first=targets[0];if(!first)return [];
    s.penUntil=sim.time+4;s.penAmount=1+s.levels.E*3;refresh(sim,e);
    targets=[...sim.entities.values()].filter(target=>enemy(sim,e,target)&&distance(first,target)<=RULES.eExplosionRadius+(target.bodyRadius||0));
    const ratio=1+.5*clamp(distance(e,first)/skill.range,0,1);
    const base=20+levelFor(e,2850)*35+bonusAD(e);
    const powered=empowerment(sim,e).damageMultiplier;
    targets=damageBatch(targets,t=>sim.damage(e,t,base*ratio*powered,id,'physical',undefined,undefined,{adRatio:ratio*powered,apRatio:0}));
  }else if(id===20187){
    const power=empowerment(sim,e).damageMultiplier;
    const base=(s.levels.Q===5?180:40+s.levels.Q*30)+bonusAD(e)*1.05;
    targets=damageBatch(targets,t=>sim.damage(e,t,base*(1.5-.5*clamp(distance(e,t)/skill.range,0,1))*power,id,'physical',undefined,undefined,{adRatio:1.05*(1.5-.5*clamp(distance(e,t)/skill.range,0,1))*power,apRatio:0}));
  }else if(id===2940){
    const options=onAttackStart(sim,e,targets[0]);
    targets=damageBatch(targets,t=>sim.damage(e,t,totalAD(e),id,'physical',undefined,undefined,{...options,basic:true,undodgeable:true}));
  }else{
    const stage=id===2854?1:id===2837?2:3;
    const value=(10+lv*40+totalAD(e)*.4)*(stage===1?1:stage===2?2:4)*(1+.02*(s.hearts+allies(sim,e).length));
    targets=damageBatch(targets,t=>sim.damage(e,t,value,id,'physical',undefined,undefined,{adRatio:.4*(stage===1?1:stage===2?2:4)*(1+.02*(s.hearts+allies(sim,e).length)),apRatio:0}));
    if(currentSource()&&targets.length){s.rStacks=Math.min(10,(active(s.rSpeedUntil,sim.time)?s.rStacks:0)+targets.length);s.rSpeedUntil=sim.time+3;refresh(sim,e);}
  }
  return targets.map(target=>target.id);
}
function applyCast(sim,e,value,aim={}){
  const plan=validateCast(sim,e,value,aim);if(!plan.ok)return plan;
  const {skill,mana,cooldown,cooldownKey}=plan,id=skill.id,s=e.blackRock;
  aim=resolveCastAim(e,skill,aim);
  const castOrigin={x:e.x,z:e.z};
  sim.cancelChannel?.(e,'cast');sim.cancelWindup?.(e);e.mp-=mana;
  if(skill.prepare>0)sim.stopMotion?.(e);
  e.cooldowns||={};e.cooldowns[cooldownKey]=sim.time+cooldown;
  if(skill.type==='line')sim.event('skill-prefire',{id:e.id,skill,aim:{...aim},direction:direction(e,aim)});
  const castAim=direction(e,aim)?{x:Number.isFinite(aim.x)?aim.x:e.x+aim.dirX,z:Number.isFinite(aim.z)?aim.z:e.z+aim.dirZ}:undefined;
  sim.event('cast',{id:e.id,slot:skill.slot,skillId:id,skill,mp:e.mp,readyAt:e.cooldowns[cooldownKey],aim:castAim,castOrigin});
  if(id===2843){s.modeChoice='machine-gun';s.classicGun=false;s.shooter=null;s.qUntil=sim.time+3.5+s.levels.Q*.5;}
  if(id===2840){s.modeChoice='machine-gun';s.shooter=null;s.qUntil=0;s.classicGun=true;s.classicSpeedUntil=sim.time+4;}
  if(id===2839){s.qUntil=0;s.classicGun=false;s.classicSpeedUntil=0;}
  if(id===2848){s.blueUntil=sim.time+2;s.untargetableUntil=sim.time+2;s.wSecondReady=true;s.wSecondUntil=sim.time+RULES.wRecastWindow;}
  if(id===2849){s.hearts--;s.untargetableUntil=0;s.forcedRemaining=3;s.forcedUntil=sim.time+7;s.wSecondReady=false;}
  if(id===2850){s.penUntil=sim.time+4;s.penAmount=1+s.levels.E*3;}
  if(id===2854)s.r={next:2,expires:sim.time+RULES.rRecastWindow};
  if(id===2837){s.r.next=3;s.r.expires=sim.time+RULES.rRecastWindow;}
  if(id===2838)s.r=null;
  if(id===20183){s.modeChoice=s.modeChoice==='shooter'?'machine-gun':'shooter';
    s.qUntil=0;s.classicGun=false;s.shooter=null;
    e.skills.Q={...resolveSkill(e,s.modeChoice==='shooter'?20185:2843),slot:'Q'};}
  if(id===20185){s.modeChoice='shooter';s.qUntil=0;s.classicGun=false;s.shooter={bullet:'pierce',aim:{...aim},nextAt:sim.time};
    sim.stopMotion?.(e);e.path=[];e.targetId=null;}
  if(id===20186)s.shooter=null;
  if(id===20189)s.shooter.bullet=s.shooter.bullet==='pierce'?'energy':'pierce';
  if([20187,20188].includes(id)){s.shooter.aim={...aim};s.shooter.nextAt=sim.time+Math.max(.05,cooldown);}
  refresh(sim,e);
  const immediate=skill.prepare<=0;
  const targets=immediate?fire(sim,e,skill,aim):[];
  if(!immediate){s.castingUntil=sim.time+skill.prepare;
    s.pending.push({skill,aim:{...aim},at:s.castingUntil,life:e.reviveCount});}
  return {ok:true,targets,skillId:id};
}
function onEnemyCast(sim,caster,skill){
  if(!caster.alive||caster.kind!=='hero'||[2841,2842,2857].includes(skill?.id))return;
  for(const e of sim.entities.values()){
    const s=e.blackRock;if(!s||!e.alive||caster.team===e.team||distance(e,caster)>RULES.enemyCastRange||!s.levels.E)continue;
    s.locks.set(caster.id,sim.time+RULES.eLockDuration);notify(sim,e,'enemy-locked',{target:caster.id,expires:sim.time+RULES.eLockDuration});
  }
}
function onBasicHit(sim,e,target){
  const s=e.blackRock;if(!s||target.kind!=='hero'||!active(s.locks.get(target.id),sim.time))return;
  let stacks=0;
  if(!require('./summoner-effects').cleanseActive(sim,target)){
    target.blackRockDebuffs||=new Map();
    const old=target.blackRockDebuffs.get(e.id);stacks=Math.min(3,(active(old?.until,sim.time)&&(old?.life===undefined||old.life===target.reviveCount)?old.stacks:0)+1);
    target.blackRockDebuffs.set(e.id,{stacks,amount:s.levels.E*2,until:sim.time+RULES.eArmorDuration,life:target.reviveCount});refresh(sim,target);
  }
  if(sim.time>=s.nextCooldownProc){
    s.nextCooldownProc=sim.time+RULES.eCooldownProc;
    for(const slot of ['Q','W','E','R'])if((e.cooldowns[slot]||0)>sim.time){
      e.cooldowns[slot]=Math.max(sim.time,e.cooldowns[slot]-2);
      const id=Object.keys(slots).map(Number).find(id=>slots[id]===slot);
      sim.event('skill-cooldown',{id:e.id,slot,skillId:id,skill:resolveSkill(e,id),readyAt:e.cooldowns[slot]});
    }
  }
  if(stacks)notify(sim,e,'armor-shred',{target:target.id,stacks,amount:stacks*s.levels.E*2});
}
function resetLifeState(e){const s=e.blackRock;if(!s)return;s.qUntil=0;s.classicGun=false;s.classicSpeedUntil=0;s.blueUntil=0;s.wSecondReady=false;s.wSecondUntil=0;s.untargetableUntil=0;s.forcedRemaining=0;s.forcedUntil=0;
  s.shooter=null;s.r=null;s.pending=[];s.inFlight=[];s.castingUntil=0;s.rStacks=0;s.rSpeedUntil=0;s.penUntil=0;s.locks.clear();e.blackRockDebuffs?.clear();}
function onRespawn(sim,e){resetLifeState(e);refresh(sim,e);}
function onDeath(sim,killer,victim,context){
  if(context?.targetCurrent!==false)victim.blackRockDebuffs?.clear();
  if(victim.kind!=='hero')return;
  for(const e of sim.entities.values()){
    const s=e.blackRock;if(!s)continue;
    if(context?.recipientCurrent?.(e)===false)continue;
    if(e.id===victim.id&&context?.targetCurrent===false)continue;
    if(e.id===victim.id){resetLifeState(e);continue;}
    if(victim.team===e.team)gainHeart(sim,e,1,'ally-death');
    if(context?.recipientCurrent?.(e)!==false&&killer?.kind==='hero'&&killer.team===e.team&&killer.id!==e.id)gainHeart(sim,e,1,'ally-kill');
  }
}
function onControl(sim,e){
  const s=e.blackRock;if(!s?.pending.length)return false;
  if(s.pending.some(item=>[2854,2837,2838].includes(item.skill.id)))s.r=null;
  for(const item of s.pending)sim.event('cast-cancel',{id:e.id,slot:item.skill.slot,
    skillId:item.skill.id,skill:item.skill,aim:item.aim,reason:'control'});
  s.pending=[];s.castingUntil=0;return true;
}
function tick(sim,e,dt=0){
  if(e.blackRockDebuffs)for(const [id,buff]of e.blackRockDebuffs)if(!active(buff.until,sim.time)||buff.life!==undefined&&buff.life!==e.reviveCount)e.blackRockDebuffs.delete(id);
  const s=e.blackRock;if(!s||!e.alive)return;
  if(e.controlUntil>sim.time)onControl(sim,e);
  if((e.level||1)>s.lastLevel){gainHeart(sim,e,e.level-s.lastLevel,'level-up');s.lastLevel=e.level;}
  if(s.levels.W>s.lastWLevel){gainHeart(sim,e,s.levels.W-s.lastWLevel,'w-level-up');s.lastWLevel=s.levels.W;}
  if(s.r&&!active(s.r.expires,sim.time))s.r=null;
  if(!active(s.wSecondUntil??s.blueUntil,sim.time))s.wSecondReady=false;
  if(!active(s.forcedUntil,sim.time))s.forcedRemaining=0;
  for(const [id,until]of s.locks)if(!active(until,sim.time))s.locks.delete(id);
  const due=s.pending.filter(item=>item.at<=sim.time+1e-9);s.pending=s.pending.filter(item=>item.at>sim.time+1e-9);
  for(const item of due)if(item.life===e.reviveCount)fire(sim,e,item.skill,item.aim);
  const arrived=s.inFlight.filter(item=>item.at<=sim.time+1e-9);
  s.inFlight=s.inFlight.filter(item=>item.at>sim.time+1e-9);
  for(const flight of arrived)impactE(sim,e,s,flight);
  if(s.shooter&&sim.time+1e-9>=s.shooter.nextAt&&!(e.controlUntil>sim.time)){
    const id=s.shooter.bullet==='energy'?20188:20187,skill=resolveSkill(e,id),plan=validateCast(sim,e,id,s.shooter.aim);
    if(plan.ok){e.mp-=plan.mana;e.cooldowns[plan.cooldownKey]=sim.time+plan.cooldown;
      sim.event('cast',{id:e.id,slot:skill.slot,skillId:id,skill,mp:e.mp,readyAt:e.cooldowns[plan.cooldownKey],aim:{x:s.shooter.aim.x??e.x,z:s.shooter.aim.z??e.z}});
      const actionLife=e.reviveCount;
      fire(sim,e,skill,s.shooter.aim);
      sim.notifyCast?.(e,skill,{attackerLife:actionLife,slot:skill.slot});
      if(s.shooter)s.shooter.nextAt=Math.max(sim.time+.05,e.cooldowns[plan.cooldownKey]);
    }else if(plan.reason==='mana')s.shooter=null;
    else s.shooter.nextAt=Math.max(sim.time+.05,e.cooldowns.ShooterShot||0);
  }
}
function canAct(sim,e,action){
  const s=e.blackRock;
  return !s||!(['move','attack'].includes(action)&&(s.shooter||active(s.castingUntil,sim.time)));
}
module.exports={RULES,owns,skills,resolveSkill,install,modifiers,validateCast,applyCast,tick,
  onAttackStart,basicAttackSkill,onBasicHit,onEnemyCast,onDeath,onRespawn,onControl,gainHeart,canAct};
