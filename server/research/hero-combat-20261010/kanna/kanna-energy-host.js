'use strict';

// Executable energy/W state mechanics; no passive damage, guessed W cooldown,
// guessed clock phase, default player admission, or independent projectile.
const snapshot=require('./snapshot.json');
const rows=new Map(snapshot.skillLevels.map(r=>[`${r.named.nSkillID}:${r.named.nLevel}`,r.named]));
const ROLE={9453:'Q',9470:'Q',9455:'W',9461:'W'},IDS=new Set(Object.keys(ROLE).map(Number));
const RULES=Object.freeze({normalCap:3,chargingCap:7,normalInterval:5,chargingInterval:1,overflowInterval:1,exitSpeedPercent:30});
const EPS=1e-8,fail=reason=>({ok:false,reason}),finiteTime=n=>Number.isFinite(n)&&n>=0;
const cap=s=>s.charging?RULES.chargingCap:RULES.normalCap;
const period=s=>s.charging?RULES.chargingInterval:RULES.normalInterval;
const copy=s=>({energy:s.energy,charging:s.charging,life:s.life,epoch:s.epoch,nextGainAt:s.nextGainAt,nextDecayAt:s.nextDecayAt,levels:{...s.levels}});
function metadata(id,level){const r=rows.get(`${id}:${level}`);if(!r)return null;return {id,slot:ROLE[id],level,name:r.strSkillName,type:'hero-specific',mana:r.nCostMP,
  cooldown:id===9461?null:r.nCDTime/1000,range:r.fRange,targetRange:r.fTargetRange,action:r.strSkillAct||null,rawCooldownMs:r.nCDTime};}
function validClock(clock){return typeof clock?.evidence==='string'&&clock.evidence.trim()&&typeof clock.onModeChange==='function'&&typeof clock.afterSpend==='function'&&['continue','pause'].includes(clock.capBehavior);}
function validPhase(phase,now,energy,charging){return phase&&finiteTime(phase.nextGainAt)&&phase.nextGainAt>=now-EPS&&
  (charging||energy<=3?phase.nextDecayAt==null:finiteTime(phase.nextDecayAt)&&phase.nextDecayAt>=now-EPS);}
