'use strict';

// Q-only HeroRuntime adapter, deliberately absent from the default registry.
// Client description arithmetic is executable separately. Actual cast timing,
// raw damage and lifecycle decisions require a verified authority at admission.
const snapshot=require('./snapshot.json');
const qRows=new Map(snapshot.skillLevels.filter(r=>r.named.nSkillID===9453).map(r=>[r.named.nLevel,r.named]));
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const finitePoint=value=>value&&Number.isFinite(value.x)&&Number.isFinite(value.z);
const fail=reason=>({ok:false,reason});
const descriptions=new Map();
for(const [level,row]of qRows){
  const text=row.strSkillUI_SkillInfo.replace(/<color=[^>]+>/g,''),match=text.match(/造成(\d+)\(\+\{~(\d+)\*([\d.]+)\}\)法术伤害/);
  if(!match)throw Error('Q client description formula changed');
  descriptions.set(level,Object.freeze({base:Number(match[1]),attributeId:Number(match[2]),coefficient:Number(match[3]),sourceSkillId:9453,sourceLevel:level,formulaText:match[0]}));
}
function describeQ(level){
  const row=qRows.get(level);if(!row)return null;
  return {id:9453,slot:'Q',level,name:row.strSkillName,type:'target',mana:row.nCostMP,cooldown:row.nCDTime/1000,range:row.fRange,
    prepareRawMs:row.nPrepareTime,shakeRawMs:row.nSkillShakeTime,flyDelayRawMs:row.nFlyDelayTime,speedRaw:row.fSpeed,durationRawMs:row.nSkillDuration,
    action:row.strSkillAct,damageType:'magic',damageSkillCandidates:[9453,9454],descriptionFormula:descriptions.get(level),sourceHash:snapshot.sources.find(s=>s.table==='skill_skilllevel').sha256};
}
function calculateDisplayedDamage(level,attributes){
  const formula=descriptions.get(level);if(!formula)throw Error('Invalid Q level');
  const value=attributes?.[formula.attributeId];
  if(!Number.isFinite(value))throw Error('Q description attribute required');
  return {value:formula.base+value*formula.coefficient,formula,runtimeConfirmed:false,rounding:null,
    source:'installed client skill UI description',unknowns:['raw runtime formula/result-frame comparison','runtime attribute sampling instant','rounding/mitigation delegated to common damage host']};
}
function evidenceComplete(plan){return plan?.confirmed===true&&
  ['damage','damageSkill','contact','cooldown','targetKinds','lifecycle','passive'].every(key=>typeof plan.evidence?.[key]==='string'&&plan.evidence[key].trim().length>0)&&
  [9453,9454].includes(plan.damageSkillId)&&
  Number.isFinite(plan.rawDamage)&&plan.rawDamage>=0&&Number.isFinite(plan.contactAt)&&Number.isFinite(plan.cooldownUntil)&&
  typeof plan.allowTargetAtContact==='function'&&typeof plan.afterAccepted==='function'&&
  typeof plan.cancelOnControl==='boolean'&&plan.cancelOnDeath===true;}