function createDefinition({clock,lifecycle={},exitPolicy,controlPolicy,combat}={}){
  if(exitPolicy!==undefined&&typeof exitPolicy!=='function')throw Error('Invalid W exit policy');
  const states=new WeakMap();
  const stateFor=(sim,e)=>{const s=states.get(e);return sim?.entities?.get(e?.id)===e&&s?.world===sim?s:null;};
  function energyEvent(sim,e,s,reason,occurredAt=sim.time){sim.event('kanna-energy',{id:e.id,energy:s.energy,cap:cap(s),charging:s.charging,reason,occurredAt,life:s.life});}
  function syncSkills(sim,e,s){
    e.skills||={};if(s.levels.Q)e.skills.Q=!s.charging&&combat?.resolveSkill?combat.resolveSkill(sim,e,9453)||metadata(9453,s.levels.Q):metadata(s.charging?9470:9453,s.levels.Q);
    if(s.levels.W)e.skills.W=metadata(s.charging?9461:9455,s.levels.W);
  }
  function setPhase(s,phase,now){
    if(!validPhase(phase,now,s.energy,s.charging)){s.nextGainAt=null;s.nextDecayAt=null;s.clockKnown=false;return false;}
    s.nextGainAt=s.energy>=cap(s)&&clock.capBehavior==='pause'?null:phase.nextGainAt;s.nextDecayAt=s.charging||s.energy<=3?null:phase.nextDecayAt;s.clockKnown=true;return true;
  }
  function advance(sim,e,now=sim.time){
    const s=stateFor(sim,e);if(!s||s.closed||!e.alive||!s.clockKnown||s.energy===null||s.life!==e.reviveCount)return false;
    if(now<s.lastAdvanced-EPS)throw Error('Kanna clock moved backwards');
    while(true){
      const nextGain=s.nextGainAt??Infinity,nextDecay=s.nextDecayAt??Infinity,at=Math.min(nextGain,nextDecay);if(at>now+EPS)break;
      if(nextDecay<=at+EPS){
        if(!s.charging&&s.energy>3){s.energy--;energyEvent(sim,e,s,'overflow-decay',at);}
        s.nextDecayAt=!s.charging&&s.energy>3?at+RULES.overflowInterval:null;
      }
      if(nextGain<=at+EPS){
        if(s.energy<cap(s)){s.energy++;energyEvent(sim,e,s,'regenerate',at);}
        if(s.energy>=cap(s)&&clock.capBehavior==='pause')s.nextGainAt=null;
        else s.nextGainAt=at+period(s);
        // Capped continuous clocks change no resource; skip redundant cycles.
        if(s.energy>=cap(s)&&s.nextDecayAt===null&&clock.capBehavior==='continue'&&s.nextGainAt<=now+EPS)
          s.nextGainAt+=(Math.floor((now+EPS-s.nextGainAt)/period(s))+1)*period(s);
      }
    }
    s.lastAdvanced=now;return true;
  }
  function install(sim,e,options={}){
    if(e.heroId!==234||sim.entities.get(e.id)!==e||!validClock(clock))return false;
    if(states.has(e))return states.get(e).world===sim&&!states.get(e).closed;
    const initial=options.initial,levels={};for(const slot of ['Q','W','E','R']){const n=options.levels?.[slot]??0;if(!Number.isInteger(n)||n<0||n>(slot==='R'?3:5))throw Error('Invalid Kanna level');levels[slot]=n;}
    if(!initial||initial.mode!=='normal'||typeof initial.evidence!=='string'||!initial.evidence.trim()||!Number.isInteger(initial.energy)||initial.energy<0||initial.energy>3||!finiteTime(initial.nextGainAt)||initial.nextGainAt<sim.time-EPS)return false;
    if(combat?.install&&combat.install(sim,e,options)===false)return false;
    const s={world:sim,levels,ownerId:e.id,life:e.reviveCount,epoch:0,energy:initial.energy,charging:false,chargeOrigin:null,clockKnown:true,nextGainAt:initial.nextGainAt,nextDecayAt:null,lastAdvanced:sim.time,
      wExitSerial:0,pendingExit:null,wCooldownUnresolved:false,speedUntil:null,speedUnresolved:false,seenAccepted:new Set(),lastDeath:null,closed:false};
    if(s.energy===3&&clock.capBehavior==='pause')s.nextGainAt=null;
    states.set(e,s);e.kannaEnergy=s;syncSkills(sim,e,s);energyEvent(sim,e,s,'install');sim.updateBuffs?.(e);return true;
  }
  function resolveSkill(sim,e,value){const s=stateFor(sim,e),id=Number(typeof value==='object'?value?.id:value),role=ROLE[id];if(!s||!role||!s.levels[role])return null;
    return metadata(id,s.levels[role]);}
  function validateCast(sim,e,value){
    if(sim.heroes?.closed)return fail('world-closed');const s=stateFor(sim,e),skill=resolveSkill(sim,e,value);if(!s||!skill)return fail('unknown-kanna-state-skill');
    if(!e.alive||s.energy===null||s.life!==e.reviveCount)return fail('kanna-life-uninitialized');
    if(e.controlUntil>sim.time)return fail('controlled');
    const active={Q:s.charging?9470:9453,W:s.charging?9461:9455};if(active[skill.slot]!==skill.id)return fail('inactive-stage');
    if(skill.id===9455&&(s.wCooldownUnresolved||(e.cooldowns?.W||0)>sim.time))return fail(s.wCooldownUnresolved?'w-cooldown-unresolved':'cooldown');
    if(e.mp<skill.mana)return fail('mana');return {ok:true,state:s,skill};
  }
  function resolveExit(sim,e,resolution,token=stateFor(sim,e)?.pendingExit?.token){
    const s=stateFor(sim,e),pending=s?.pendingExit;if(!pending||token!==pending.token||s.life!==e.reviveCount||pending.life!==s.life||pending.epoch!==s.epoch||s.closed||sim.heroes?.closed)return fail('w-exit-stale');
    if(resolution?.cooldownUntil!==undefined&&(!finiteTime(resolution.cooldownUntil)||resolution.cooldownUntil<pending.at-EPS||![9455,9461].includes(resolution.cooldownSkillId)||typeof resolution.cooldownEvidence!=='string'||!resolution.cooldownEvidence.trim()))return fail('w-cooldown-resolution-invalid');
    if(resolution?.speedUntil!==undefined&&(!finiteTime(resolution.speedUntil)||resolution.speedUntil<pending.at-EPS||typeof resolution.speedEvidence!=='string'||!resolution.speedEvidence.trim()))return fail('w-speed-resolution-invalid');
    let changed=false;
    if(resolution?.cooldownUntil!==undefined){
      e.cooldowns.W=resolution.cooldownUntil;s.wCooldownUnresolved=false;changed=true;
      const skill=metadata(resolution.cooldownSkillId,s.levels.W);sim.event('skill-cooldown',{id:e.id,slot:'W',skillId:skill.id,skill,readyAt:resolution.cooldownUntil,reason:'kanna-w-exit-resolved'});
    }
    if(resolution?.speedUntil!==undefined){
      s.speedUntil=resolution.speedUntil;s.speedUnresolved=false;changed=true;
    }
    if(changed)sim.updateBuffs?.(e);return {ok:changed,reason:changed?undefined:'w-exit-unresolved'};
  }
  function stopCharge(sim,e,reason='manual'){
    const s=stateFor(sim,e);if(!s||!s.charging)return {ok:true,changed:false};advance(sim,e);
    s.charging=false;s.chargeOrigin=null;s.wCooldownUnresolved=true;s.speedUnresolved=true;
    const phase=clock.onModeChange({sim,entity:e,state:copy(s),mode:'normal',reason});setPhase(s,phase,sim.time);
    const pending={at:sim.time,life:s.life,epoch:s.epoch,reason,token:Object.freeze({ownerId:e.id,life:s.life,epoch:s.epoch,serial:++s.wExitSerial}),level:s.levels.W,
      tableCooldownMs:[12000,10000,8000,6000,4000][s.levels.W-1],descriptionCooldownMs:[8000,7000,6000,5000,4000][s.levels.W-1],speedDurationCandidatesMs:[3000,1750]};s.pendingExit=pending;
    syncSkills(sim,e,s);sim.updateBuffs?.(e);energyEvent(sim,e,s,'charge-stop');
    sim.event('kanna-charge-stop',{id:e.id,reason,slots:{Q:9453,W:9455},statusRemove:[20002,20031],exitToken:pending.token,clockKnown:s.clockKnown});
    if(exitPolicy){const resolution=exitPolicy({sim,entity:e,state:copy(s),pending:{...pending}});if(resolution)resolveExit(sim,e,resolution,pending.token);}
    if(s.wCooldownUnresolved||s.speedUnresolved)sim.event('kanna-w-exit-unresolved',{id:e.id,exitToken:pending.token,cooldown:s.wCooldownUnresolved,speedDuration:s.speedUnresolved});
    return {ok:true,changed:true,exitToken:pending.token};
  }
  function applyCast(sim,e,value,aim={}){
    const checked=validateCast(sim,e,value);if(!checked.ok)return checked;const {state:s,skill}=checked;
    if(skill.id===9453)return combat?.applyCast?.(sim,e,skill,aim)||fail('q-runtime-evidence-missing');
    if(skill.id===9470)return fail('charged-q-runtime-evidence-missing');
    if(skill.id===9461)return stopCharge(sim,e,'manual');
    advance(sim,e);const future={...copy(s),charging:true},phase=clock.onModeChange({sim,entity:e,state:future,mode:'charging',reason:'activate'});
    if(!validPhase(phase,sim.time,s.energy,true))return fail('charge-clock-phase-unresolved');
    e.mp-=skill.mana;s.charging=true;s.chargeOrigin={x:e.x,z:e.z};s.pendingExit=null;setPhase(s,phase,sim.time);
    sim.cancelWindup?.(e);sim.stopMotion?.(e);e.targetId=null;e.path=[];syncSkills(sim,e,s);sim.updateBuffs?.(e);
    sim.event('hero-resource',{id:e.id,hp:e.hp,mp:e.mp,reason:'kanna-w-start'});energyEvent(sim,e,s,'charge-start');
    sim.event('kanna-charge-start',{id:e.id,slots:{Q:9470,W:9461},statusIds:[20002,20031],nextGainAt:s.nextGainAt});return {ok:true,scope:'energy-and-w-state'};
  }
  function consumeForAcceptedSkill(sim,e,{castId,skillId,targetId,accepted,evidence}={}){
    const s=stateFor(sim,e),target=sim.entities.get(targetId);if(!s||s.closed||sim.heroes?.closed||!e.alive||s.life!==e.reviveCount||s.energy===null)return fail('kanna-life-uninitialized');
    if(accepted!==true||typeof evidence!=='string'||!evidence.trim()||!['number','string'].includes(typeof castId)||![9453,9470,9456,9458].includes(skillId)||!target||!sim.enemies(e,target))return fail('passive-acceptance-evidence-required');
    const key=`${s.life}:${skillId}:${castId}`;if(s.seenAccepted.has(key))return fail('passive-already-consumed');advance(sim,e);s.seenAccepted.add(key);
    if(s.energy===0)return {ok:true,consumed:false};s.energy--;if(!s.charging&&s.energy<=3)s.nextDecayAt=null;
    const phase=clock.afterSpend({sim,entity:e,state:copy(s),mode:s.charging?'charging':'normal'});setPhase(s,phase,sim.time);energyEvent(sim,e,s,'accepted-offensive-skill');
    const tier=(e.level||1)>=16?3:(e.level||1)>=11?2:(e.level||1)>=6?1:0;
    sim.event('kanna-passive-chain-intent',{id:e.id,targetId,skillId,castId,energy:s.energy,descriptionBase:[40,70,100,130][tier],descriptionAttributeId:31,descriptionCoefficient:.25,descriptionRange:300,firstTargetMultiplier:.5,
      unknowns:['jump target ordering/geometry','runtime damage formula and result skill mapping']});return {ok:true,consumed:true,clockKnown:s.clockKnown};
  }
  function lifecycleSuspend(sim,e,reason){const s=stateFor(sim,e);if(!s)return;
    if(reason!=='respawn'||!s.lastDeath)s.lastDeath={...copy(s),at:sim.time,reason};s.epoch++;s.life=e.reviveCount;s.charging=false;s.chargeOrigin=null;s.energy=null;s.nextGainAt=null;s.nextDecayAt=null;s.clockKnown=false;s.speedUntil=null;s.pendingExit=null;s.seenAccepted.clear();s.wCooldownUnresolved=true;
    syncSkills(sim,e,s);sim.updateBuffs?.(e);sim.event('kanna-energy-unresolved',{id:e.id,reason,policy:'host lifecycle initialization required'});}
  function onRespawn(sim,e){const s=stateFor(sim,e);if(!s)return;lifecycleSuspend(sim,e,'respawn');const init=lifecycle.onRespawn?.({sim,entity:e,previous:s.lastDeath});
    if(!init||typeof init.evidence!=='string'||!init.evidence.trim()||!Number.isInteger(init.energy)||init.energy<0||init.energy>7)return;
    s.energy=init.energy;s.life=e.reviveCount;s.lastAdvanced=sim.time;setPhase(s,init,sim.time);s.wCooldownUnresolved=init.wCooldownResolved!==true;energyEvent(sim,e,s,'host-respawn-initialize');}
  function tick(sim,e,step){const s=stateFor(sim,e);if(!s||s.closed||sim.heroes?.closed)return;
    if(s.life!==e.reviveCount){onRespawn(sim,e);return;}
    if(e.alive&&s.charging&&s.chargeOrigin&&Math.hypot(e.x-s.chargeOrigin.x,e.z-s.chargeOrigin.z)>EPS)stopCharge(sim,e,'displacement');
    advance(sim,e);if(s.speedUntil!==null&&s.speedUntil<=sim.time+EPS){s.speedUntil=null;sim.updateBuffs?.(e);}combat?.tick?.(sim,e,step);}
  function onMoveOrder(sim,e){const result=stopCharge(sim,e,'move-order');return result.ok?undefined:result;}
  const definition={heroId:234,name:'kanna-energy-w-state',install,isInstalled:e=>states.has(e),ownsSkill:(_sim,_e,skill)=>IDS.has(Number(typeof skill==='object'?skill?.id:skill)),resolveSkill,validateCast,applyCast,tick,onMoveOrder,
    modifiers(sim,e){const s=stateFor(sim,e);if(!s||!e.alive)return {};const extra=combat?.modifiers?.(sim,e)||{};return {...extra,rooted:s.charging||!!extra.rooted,speedPercent:(extra.speedPercent||0)+(s.speedUntil!==null&&s.speedUntil>sim.time+EPS?RULES.exitSpeedPercent:0)};},
    canAct(sim,e,action){const s=stateFor(sim,e);if(s?.charging&&['move','attack'].includes(action))return false;return combat?.canAct?.(sim,e,action)!==false;},
    onControl(sim,e,reason){const s=stateFor(sim,e);if(s?.charging){if(controlPolicy?.stopCharge===true&&typeof controlPolicy.evidence==='string'&&controlPolicy.evidence.trim())stopCharge(sim,e,reason||'control');else if(controlPolicy?.stopCharge!==false){s.clockKnown=false;s.nextGainAt=null;s.nextDecayAt=null;sim.event('kanna-control-unresolved',{id:e.id,reason});}}combat?.onControl?.(sim,e,reason);},
    onRespawn(sim,e){combat?.onRespawn?.(sim,e);onRespawn(sim,e);},
    onLeave(sim,e){combat?.onLeave?.(sim,e);const s=stateFor(sim,e);if(s){s.closed=true;s.charging=false;s.nextGainAt=null;s.nextDecayAt=null;s.speedUntil=null;s.pendingExit=null;s.seenAccepted.clear();}},
    world:{onCast:(...args)=>combat?.world?.onCast?.(...args),onDeath(sim,killer,victim,context){const life=context?.targetLife??victim.reviveCount;
      combat?.world?.onDeath?.(sim,killer,victim,context);if(context?.targetCurrent===false||!stateFor(sim,victim)||sim.entities.get(victim.id)!==victim||victim.reviveCount!==life)return;
      lifecycleSuspend(sim,victim,'death');lifecycle.onDeath?.({sim,entity:victim,previous:states.get(victim).lastDeath});}}
  };
  return {definition,state:e=>states.get(e)||null,advance,stopCharge,onMoveOrder,resolveExit,consumeForAcceptedSkill,
    skillRange(sim,e,id){const s=stateFor(sim,e),row=rows.get(`${id}:${s?.levels[id===9456?'E':'Q']||1}`);return row?row.fRange+(id===9456&&s?.charging?2:0):null;},
    statusSnapshot(sim,e){const s=stateFor(sim,e);if(!s||!e.alive)return [];return [...(s.charging?[{id:20002,level:1},{id:20031,level:1}]:[]),...(s.energy>0?[{id:20012,level:1,energyCountCandidate:s.energy}]:[]),...(s.speedUntil>sim.time?[{id:20026,level:1,until:s.speedUntil}]:[])];}
  };
}
module.exports={RULES,createDefinition};