function createDefinition({authorize}={}){
  if(authorize!==undefined&&typeof authorize!=='function')throw Error('Invalid Q authority');
  const states=new WeakMap();
  const stateFor=(sim,entity)=>sim?.entities?.get(entity?.id)===entity?states.get(entity):null;
  const installed=entity=>states.has(entity);
  function install(sim,entity,{levels={}}={}){
    if(entity.heroId!==234||sim.entities.get(entity.id)!==entity)return false;
    const level=levels.Q??0;if(!Number.isInteger(level)||level<0||level>5)throw Error('Invalid Q learning level');
    if(states.has(entity))return true;
    const state={level,epoch:0,nextCastId:1,pending:new Map(),settling:null};states.set(entity,state);
    entity.kannaQ=state;entity.skills||={};if(level)entity.skills.Q=describeQ(level);return true;
  }
  function resolveSkill(sim,entity,value){
    const state=stateFor(sim,entity),id=Number(typeof value==='object'?value?.id:value);
    return state&&state.level>0&&id===9453?describeQ(state.level):null;
  }
  function validateCast(sim,entity,value,aim={}){
    if(sim?.heroes?.closed)return fail('world-closed');
    const state=stateFor(sim,entity),skill=resolveSkill(sim,entity,value);
    if(!state||!skill)return fail('unknown-kanna-q');
    if(!entity.alive)return fail('dead');
    if(entity.controlUntil>sim.time)return fail('controlled');
    if((entity.cooldowns?.Q||0)>sim.time)return fail('cooldown');
    if(!Number.isFinite(entity.mp)||entity.mp<skill.mana)return fail('mana');
    const target=sim.entities.get(aim.targetId);
    if(!target||!finitePoint(entity)||!finitePoint(target)||!sim.enemies(entity,target))return fail('invalid-target');
    if(distance(entity,target)>skill.range)return fail('range');
    if(!authorize)return fail('q-runtime-evidence-missing');
    const plan=authorize({sim,entity,target,skill,aim:{...aim},description:descriptions.get(skill.level)});
    if(!evidenceComplete(plan))return fail('q-runtime-evidence-incomplete');
    if(plan.contactAt<sim.time||plan.cooldownUntil<sim.time)return fail('q-authority-time-invalid');
    if(plan.targetAllowed!==true)return fail('q-target-kind-unverified');
    return {ok:true,state,skill,target,plan};
  }
  function applyCast(sim,entity,value,aim={}){
    const checked=validateCast(sim,entity,value,aim);if(!checked.ok)return checked;
    const {state,skill,target,plan}=checked,castId=state.nextCastId++;
    const pending={castId,epoch:state.epoch,entity,target,targetId:target.id,casterLife:entity.reviveCount,targetLife:target.reviveCount,
      skill,plan,spentMana:skill.mana,origin:{x:entity.x,z:entity.z},acceptedAt:sim.time};
    entity.mp-=skill.mana;entity.cooldowns||={};entity.cooldowns.Q=plan.cooldownUntil;state.pending.set(castId,pending);
    sim.event('cast',{id:entity.id,slot:skill.slot,skillId:skill.id,skill,readyAt:plan.cooldownUntil,
      aim:{...aim,targetId:target.id},castOrigin:pending.origin,cooldown:plan.cooldownUntil-sim.time,hp:entity.hp,mp:entity.mp,kannaCastId:castId});
    // The authority performs the verified passive path (or proves zero charge).
    // No description-derived passive arithmetic is substituted here.
    plan.afterAccepted({sim,entity,target,skill,castId,spentMana:skill.mana});
    if(plan.contactAt===sim.time)settleContact(sim,entity,castId);
    return {ok:true,castId,pendingUntil:plan.contactAt,scope:'Q-only-host-adapter'};
  }
  function settleContact(sim,entity,castId){
    if(sim?.heroes?.closed)return fail('world-closed');
    const state=stateFor(sim,entity),pending=state?.pending.get(castId);
    if(!pending)return fail('q-contact-missing');
    if(pending.epoch!==state.epoch||pending.entity!==entity)return fail('q-contact-stale');
    if(sim.time<pending.plan.contactAt)return fail('q-contact-early');
    // Consume before calling host damage, whose death hooks can be reentrant.
    state.pending.delete(castId);
    const target=sim.entities.get(pending.targetId);
    if(target!==pending.target||!entity.alive||!target?.alive||!sim.enemies(entity,target))return fail('q-contact-invalid-target');
    if(entity.reviveCount!==pending.casterLife||target.reviveCount!==pending.targetLife)return fail('q-contact-new-life');
    if(pending.plan.allowTargetAtContact({sim,entity,target,pending})!==true)return fail('q-contact-authority-rejected');
    state.settling=pending;
    let amount;try{amount=sim.damage(entity,target,pending.plan.rawDamage,pending.plan.damageSkillId,'magic',undefined,pending.origin,{skillLevel:pending.skill.level});}finally{state.settling=null;}
    const killed=target.alive===false;let refundResolved=!killed;
    if(killed){
      const intent={id:entity.id,targetId:target.id,castId,manaSource:'actual-cast-spend',unroundedManaRefund:pending.spentMana*.5,cooldownReductionPercent:50,
        unknowns:['MP refund rounding','CD reduction uses remaining or original duration','Q versus passive-chain kill attribution']};
      sim.event('kanna-q-refund-intent',intent);
      // Kill refund is executable only if this extra policy is independently
      // verified. Otherwise preserve the intent without changing MP/CD.
      const refund=pending.plan.refundOnDirectKill?.({sim,entity,target,pending,intent});
      if(refund?.confirmed===true&&typeof refund.evidence==='string'&&refund.evidence.trim()&&Number.isFinite(refund.mana)&&refund.mana>=0&&Number.isFinite(refund.cooldownUntil)&&refund.cooldownUntil>=sim.time){
        entity.mp=Math.min(entity.mpMax,entity.mp+refund.mana);entity.cooldowns.Q=refund.cooldownUntil;
        sim.event('hero-resource',{id:entity.id,hp:entity.hp,mp:entity.mp,reason:'kanna-q-direct-kill'});
        sim.event('skill-cooldown',{id:entity.id,slot:pending.skill.slot,skillId:pending.skill.id,skill:pending.skill,
          readyAt:entity.cooldowns.Q,reason:'kanna-q-direct-kill'});refundResolved=true;
      }
    }
    return {ok:true,amount,killed,castId,refundResolved};
  }
  function tick(sim,entity){const state=stateFor(sim,entity);if(!state)return;for(const [id,pending]of [...state.pending])if(sim.time>=pending.plan.contactAt)settleContact(sim,entity,id);}
  function clear(sim,entity,reason){const state=stateFor(sim,entity);if(!state)return;state.pending.clear();state.epoch++;sim.event('kanna-q-clear',{id:entity.id,reason});}
  const definition={heroId:234,name:'kanna-q-evidence-adapter',install,isInstalled:installed,
    ownsSkill:(_sim,_entity,skill)=>Number(typeof skill==='object'?skill?.id:skill)===9453,
    resolveSkill,validateCast,applyCast,tick,
    onControl(sim,entity){const state=stateFor(sim,entity);if(!state)return;for(const [id,pending]of state.pending)if(pending.plan.cancelOnControl)state.pending.delete(id);},
    onRespawn:(sim,entity)=>clear(sim,entity,'respawn'),onLeave:(sim,entity)=>clear(sim,entity,'leave'),
    world:{onDeath(sim,_killer,victim){if(states.has(victim))clear(sim,victim,'death');}}
  };
  return {definition,settleContact,state:entity=>states.get(entity)||null};
}

module.exports={describeQ,calculateDisplayedDamage,createDefinition};
