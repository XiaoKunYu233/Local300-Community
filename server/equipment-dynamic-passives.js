'use strict';
// Hooks run once for a successful basic attack and during updateBuffs. Damage,
// shields and lifesteal remain one transaction in BattleSim.
const markSlot='equipment:sword-marks';
const dynamicIds=[14,24,25,36,96,97,98];
const managedAttributes=new WeakMap();
const genesisStates=new WeakMap();
const rainbowStates=new WeakMap();
const magicLowHealthShields=new WeakMap();
const magicDotBindings=new WeakMap(),magicDotsByHero=new WeakMap(),magicRules=require('./battle-magic-gem-rules');
const {shieldCap}=require('./equipment-passive-shields');
const entryCombat=require('./war-soul-entry-combat');
function genesisState(sim,hero){
  if(!hero?.passives?.genesis)return null;
  let state=genesisStates.get(hero),guid=hero.passives.genesis.guid??String(hero.passives.genesis.itemId??'genesis');
  if(!state||state.sim!==sim){state={sim,guid,life:hero.reviveCount||0,hits:[],cooldownUntil:0};genesisStates.set(hero,state);}
  if(state.guid!==guid||state.life!==(hero.reviveCount||0)){state.hits=[];state.guid=guid;state.life=hero.reviveCount||0;}
  state.hits=state.hits.filter(hit=>hit.at>sim.time-4);
  if(!hero.alive)state.hits=[];
  hero.genesisState=state;return state;
}
function rainbowState(sim,hero){
  if(!hero?.passives?.rainbow)return null;
  let state=rainbowStates.get(hero),guid=hero.passives.rainbow.guid??String(hero.passives.rainbow.itemId??'rainbow');
  if(!state||state.sim!==sim){state={sim,guid,life:hero.reviveCount||0,hits:0,healHits:0,expires:-Infinity,procReadyAt:0,healReadyAt:0};rainbowStates.set(hero,state);}
  if(state.guid!==guid||state.life!==(hero.reviveCount||0)){state.hits=0;state.healHits=0;state.guid=guid;state.life=hero.reviveCount||0;}
  if(!hero.alive||state.expires<=sim.time)state.hits=0;
  hero.rainbowState=state;return state;
}
function genesisCooldown(sim,hero,readyAt){
  const state=genesisState(sim,hero);if(!state)return;
  state.cooldownUntil=Math.max(sim.time,readyAt);hero.equipmentDynamicCooldowns??={};hero.equipmentDynamicCooldowns['genesis:trigger']=state.cooldownUntil;
  sim.event('skill-cooldown',{id:hero.id,skill:hero.skills?.['equipment:20197']||{id:20197,level:1},readyAt:state.cooldownUntil});
}
function beforeActive(sim,hero,skill){
  if(!skill?.switchPenetration||!hero?.passives?.genesis)return {ok:true};
  const state=genesisState(sim,hero);
  return state.cooldownUntil>sim.time?{ok:false,reason:'genesis-passive-cooldown',readyAt:state.cooldownUntil}:{ok:true};
}
function expireMagicLowHealthShield(sim,hero){
  const state=magicLowHealthShields.get(hero);if(!state)return;
  if(state.sim!==sim){magicLowHealthShields.delete(hero);return;}
  const equipped=magicEffects(hero).some(effect=>`${effect.setId}:${effect.effectId||0}:${effect.type}`===state.key);
  if(state.life===(hero.reviveCount||0)&&hero.alive&&state.buff.until>sim.time&&equipped)return;
  const remaining=Math.min(Math.max(0,hero.shield||0),Math.max(0,Number(state.buff.magicGemShieldHealRemaining)||0));
  if(remaining>0)sim.setShield(hero,Math.max(0,(hero.shield||0)-remaining));
  state.buff.magicGemShieldHealRemaining=0;hero.buffs=hero.buffs.filter(buff=>buff!==state.buff);magicLowHealthShields.delete(hero);
}
// Called exactly once per real committed HP loss, including proc/deferred and
// guardian-share damage. Absorbed shield damage never enters this window.
function onCommittedDamage(sim,target,attacker,{amount=0,life=target?.reviveCount}={}){
  if(!target?.alive||!attacker||target.kind!=='hero'||!(amount>0)||
    target.reviveCount!==life||sim.entities.get(target.id)!==target||sim.entities.get(attacker.id)!==attacker)return;
  const state=genesisState(sim,target);if(!state)return;
  state.hits.push({at:sim.time,amount});
  if(state.cooldownUntil>sim.time||state.hits.reduce((sum,hit)=>sum+hit.amount,0)<target.hpMax*.5&&target.hp>0)return;
  state.hits=[];genesisCooldown(sim,target,sim.time+32);
  if(target.hp<=0)target.hp=1;
  const slots=new Set(['equipment:genesis-protection','equipment:genesis-speed','equipment:genesis-lifesteal']);
  target.buffs=target.buffs.filter(buff=>!slots.has(buff.slot));
  target.buffs.push({slot:'equipment:genesis-protection',until:sim.time+.7,damageReductionPhysical:100,damageReductionMagic:100,damageReduction:100});
  target.buffs.push({slot:'equipment:genesis-speed',until:sim.time+2,speed:1.5});
  target.buffs.push({slot:'equipment:genesis-lifesteal',until:sim.time+3,lifeSteal:30,spellVamp:30});
  sim.updateBuffs(target);
  // Current native skill20196 level1 fRange/fWidth are both 4.5 (450 UI units).
  for(const other of sim.entities.values())if(other.alive&&sim.enemies(target,other)&&Math.hypot(target.x-other.x,target.z-other.z)<=4.5)
    sim.damage(target,other,target.attackDamage,20196,'physical',undefined,undefined,{equipmentProc:true,equipmentProcs:false,basic:false,skillCritical:true});
  sim.event('passive',{id:target.id,effect:'genesis-trigger',cooldownUntil:state.cooldownUntil});
}
function effectSlot(itemId,kind,targetId){return `equipment:${itemId}:${kind}:${targetId??'self'}`;}
function battlefieldEffect(effect){return effect?.source!=='catalog'||effect.battlefieldOnly===true;}
function magicEffects(hero){
  const seen=new Set(),out=[];
  for(const effect of hero?.magicGemEffects||[]){
    if(!effect?.type||!String(effect.type).startsWith('magicGem')||require('./battle-progression-effects').handles(effect))continue;
    const key=`${effect.setId||0}:${effect.setLevel||0}:${effect.effectId||0}:${effect.type}`;
    if(seen.has(key))continue;seen.add(key);out.push(magicRules.normalize(effect));
  }
  return out;
}
function magicSlot(effect,kind,targetId){return `magicgem:${effect.setId||0}:${effect.effectId||0}:${kind}:${targetId??'self'}`;}
function warSoulEffects(hero){
  return (hero?.warSoulEffects||[]).filter(effect=>Number(effect?.statusId)>0&&!Number(effect?.succinctId)).map(effect=>({
    ...effect,
    statusId:Number(effect.statusId),
    values:String(effect.soulValue||'').split(';').map(Number).filter(Number.isFinite)
  }));
}
function warSoulTotal(hero,statusId){
  const prefix=Math.floor(Number(statusId)/100), channel={360:32,361:33,362:34,363:35}[prefix];
  const opposite={32:45,33:46,34:47,35:48}[channel];
  if(channel&&hero.warSoul){
    return Number(hero.warSoul.restraint?.[channel]||0)+Number(hero.warSoul.resistance?.[opposite]||0);
  }
  return Number(hero.warSoul?.averageRestraint||0)+Number(hero.warSoul?.averageResistance||0);
}
function warSoulCooldownReady(hero,key,now,cooldown){
  hero.warSoulCooldowns??={};
  if((hero.warSoulCooldowns[key]||0)>now)return false;
  hero.warSoulCooldowns[key]=now+cooldown;return true;
}
function triggerWarSoulDamage(sim,attacker,target){
  if(!attacker?.alive||!target?.alive)return;
  for(const effect of warSoulEffects(attacker)){
    const kind=effect.statusId%100,key=`${effect.statusId}:${effect.succinctId||0}`;
    if(kind===11&&sim.random()*100<25&&warSoulCooldownReady(attacker,key,sim.time,6)){
      const amount=Math.max(0,Math.floor(effect.values[1]||0));
      if(amount>0)sim.damage(attacker,target,amount,540000+effect.statusId,'true',undefined,undefined,{equipmentProc:true});
      if(target.alive)debuff(sim,attacker,target,`war-soul:${effect.statusId}`,{type:'warSoulBlade',slow:50,duration:2});
      sim.event('passive',{id:attacker.id,effect:'war-soul-blade',statusId:effect.statusId,target:target.id,amount});
    }else if(kind===12&&warSoulCooldownReady(attacker,key,sim.time,30)){
      const amount=Math.max(0,Math.floor(warSoulTotal(attacker,effect.statusId)*(effect.values[1]||0)/100+(effect.values[2]||0)));
      const gained=sim.heal(attacker,amount,{reason:'war-soul-heal'});
      if(gained)sim.event('passive',{id:attacker.id,effect:'war-soul-heal',statusId:effect.statusId,amount:gained});
    }else if(kind===13&&warSoulCooldownReady(attacker,key,sim.time,30)){
      const amount=Math.max(0,Math.floor(warSoulTotal(attacker,effect.statusId)*(effect.values[1]||0)/100+(effect.values[2]||0)));
      const slot=`war-soul:${effect.statusId}:offense`;attacker.buffs=attacker.buffs.filter(buff=>buff.slot!==slot);
      attacker.buffs.push({slot,until:sim.time+3,attackBonus:amount,abilityPower:amount});sim.updateBuffs(attacker);
      sim.event('passive',{id:attacker.id,effect:'war-soul-offense',statusId:effect.statusId,amount});
    }else if(kind>=16&&kind<=20&&warSoulCooldownReady(attacker,key,sim.time,2)){
      const slot=`war-soul:${effect.statusId}:speed`;attacker.buffs=attacker.buffs.filter(buff=>buff.slot!==slot);
      attacker.buffs.push({slot,until:sim.time+2,speed:1.35});sim.updateBuffs(attacker);
      sim.event('passive',{id:attacker.id,effect:'war-soul-speed',statusId:effect.statusId});
    }
  }
}
function triggerWarSoulTaken(sim,target){
  if(!target?.alive)return;
  for(const effect of warSoulEffects(target)){
    const kind=effect.statusId%100,key=`${effect.statusId}:${effect.succinctId||0}`;
    if(kind===14&&warSoulCooldownReady(target,key,sim.time,20)){
      const amount=Math.max(0,Math.floor(warSoulTotal(target,effect.statusId)*(effect.values[1]||0)/100+(effect.values[2]||0))),slot=`war-soul:${effect.statusId}:defense`;
      target.buffs=target.buffs.filter(buff=>buff.slot!==slot);target.buffs.push({slot,until:sim.time+3,armorBonus:amount,magicResistanceBonus:amount});sim.updateBuffs(target);
      sim.event('passive',{id:target.id,effect:'war-soul-defense',statusId:effect.statusId,amount});
    }else if(kind===15&&warSoulCooldownReady(target,key,sim.time,30)){
      const amount=Math.max(0,Math.floor(warSoulTotal(target,effect.statusId)*(effect.values[1]||0)/100+(effect.values[2]||0)));
      if(amount>0&&!(target.shield>0)){target.warSoulShieldAmount=amount;target.warSoulShieldExpires=sim.time+3;sim.setShield(target,amount);sim.event('passive',{id:target.id,effect:'war-soul-barrier',statusId:effect.statusId,amount});}
    }
  }
}
function debuff(sim,source,target,itemId,effect){
  if(!target?.alive)return;
  const slot=effectSlot(itemId,effect.type,source?.id);
  target.buffs=target.buffs.filter(b=>b.slot!==slot);
  const buff={slot,until:sim.time+Math.max(.05,effect.duration||1),negative:true,debuff:true};
  if(effect.slow)buff.speed=Math.max(0,1-effect.slow/100);
  if(effect.attackSpeed)buff.attackSpeed=-(effect.slow||0);
  if(effect.attackMultiplier!==undefined)buff.attack=Number(effect.attackMultiplier);
  if(effect.abilityPowerReduction)buff.abilityPower=-Number(effect.abilityPowerReduction);
  if(effect.lifeStealReduction)buff.lifeStealReduction=Number(effect.lifeStealReduction)||0;
  if(effect.armorReduction)buff.armorReduction=Number(effect.armorReduction)||0;
  if(effect.magicResistanceReduction)buff.magicResistanceReduction=Number(effect.magicResistanceReduction)||0;
  if(effect.healingReduction)buff.healingReduction=Number(effect.healingReduction)||0;
  target.buffs.push(buff);
  if(effect.root)sim.control(target.id,effect.duration||1);
  if(!effect.aura)sim.updateBuffs(target);
}
function stackDebuff(sim,source,target,item,effect,increment=1){
  if(!target?.alive)return;
  const kind=effect.type==='onBasicStackSlow'?'basic-stack-slow':`physical-stack-${effect.text||''}`;
  const slot=effectSlot(item.itemId,kind,target.id),old=target.buffs.find(b=>b.slot===slot&&b.until>sim.time),layers=Math.min(Number(effect.max||3),(old?.layers||0)+increment),level=Number(item.level||0);
  const buff={slot,until:sim.time+Math.max(.05,effect.duration||3),layers,negative:true,debuff:true};
  if(effect.slowBase!==undefined)buff.speed=Math.max(0,1-(effect.slowBase+level*effect.slowPerLevel)*layers/100);
  if(effect.attackSpeedBase!==undefined)buff.attackSpeed=-(effect.attackSpeedBase+level*effect.attackSpeedPerLevel)*layers;
  if(effect.attackPercentBase!==undefined)buff.attackMultiplier=Math.max(0,1-(effect.attackPercentBase+level*effect.attackPercentPerLevel)*layers/100);
  if(effect.abilityPowerPercentBase!==undefined){const baseAP=target.effectBase?.attributes?.[31]??target.attributes?.[31]??0;buff.abilityPower=-Math.floor(baseAP*(effect.abilityPowerPercentBase+level*effect.abilityPowerPercentPerLevel)*layers/100);}
  if(effect.armorBase!==undefined)buff.armorReduction=(effect.armorBase+level*effect.armorPerLevel)*layers;
  if(effect.hitBase!==undefined)buff.hit=-(effect.hitBase+level*effect.hitPerLevel)*layers;
  if(effect.dodgeBase!==undefined)buff.dodgeReduction=(effect.dodgeBase+level*effect.dodgePerLevel)*layers;
  target.buffs=target.buffs.filter(b=>b.slot!==slot);target.buffs.push(buff);sim.updateBuffs(target);
  sim.event('passive',{id:source.id,target:target.id,effect:'equipment-stack-debuff',itemId:item.itemId,layers});
}
function reviveValues(effect,item,target){
  const level=Number(item?.level||0),hp=effect.heal>0?Number(effect.heal):Math.floor((target.hpMax||0)*((Number(effect.healRatioBase||0)+level*Number(effect.healRatioPerLevel||0))/100));
  const mp=effect.mana>0?Number(effect.mana):Math.floor((target.mpMax||0)*((Number(effect.manaRatioBase||effect.healRatioBase||0)+level*Number(effect.manaRatioPerLevel||effect.healRatioPerLevel||0))/100));
  return {hp,mp};
}
function install(sim,hero){
  const old=hero.equipmentDynamicBase;
  const genesis=genesisState(sim,hero);
  const rainbow=rainbowState(sim,hero);
  const sword=hero.passives?.sword;
  if(!sword?.swordMarks||old?.swordGuid!==sword.guid)
    hero.buffs=hero.buffs.filter(b=>b.slot!==markSlot);
  const dynamicAttributes=Object.fromEntries(dynamicIds.map(id=>[id,hero.attributes?.[id]??(id===25?200:id===14?100:0)]));
  if(Object.prototype.hasOwnProperty.call(hero.attributes||{},31))dynamicAttributes[31]=hero.attributes[31];
  hero.equipmentDynamicBase={swordGuid:sword?.guid,
    attributes:dynamicAttributes,
    // Critical damage has an engine default of 200 and is intentionally
    // materialized for older entities; the remaining optional fields stay
    // absent until the loadout actually supplies them.
    present:new Set(dynamicIds.filter(id=>id===25||id===14&&hero.loadout===undefined||Object.prototype.hasOwnProperty.call(hero.attributes||{},id)))};
  managedAttributes.set(hero.equipmentDynamicBase,new Set(hero.equipmentDynamicBase.present));
  hero.equipmentDynamicCooldowns={};
  if(genesis)hero.equipmentDynamicCooldowns['genesis:trigger']=genesis.cooldownUntil;
  if(rainbow){hero.equipmentDynamicCooldowns['rainbow:proc']=rainbow.procReadyAt;hero.equipmentDynamicCooldowns['rainbow:heal']=rainbow.healReadyAt;}
  hero.magicCritChance=0;hero.magicCritDamage=200;
  hero.lastCombatAt??=-Infinity;hero.effectUntargetable=false;
  for(const item of hero.passives?.generic||[])for(const effect of item.effects||[])if(battlefieldEffect(effect)&&effect.type==='magicCrit'){
    hero.magicCritChance=Math.max(hero.magicCritChance||0,effect.chance||0);
    hero.magicCritDamage=Math.max(hero.magicCritDamage||200,effect.damage||200);
  }
  hero.equipmentArmorReduction=0;
  hero.equipmentHealingReduction=0;
  hero.equipmentHealingReceivedBonus=Number(hero.passives?.zeal?.healingReceived||0);
  hero.equipmentCooldownCapBonus=0;
  hero.equipmentPenetrationBonus=0;hero.equipmentManaRegenRatio=0;
  hero.equipmentStacks={};hero.equipmentStackBase={};hero.equipmentPersistentStacks??={};
  hero.magicGemCounters={};hero.magicGemCooldowns={};
  hero.warSoulCooldowns={};
  if(rainbow)hero.rainbowState=rainbow;
  if(genesis)hero.genesisState=genesis;
  hero.genesisPenBonus=0;
  hero.magicGemWalkDistance={};hero.magicGemTraps=[];hero.magicGemTrapHits=[];hero.magicGemLastPosition={x:hero.x||0,z:hero.z||0};
  for(const item of hero.passives?.generic||[])for(const effect of item.effects||[])if(battlefieldEffect(effect)&&effect.type==='onKillStack'){
    hero.equipmentStacks[item.itemId]??=0;hero.equipmentStackBase[item.itemId]=hero.attributes?.[effect.attr]||0;
  }
  for(const item of hero.passives?.generic||[])for(const effect of item.effects||[])if(effect.type==='basicStack'&&battlefieldEffect(effect))
    hero.equipmentStacks[item.itemId]=Math.min(effect.max||Infinity,hero.equipmentPersistentStacks[item.itemId]||0);
  for(const item of hero.passives?.generic||[])for(const effect of item.effects||[])if(battlefieldEffect(effect)&&effect.type==='cooldownCapBonus')
    hero.equipmentCooldownCapBonus+=Number(effect.amount||0);
  hero.baseMPMax=hero.mpMax;
}
function tick(sim,hero){
  if(!hero.attributes)return false;
  genesisState(sim,hero);
  rainbowState(sim,hero);
  expireMagicLowHealthShield(sim,hero);
  if(!hero.equipmentDynamicBase)install(sim,hero);
  entryCombat.tick(sim,hero);
  if(hero.warSoulShieldExpires!==undefined&&hero.warSoulShieldExpires<=sim.time){
    if((hero.shield||0)<=Number(hero.warSoulShieldAmount||0))sim.setShield(hero,0);
    delete hero.warSoulShieldExpires;delete hero.warSoulShieldAmount;
  }
  const base=hero.equipmentDynamicBase.attributes;
  const generic=(hero.passives?.generic||[]).map(item=>({...item,effects:(item.effects||[]).filter(battlefieldEffect)}));
  // Text-backed movement effects are stateful buffs, not base attributes.
  // Refresh them from the authoritative combat clock and entity positions.
  for(const item of generic)for(const effect of item.effects||[]) {
    if(effect.type==='movingDamageReduction'){
      const slot=effectSlot(item.itemId,'moving-damage-reduction');
      hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
      if(hero.alive&&sim.moving(hero))hero.buffs.push({slot,until:sim.time+.25,damageReduction:Number(effect.amount)||0});
    }
    if(effect.type==='outOfCombatSpeed'){
      const eligible=sim.time-(hero.lastCombatAt??-Infinity)>=Math.max(0,effect.delay||5);
      const slot=effectSlot(item.itemId,'out-of-combat-speed');
      hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
      if(eligible)hero.buffs.push({slot,until:sim.time+.25,speed:1+Number(effect.speed||0)/100});
    }
    if(effect.type==='nearbyEnemySpeed'){
      const near=[...sim.entities.values()].some(target=>target.alive&&sim.enemies(hero,target)&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.radius);
      const slot=effectSlot(item.itemId,'nearby-enemy-speed');
      hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
      if(near)hero.buffs.push({slot,until:sim.time+.25,speed:1+Number(effect.speed||0)/100});
    }
    if(effect.type==='combatMoveSpeed'){
      const active=sim.time-(hero.lastDamagedAt??-Infinity)>=Math.max(0,effect.disableAfter||5);
      const slot=effectSlot(item.itemId,'combat-move-speed');
      hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
      if(active)hero.buffs.push({slot,until:sim.time+.25,speed:1+Number(effect.speed||0)/100});
    }
  }
  // The item's unconditional 150 penetration lives in the static source.
  // "150无相之力 above half HP" has no verified attribute mapping yet.
  const genesisBonus=0;
  if(hero.passives?.genesis&&hero.genesisPenBonus!==genesisBonus){
    hero.genesisPenBonus=genesisBonus;
    hero.effectStatsApplied=false;
  }
  const enabled=hero.alive&&hero.passives?.sword?.swordMarks;
  const buff=enabled?hero.buffs.find(b=>b.slot===markSlot&&b.until>sim.time):null;
  if(!buff)hero.buffs=hero.buffs.filter(b=>b.slot!==markSlot);
  const layers=buff?.layers||0,full=layers===30;
  if(buff)Object.assign(buff,{attack:1+layers/100,criticalChance:layers,
    hit:layers,damageReduction:full?10:0,lifeSteal:full?10:0});
  for(const item of generic)for(const effect of item.effects||[])if(effect.type==='basicStack'){
    const layers=Math.min(effect.max||Infinity,hero.equipmentStacks?.[item.itemId]||0),slot=effectSlot(item.itemId,'basic-stack');
    hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
    if(layers>=Number(effect.max||Infinity))hero.buffs.push({slot,until:sim.time+.25,speed:1+Number(effect.maxMoveSpeed||0)/100});
  }
  const active=hero.buffs.filter(b=>b.until>sim.time);
  hero.equipmentArmorReduction=active.reduce((sum,b)=>sum+(Number(b.armorReduction)||0),0);
  hero.equipmentMagicResistanceReduction=active.reduce((sum,b)=>sum+(Number(b.magicResistanceReduction)||0),0);
  hero.equipmentDodgeReduction=active.reduce((sum,b)=>sum+(Number(b.dodgeReduction)||0),0);
  hero.equipmentHealingReceivedBonus=Number(hero.passives?.zeal?.healingReceived||0)+generic.reduce((sum,item)=>sum+item.effects.reduce((n,e)=>n+(e.type==='healingReceived'?Number(e.amount||0):0),0),0);
  hero.equipmentHealingReduction=Math.min(100,active.reduce((sum,b)=>sum+(Number(b.healingReduction)||0),0));
  hero.equipmentArmorBonus=active.reduce((sum,b)=>sum+(Number(b.armorBonus)||0),0);
  hero.equipmentMagicResistanceBonus=active.reduce((sum,b)=>sum+(Number(b.magicResistanceBonus)||0),0);
  const sum=key=>active.reduce((value,b)=>value+(Number.isFinite(b[key])?b[key]:0),0);
  const extraCrit=sum('criticalChance');
  const next={14:base[14]+sum('hit'),24:base[24]+extraCrit,
    25:base[25]+sum('criticalDamage')+(hero.passives?.sword?extraCrit/2:0),
    36:base[36]+active.reduce((value,b)=>value+((b.attack??1)-1)*100,0),
    96:base[96]+sum('damageReduction'),97:base[97]+sum('lifeSteal'),98:base[98]+sum('spellVamp')};
  for(const item of generic)for(const effect of item.effects||[])if(effect.type==='basicStack'){
    const layers=Math.min(effect.max||Infinity,hero.equipmentStacks?.[item.itemId]||0);
    next[36]+=Math.floor(layers/Math.max(1,effect.perStacks||1))*(effect.attackSpeed||0);
    if(layers>=Number(effect.max||Infinity))next[14]+=Number(effect.maxHit||0);
  }
  const abilityPower=(base[31]??0)+sum('abilityPower');
  if (base[31] !== undefined || abilityPower !== 0) next[31]=abilityPower;
  const critCaps=generic.filter(i=>i.effects.some(e=>e.type==='critDamagePerCrit')).flatMap(i=>i.effects.filter(e=>e.type==='critDamagePerCrit').map(e=>e.cap||50));
  if(critCaps.length)next[25]+=Math.min(...critCaps)*(hero.attributes?.[24]||0)/100;
  for(const item of generic)for(const effect of item.effects||[])if(effect.type==='onKillStack'){
    const value=Math.min(effect.max||0,hero.equipmentStacks?.[item.itemId]||0)*(effect.amount||0);
    if(hero.attributes)hero.attributes[effect.attr]=Math.max(0,(hero.equipmentStackBase?.[item.itemId]||0)+value);
    if(effect.attr===8){const oldMax=hero.hpMax||hero.baseHPMax||0;hero.hpMax=Math.max(hero.baseHPMax||oldMax,(hero.baseHPMax||oldMax)+value);if(hero.hp>oldMax)hero.hp=Math.min(hero.hp,hero.hpMax);}
  }
  hero.equipmentManaRegenRatio=generic.some(i=>i.effects.some(e=>e.type==='manaMissingRegen'))?Math.max(0,1-(hero.mp||0)/Math.max(1,hero.mpMax||1)):0;
  let managed=managedAttributes.get(hero.equipmentDynamicBase);
  if(!managed){managed=new Set(hero.equipmentDynamicBase.present);managedAttributes.set(hero.equipmentDynamicBase,managed);}
  const owns=id=>managed.has(id)||next[id]!==base[id];
  const changed=!!hero.attributes&&dynamicIds.some(id=>owns(id)&&hero.attributes[id]!==next[id]);
  // Once a temporary effect creates an optional field, this baseline owns its
  // restoration too. Otherwise an older actor retained temporary critical/hit
  // odds after expiry because the original loadout did not contain that field.
  if(hero.attributes)for(const id of dynamicIds)if(owns(id)){hero.attributes[id]=next[id];managed.add(id);}
  if(hero.attributes && next[31] !== undefined && hero.attributes[31] !== next[31]) hero.attributes[31]=next[31];
  if(changed)sim.event('equipment-passive-attributes',{id:hero.id,attributes:next});
  // Generic periodic recovery and auras are evaluated here rather than in
  // damage/heal code, which keeps them deterministic at the simulation tick.
  hero.equipmentDynamicCooldowns??={};
  for(const item of hero.passives?.generic||[]) for(const effect of item.effects||[]) {
    if(!battlefieldEffect(effect))continue;
    if(effect.type==='stealth') hero.effectUntargetable=sim.time-(hero.lastCombatAt??-Infinity)>=effect.delay;
    const key=`periodic:${item.itemId}:${effect.type}`;
    if(effect.type==='periodicHeal'||effect.type==='periodicMana') {
      const ready=hero.equipmentDynamicCooldowns[key]||0;
      if(ready<=sim.time){
        hero.equipmentDynamicCooldowns[key]=sim.time+Math.max(.05,effect.interval||1);
        const missing=effect.text?.includes('已损失');
        if(effect.type==='periodicHeal'){
          const nearby=effect.nearbyRadius?([...sim.entities.values()].filter(target=>target.alive&&target.kind==='hero'&&sim.enemies(hero,target)&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.nearbyRadius).length):0;
          const amount=Math.floor((missing?Math.max(0,hero.hpMax-hero.hp):hero.hpMax)*((effect.ratio||0)+nearby*(effect.nearbyRatio||0)));
          if(amount>0)sim.heal(hero,amount,{reason:'equipment-periodic'});
        } else {
          const amount=Math.floor((missing?Math.max(0,(hero.mpMax||0)-(hero.mp||0)):(hero.mpMax||0))*(effect.ratio||0));
          if(amount>0){const before=hero.mp||0;hero.mp=Math.min(hero.mpMax||before,before+amount);if(hero.mp>before)sim.event('mana',{id:hero.id,amount:hero.mp-before,reason:'equipment-periodic'});}
        }
      }
    }
    if(effect.type==='periodicHealFormula') {
      const ready=hero.equipmentDynamicCooldowns[key]||0;
      if(ready<=sim.time){
        hero.equipmentDynamicCooldowns[key]=sim.time+Math.max(.05,effect.interval||1);
        const ratio=(Number(effect.ratioBase||0)+Number(item.level||0)*Number(effect.ratioPerLevel||0))/100;
        const amount=Math.floor((hero.hpMax||0)*ratio);if(amount>0)sim.heal(hero,amount,{reason:'equipment-periodic'});
      }
    }
    // Gold text from the legacy arena/economy catalogue must never leak into
    // the Eternal Battlefield ruleset.  Battlefield gear with the explicit
    // mode marker has no periodic-gold effect; an arena host can opt in via
    // BattleSim({mode:'arena'}).
    if(effect.type==='periodicGold'&&(sim.economyMode==='arena'||sim.mode==='arena')) {
      const ready=hero.equipmentDynamicCooldowns[key]||0;
      if(ready<=sim.time){hero.equipmentDynamicCooldowns[key]=sim.time+Math.max(.05,effect.interval||10);hero.gold=(hero.gold||0)+Math.max(0,effect.amount||0);sim.event('passive',{id:hero.id,effect:'equipment-periodic-gold',itemId:item.itemId,amount:effect.amount||0});}
    }
    if(effect.type==='maxManaGrowth') {
      const key=`growth:${item.itemId}`;hero.equipmentDynamicCooldowns[key]??=sim.time+effect.interval;
      const ready=hero.equipmentDynamicCooldowns[key];
      if(ready<=sim.time){hero.equipmentDynamicCooldowns[key]=sim.time+effect.interval;hero.equipmentManaGrowth=Math.min(effect.cap||Infinity,(hero.equipmentManaGrowth||0)+(effect.amount||0));hero.mpMax=(hero.baseMPMax||hero.mpMax||0)+hero.equipmentManaGrowth;hero.mp=Math.min(hero.mpMax,hero.mp||0);}
    }
    if(effect.type==='onBasicPenStack'){
      const stacks=hero.buffs.filter(b=>b.slot===effectSlot(item.itemId,'penStack')).length;
      hero.equipmentPenetrationBonus=hero.buffs.filter(b=>b.slot===effectSlot(item.itemId,'penStack')).reduce((n,b)=>n+(b.penetration||0),0);
    }
    if(effect.type==='towerAuraDefense'){
      const towers=[...sim.entities.values()].filter(t=>t.alive&&t.team===hero.team&&t.kind==='tower'&&Math.hypot(hero.x-t.x,hero.z-t.z)<=Math.max(12,t.range||0));
      const bonus=towers.reduce((max,t)=>Math.max(max,Number(t.auraTier==='base'?effect.base:t.auraTier==='inner'?effect.inner:effect.middle)||0),0);
      const slot=effectSlot(item.itemId,'towerAura');hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
      if(bonus>0)hero.buffs.push({slot,until:sim.time+.25,armorBonus:bonus,magicResistanceBonus:bonus});
    }
    if(effect.type==='percentResist'){
      const slot=effectSlot(item.itemId,'percentResist');
      hero.buffs=hero.buffs.filter(b=>b.slot!==slot);
      const armor=Number((hero.armor??hero.attributes?.[42]??0)), magicResistance=Number((hero.magicResistance??hero.attributes?.[44]??0)), rate=Math.max(0,Number(effect.amount||0))/100;
      hero.buffs.push({slot,until:sim.time+.25,armorBonus:armor*rate,magicResistanceBonus:magicResistance*rate});
    }
    if(effect.type==='combatDamageStack'){
      const slot=effectSlot(item.itemId,'combatDamageStack');
      const activeBuff=hero.buffs.find(b=>b.slot===slot&&b.until>sim.time);
      const inCombat=sim.time-(hero.lastCombatAt??-Infinity)<=3;
      if(!inCombat){ hero.buffs=hero.buffs.filter(b=>b.slot!==slot); continue; }
      const ready=hero.equipmentDynamicCooldowns[key]||0;
      if(!activeBuff){ hero.buffs.push({slot,layers:0,damageBonus:0,until:sim.time+3}); }
      const current=hero.buffs.find(b=>b.slot===slot);
      if(current&&ready<=sim.time&&current.layers<(effect.max||10)){ current.layers++; current.damageBonus=current.layers*(effect.amount||0); current.until=sim.time+3; hero.equipmentDynamicCooldowns[key]=sim.time+Math.max(.05,effect.interval||.5); }
    }
    if(effect.type==='auraSlow') for(const target of sim.entities.values())
      if(sim.enemies(hero,target)&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.radius)debuff(sim,hero,target,item.itemId,{...effect,type:'auraSlow',aura:true,duration:.25});
    if(effect.type==='auraEnemyDebuff') for(const target of sim.entities.values()) if(sim.enemies(hero,target)&&(!effect.heroOnly||target.kind==='hero')&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.radius)
      debuff(sim,hero,target,item.itemId,{...effect,type:'auraEnemyDebuff',armorReduction:effect.armor,magicResistanceReduction:effect.magicResistance,aura:true,duration:.25});
    if(effect.type==='auraAttackReduction') for(const target of sim.entities.values()) if(sim.enemies(hero,target)&&(!effect.heroOnly||target.kind==='hero')&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.radius)
      debuff(sim,hero,target,item.itemId,{...effect,type:'auraAttackReduction',attackMultiplier:1-Number(effect.amount||0)/100,aura:true,duration:.25});
    if(effect.type==='auraFacingDebuff') for(const target of sim.entities.values()) if(sim.enemies(hero,target)&&(!effect.heroOnly||target.kind==='hero')&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.radius){
      const facing=target.targetId===hero.id;
      const armor=target.armor||target.attributes?.[42]||0,magicResistance=target.magicResistance||target.attributes?.[44]||0;
      debuff(sim,hero,target,item.itemId,{...effect,type:'auraFacingDebuff',
        attackMultiplier:facing?1-(effect.facingAttack||0)/100:1,
        abilityPowerReduction:facing?Math.floor((target.attributes?.[31]||0)*(effect.facingPower||0)/100):0,
        armorReduction:facing?0:armor*(effect.backArmor||0)/100,
        magicResistanceReduction:facing?0:magicResistance*(effect.backMagicResistance||0)/100,
        aura:true,duration:.25});
    }
    if(effect.type==='auraStats'||effect.type==='auraMoveSpeed'||effect.type==='auraRegen') for(const ally of sim.entities.values()) if(ally.alive&&ally.team===hero.team&&ally.kind==='hero'&&Math.hypot(hero.x-ally.x,hero.z-ally.z)<=effect.radius){
      if(effect.type==='auraStats'||effect.type==='auraMoveSpeed'){
        const slot=effectSlot(item.itemId,effect.type,ally.id);ally.buffs=ally.buffs.filter(b=>b.slot!==slot);ally.buffs.push({slot,until:sim.time+.25,armorBonus:effect.armor||0,magicResistanceBonus:effect.magicResistance||0,speed:1+(effect.speed||0)/100});
      }else{
        const key=`auraRegen:${item.itemId}:${ally.id}`,ready=hero.equipmentDynamicCooldowns[key]||0;
        if(ready<=sim.time){hero.equipmentDynamicCooldowns[key]=sim.time+Math.max(.05,effect.interval||5);sim.heal(ally,effect.amount||0,{reason:'equipment-aura'});}
      }
    }
  }
  // Magic-gem set descriptors are kept separate from numeric equipment
  // passives.  They still run through the same deterministic tick so a set
  // effect cannot depend on packet timing.
  for(const effect of magicEffects(hero)){
    const key=`${effect.setId}:${effect.effectId||0}:${effect.type}`;
    const elapsed=sim.time-(hero.lastCombatAt??-Infinity);
    if(effect.type==='magicGemOutCombatRegen'&&elapsed>=3){
      const ready=hero.magicGemCooldowns[key]||0;
      if(ready<=sim.time){
        hero.magicGemCooldowns[key]=sim.time+1;
        const max=effect.resource==='mp'?(hero.mpMax||0):(hero.hpMax||0), amount=Math.floor(max*Math.max(0,Number(effect.ratio)||0));
        if(amount>0){
          if(effect.resource==='mp'){const before=hero.mp||0;hero.mp=Math.min(hero.mpMax||before,before+amount);if(hero.mp>before)sim.event('mana',{id:hero.id,amount:hero.mp-before,reason:'magic-gem-set'});}
          else {const gained=sim.heal(hero,amount,{reason:'magic-gem-set'});if(gained)sim.event('passive',{id:hero.id,effect:'magic-gem-out-combat-regen',setId:effect.setId,amount:gained});}
        }
      }
    }
    if(effect.type==='magicGemBarrier'&&elapsed>=Number(effect.delay||0)){
      const slot=magicSlot(effect,'barrier');
      if(!hero.buffs.some(b=>b.slot===slot)&&!(hero.shield>0)){
        const ready=hero.magicGemCooldowns[key]||0;
        if(ready<=sim.time){
          hero.magicGemCooldowns[key]=sim.time+Math.max(1,Number(effect.delay)||1);
          sim.setShield(hero,Math.max(0,Math.floor(Number(effect.amount)||0)));
          sim.event('passive',{id:hero.id,effect:'magic-gem-barrier',setId:effect.setId,amount:Number(effect.amount)||0});
        }
      }
    }
    if(effect.type==='magicGemGuard'&&elapsed>=Number(effect.delay||0)){
      const slot=magicSlot(effect,'guard');
      if(!hero.buffs.some(b=>b.slot===slot))hero.buffs.push({slot,until:sim.time+.25,magicGemGuard:true,
        damageReductionPhysical:Number(effect.reduction)||0,damageReductionMagic:Number(effect.reduction)||0});
    }
    if(effect.type==='magicGemEnemyAura'){
      const rate=Math.max(0,Number(effect.resistance)||0)/100;
      for(const target of sim.entities.values())if(target.alive&&target.kind==='hero'&&sim.enemies(hero,target)&&Math.hypot(hero.x-target.x,hero.z-target.z)<=Number(effect.radius||0)){
        const armor=Number(target.armor??target.attributes?.[42]??0),mr=Number(target.magicResistance??target.attributes?.[44]??0);
        debuff(sim,hero,target,magicSlot(effect,'enemy-aura'),{type:'magicGemEnemyAura',armorReduction:armor*rate,magicResistanceReduction:mr*rate,aura:true,duration:.25});
      }
    }
    if(effect.type==='magicGemAllyAura'){
      const rate=Math.max(0,Number(effect.resistance)||0)/100;
      for(const ally of sim.entities.values())if(ally.alive&&ally.team===hero.team&&ally.kind==='hero'&&Math.hypot(hero.x-ally.x,hero.z-ally.z)<=Number(effect.radius||0)){
        const slot=magicSlot(effect,'ally-aura',ally.id);ally.buffs=ally.buffs.filter(b=>b.slot!==slot);
        ally.buffs.push({slot,until:sim.time+.25,armorBonus:Number(ally.armor??ally.attributes?.[42]??0)*rate,magicResistanceBonus:Number(ally.magicResistance??ally.attributes?.[44]??0)*rate});
      }
    }
    if(effect.type==='magicGemWalkTrap'){
      const last=hero.magicGemLastPosition||{x:hero.x||0,z:hero.z||0};
      const moved=Math.hypot((hero.x||0)-last.x,(hero.z||0)-last.z);hero.magicGemLastPosition={x:hero.x||0,z:hero.z||0};
      const distance=Math.max(1,Number(effect.distance)||1);hero.magicGemWalkDistance[key]=(hero.magicGemWalkDistance[key]||0)+moved;
      while(hero.magicGemWalkDistance[key]>=distance){hero.magicGemWalkDistance[key]-=distance;hero.magicGemTraps.push({effect,x:hero.x||0,z:hero.z||0,expires:sim.time+3});}
      hero.magicGemTraps=hero.magicGemTraps.filter(trap=>{
        if(trap.expires<=sim.time)return false;
        const target=[...sim.entities.values()].find(candidate=>candidate.alive&&sim.enemies(hero,candidate)&&Math.hypot((candidate.x||0)-trap.x,(candidate.z||0)-trap.z)<=Math.max(12,candidate.bodyRadius||0));
        if(!target)return true;
        const hit=magicRules.adaptive(hero,effect),amount=hit.amount;
        if(amount>0)sim.damage(hero,target,amount,524000+Number(effect.setId||0),hit.damageType,undefined,undefined,{equipmentProc:true,adRatio:hit.adRatio,apRatio:hit.apRatio});
        hero.magicGemTrapHits=hero.magicGemTrapHits.filter(at=>at>=sim.time-3);hero.magicGemTrapHits.push(sim.time);
        if(hero.magicGemTrapHits.length>=3){hero.magicGemTrapHits=[];debuff(sim,hero,target,magicSlot(effect,'walk-trap'),{type:'magicGemWalkTrap',slow:40,duration:1});}
        sim.event('passive',{id:hero.id,effect:'magic-gem-walk-trap',setId:effect.setId,target:target.id,amount});
        return false;
      });
    }
  }
  // Damage deadlines are independent of visible buff expiry. A timer step
  // can pass the last deadline after updateBuffs already removed the marker.
  const scheduledDots=magicDotsByHero.get(hero)||[];
  for(const buff of [...hero.buffs.filter(b=>!b.magicGemDot),...scheduledDots]) if(buff.dotTargetId!==undefined&&buff.dotNext<=sim.time+1e-9) {
    const target=sim.entities.get(buff.dotTargetId);
    const binding=magicDotBindings.get(buff);
    if(buff.magicGemDot){
      if(!binding||binding.sim!==sim||binding.source!==hero||sim.entities.get(hero.id)!==hero||!hero.alive||binding.sourceLife!==(hero.reviveCount||0)||binding.target!==target||binding.targetLife!==(target?.reviveCount||0)||!target?.alive){buff.dotFinished=true;hero.buffs=hero.buffs.filter(b=>b!==buff);continue;}
      while(!buff.dotFinished&&buff.dotNext<=Math.min(sim.time,buff.dotUntil)+1e-9){
        // Advance before damage: its hooks may call updateBuffs recursively.
        buff.dotNext+=buff.dotInterval||1;
        sim.damage(hero,target,buff.dotAmount,buff.dotSkillId,'magic',undefined,undefined,{equipmentProc:true});
        if(!target.alive||!hero.alive||sim.entities.get(target.id)!==target||sim.entities.get(hero.id)!==hero||binding.sourceLife!==(hero.reviveCount||0)||binding.targetLife!==(target.reviveCount||0))buff.dotFinished=true;
      }
      if(buff.dotNext>buff.dotUntil+1e-9)buff.dotFinished=true;
      if(buff.dotFinished)hero.buffs=hero.buffs.filter(b=>b!==buff);
      continue;
    }
    if(!target?.alive||buff.until<=sim.time){hero.buffs=hero.buffs.filter(b=>b!==buff);continue;}
    while(buff.dotNext<=sim.time+1e-9){buff.dotNext+=buff.dotInterval||1;sim.damage(hero,target,buff.dotAmount,buff.dotSkillId||1,buff.dotDamageType||'physical',undefined,undefined,{equipmentProc:true});}
  }
  magicDotsByHero.set(hero,(magicDotsByHero.get(hero)||[]).filter(b=>!b.dotFinished));
  for(const buff of [...hero.buffs]) if(buff.regenNext!==undefined&&buff.regenNext<=sim.time){
    while(buff.regenNext<=sim.time){if(buff.regenHp)sim.heal(hero,buff.regenHp,{reason:'equipment-combat-regen'});if(buff.regenMp){const before=hero.mp||0;hero.mp=Math.min(hero.mpMax||before,before+buff.regenMp);if(hero.mp>before)sim.event('mana',{id:hero.id,amount:hero.mp-before,reason:'equipment-combat-regen'});}buff.regenNext+=buff.regenInterval||1;}
    if(buff.until<=sim.time)hero.buffs=hero.buffs.filter(b=>b!==buff);
  }
  // Periodic artifact auras are evaluated once per second.  The text parser
  // only emits this effect for an explicit "每秒造成...伤害" sentence, so a
  // purely descriptive set bonus cannot accidentally become a damage source.
  for(const item of hero.passives?.generic||[]) for(const effect of item.effects||[]) if(effect.type==='auraDamage'){
    if(!battlefieldEffect(effect))continue;
    const key=`aura:${item.itemId}`,ready=hero.equipmentDynamicCooldowns?.[key]||0;
    if(ready>sim.time)continue;
    hero.equipmentDynamicCooldowns??={};hero.equipmentDynamicCooldowns[key]=sim.time+1;
    for(const target of sim.entities.values()) if(sim.enemies(hero,target)&&target.alive&&Math.hypot(hero.x-target.x,hero.z-target.z)<=effect.radius){
      const armor=hero.armor||hero.attributes?.[42]||0,magicResistance=hero.magicResistance||hero.attributes?.[44]||0;
      const rawAmount=Math.max(0,Math.floor(effect.amount!==undefined?effect.amount+Number(item.level||0)*(effect.levelAmount||0)+armor*(effect.armorRatio||0)+magicResistance*(effect.magicResistanceRatio||0)+(armor+magicResistance)*(effect.resistanceRatio||0):hero.hpMax*effect.ratio));
      const amount=Math.floor(rawAmount*(target.kind==='hero'||!effect.nonHeroBonus?1:1+Number(effect.nonHeroBonus||0)/100));
      if(effect.vulnerabilityPerStack&&target.kind==='hero'){
        const slot=effectSlot(item.itemId,'aura-vulnerability',target.id),old=target.buffs.find(b=>b.slot===slot&&b.until>sim.time),layers=Math.min(Number(effect.vulnerabilityMax||15),(old?.layers||0)+1);
        target.buffs=target.buffs.filter(b=>b.slot!==slot);target.buffs.push({slot,until:sim.time+Number(effect.vulnerabilityDuration||2.5),layers,damageTakenPercent:layers*Number(effect.vulnerabilityPerStack||0),negative:true,debuff:true});
      }
      if(amount){sim.damage(hero,target,amount,520000+item.itemId,effect.damageType||'magic',undefined,undefined,{equipmentProc:true,element:effect.element});const ratio=target.kind==='hero'?effect.healRatio:effect.nonHeroHealRatio;if(ratio)sim.heal(hero,Math.floor(amount*ratio),{reason:'equipment-aura'});}
    }
  }
  return changed;
}
function onBasicHit(sim,attacker,target,{amount=0,critical=false,criticalDamage,wasFullHP}={}){
  for(const item of attacker.passives?.generic||[]) for(const effect of item.effects||[]) if(effect.type==='basicStack'&&battlefieldEffect(effect)&&amount>0){
    attacker.equipmentStacks??={};attacker.equipmentPersistentStacks??={};
    const layers=Math.min(Number(effect.max||140),(attacker.equipmentStacks[item.itemId]||0)+(critical?Number(effect.critLayers||2):1));
    attacker.equipmentStacks[item.itemId]=layers;attacker.equipmentPersistentStacks[item.itemId]=layers;
    tick(sim,attacker);sim.updateBuffs(attacker);
    sim.event('passive',{id:attacker.id,effect:'equipment-basic-stack',itemId:item.itemId,layers,max:effect.max});
  }
  const rainbow=attacker.passives?.rainbow;
  if(rainbow&&target&&attacker.team!==target.team&&amount>0){
    const state=rainbowState(sim,attacker),now=sim.time;
    if(target.kind==='hero'&&state.hits===0&&state.procReadyAt<=now){
      state.hits=3;
      state.expires=now+3;
      attacker.buffs=attacker.buffs.filter(b=>b.slot!=='equipment:rainbow-speed');
      attacker.buffs.push({slot:'equipment:rainbow-speed',until:now+3,attackSpeed:200});
      sim.updateBuffs(attacker);
      attacker.equipmentDynamicCooldowns??={};
      state.procReadyAt=now+Math.max(0,25-(rainbow.level||0));attacker.equipmentDynamicCooldowns['rainbow:proc']=state.procReadyAt;
    }
    if(state.hits>0){
      const hitNumber=4-state.hits;state.hits--;
      if(hitNumber===1)debuff(sim,attacker,target,'30172',{type:'rainbow-first-hit',slow:50,duration:.5});
      if(hitNumber===3){
        const extra=Math.floor((attacker.attributes?.[30]||attacker.attackDamage||0)*2);
        if(extra>0)sim.damage(attacker,target,extra,520172,'true',undefined,undefined,{equipmentProc:true,equipmentProcs:false,basic:false,allowCritical:false});
      }
      if(state.hits===0){attacker.buffs=attacker.buffs.filter(b=>b.slot!=='equipment:rainbow-speed');sim.updateBuffs(attacker);}
    }
    state.healHits=(state.healHits||0)+1;
    if(state.healHits>=3){
      state.healHits=0;
      const healReady=state.healReadyAt;
      if(healReady<=now){
        state.healReadyAt=now+1;attacker.equipmentDynamicCooldowns??={};attacker.equipmentDynamicCooldowns['rainbow:heal']=state.healReadyAt;
        const gained=sim.heal(attacker,(attacker.attributes?.[30]||attacker.attackDamage||0)*.5,{reason:'equipment-rainbow-heal',ignoreHealingReduction:true});
        if(gained)sim.event('passive',{id:attacker.id,effect:'rainbow-heal',amount:gained});
      }
    }
    if(critical&&state.procReadyAt>now){state.procReadyAt=Math.max(now,state.procReadyAt-1.5);attacker.equipmentDynamicCooldowns['rainbow:proc']=state.procReadyAt;}
  }
  const first=attacker.buffs?.find(b=>b.firstHitDamage>0&&b.until>sim.time);
  if(first&&target?.alive){
    const extra=first.firstHitDamage+Object.entries(first.firstHitDamageScaling||{}).reduce((sum,[id,ratio])=>sum+(attacker.attributes?.[id]||0)*ratio,0);
    attacker.buffs=attacker.buffs.filter(b=>b!==first);sim.updateBuffs(attacker);
    if(extra>0)sim.damage(attacker,target,extra,500001,'physical',undefined,undefined,{equipmentProc:true});
    sim.event('passive',{id:attacker.id,effect:'equipment-first-hit',amount:extra});
  }
  const omen=attacker.passives?.omen;
  if(omen&&amount>0&&!['tower','base','barracks','fountain'].includes(target.kind)){
    const rate=7.5+omen.level/2;
    let gained=Math.floor(amount*rate/100);
    const full=wasFullHP??attacker.hp>=attacker.hpMax;
    if(omen.omenFullLifeShield&&full)
      gained+=Math.floor(amount*Math.max(0,Math.min(100,attacker.attributes?.[97]||0))/100);
    const cap=shieldCap(attacker);
    const before=attacker.shield||0;
    sim.setShield(attacker,Math.min(cap,before+gained));
    if(attacker.shield>before)sim.event('passive',{id:attacker.id,effect:'omen-shield',amount:attacker.shield-before,cap});
  }
  // This attack uses the lifesteal/critical stats it had before earning marks.
  // Newly reached bonuses affect subsequent attacks.
  const sword=attacker.passives?.sword;
  if(sword?.swordMarks&&target.kind==='hero'&&attacker.team!==target.team){
    const existing=attacker.buffs.find(b=>b.slot===markSlot&&b.until>sim.time);
    const extra=critical?Math.floor(Math.max(0,criticalDamage??attacker.attributes?.[25]??200)/100):0;
    const layers=Math.min(30,(existing?.layers||0)+1+extra);
    attacker.buffs=attacker.buffs.filter(b=>b.slot!==markSlot);
    attacker.buffs.push({slot:markSlot,layers,until:sim.time+3,attack:1+layers/100});
    tick(sim,attacker);sim.updateBuffs(attacker);
    sim.event('passive',{id:attacker.id,effect:'sword-marks',layers,expires:sim.time+3});
  }
  const pangu=attacker.passives?.pangu;
  if(pangu&&attacker.range<=2.5&&amount>0){
    const base=30+Math.floor(attacker.hpMax*.025);
    for(const other of sim.entities.values()){
      if(!sim.enemies(attacker,other)||Math.hypot(attacker.x-other.x,attacker.z-other.z)>3)continue;
      const splash=other.id===target.id?Math.floor(base/2):base;
      if(splash>0)sim.damage(attacker,other,splash,32144,'physical',undefined,undefined,{equipmentProc:true});
    }
    sim.event('passive',{id:attacker.id,effect:'pangu-splash',amount:base});
  }
  // Data driven effects cover the long tail of ordinary and artifact
  // equipment.  Their exact named rules can still add richer behaviour above.
  for(const item of attacker.passives?.generic||[]) for(const effect of item.effects||[]) {
    if(!battlefieldEffect(effect))continue;
    if(effect.type==='onBasicStackSlow'&&amount>0&&target?.alive){
      stackDebuff(sim,attacker,target,item,effect,attacker.range<=2.5?Number(effect.meleeLayers||1):1);
    }
    if(effect.type==='onPhysicalStackDebuff'&&amount>0&&target?.alive)stackDebuff(sim,attacker,target,item,effect,1);
    if((effect.type==='onDamageArmorReduction'||effect.type==='onDamageRoot')&&amount>0&&target?.alive&&(!effect.chance||sim.random()*100<effect.chance)){
      if(effect.type==='onDamageArmorReduction')debuff(sim,attacker,target,item.itemId,{...effect,armorReduction:effect.amount});
      else debuff(sim,attacker,target,item.itemId,{...effect,root:true});
    }
    if(effect.type==='onBasicSlow'&&amount>0&&target?.alive&&(!effect.chance||sim.random()*100<effect.chance)){
      const applied=effect.rangedSlow!==undefined&&attacker.range>2.5?{...effect,slow:effect.rangedSlow}:effect;
      debuff(sim,attacker,target,item.itemId,applied);
    }
    if(effect.type==='onBasicTrauma'&&amount>0&&target?.alive)debuff(sim,attacker,target,item.itemId,effect);
    if(effect.type==='onDamageSlow'&&amount>0&&target?.alive)debuff(sim,attacker,target,item.itemId,effect);
    if(effect.type==='onBasicMRReduction'&&amount>0&&target?.alive)debuff(sim,attacker,target,item.itemId,{...effect,magicResistanceReduction:effect.amount});
    if(effect.type==='grievous'&&amount>0&&target?.alive)debuff(sim,attacker,target,item.itemId,{...effect,healingReduction:effect.amount});
    if(effect.type==='onBasicPenStack'&&amount>0){const active=attacker.buffs.filter(b=>b.slot===effectSlot(item.itemId,'penStack'));attacker.buffs=attacker.buffs.filter(b=>b.slot!==effectSlot(item.itemId,'penStack'));const layers=Math.min(effect.max||3,active.length+1);for(let n=0;n<layers;n++)attacker.buffs.push({slot:effectSlot(item.itemId,'penStack'),until:sim.time+(effect.duration||3),penetration:effect.amount});sim.updateBuffs(attacker);}
    if(effect.type==='combatRegen'){const slot=effectSlot(item.itemId,'combatRegen');attacker.buffs=attacker.buffs.filter(b=>b.slot!==slot);attacker.buffs.push({slot,until:sim.time+effect.duration,regenHp:effect.hp||0,regenMp:effect.mp||0,regenInterval:Math.min(effect.hpInterval||5,effect.mpInterval||5),regenNext:sim.time+1});}
    if(effect.type==='damageMana'&&amount>0){const before=attacker.mp||0;attacker.mp=Math.min(attacker.mpMax||before,before+Math.floor(amount*(effect.ratio||0)));if(attacker.mp>before)sim.event('mana',{id:attacker.id,amount:attacker.mp-before,reason:'equipment-damage'});}
    if(effect.type==='onBasic'||effect.type==='onBasicDot') {
      if(amount<=0||!target?.alive)continue;
      if(effect.chance<100&&sim.random()*100>=effect.chance)continue;
      const basicCooldownKey=`basic:${item.itemId}`;
      if(effect.cooldown&&((attacker.equipmentDynamicCooldowns?.[basicCooldownKey]||0)>sim.time))continue;
      const targetHealthPercent=(effect.targetHealthPercent||0)+(effect.targetHealthPercentPerLevel||0)*Number(item.level||0);
      const fixedPenRatio=(effect.fixedPenRatio||0)+(effect.fixedPenRatioPerLevel||0)*Number(item.level||0);
      const adaptivePen=Math.max(Number(attacker.attributes?.[106]||0),Number(attacker.attributes?.[107]||0));
      const scales=effect.scalings||effect.scaling?[...(effect.scalings||[]),...(effect.scaling&&!effect.scalings?[effect.scaling]:[])]:[];
      const scaled=scales.reduce((sum,scale)=>sum+(attacker.attributes?.[scale.attr]||0)*scale.ratio,0);
      const bonus=Math.floor((targetHealthPercent?target.hp*targetHealthPercent/100:effect.amount)+(fixedPenRatio?adaptivePen*fixedPenRatio:0)+scaled);
      if(!(bonus>0))continue;
      if(effect.cooldown){attacker.equipmentDynamicCooldowns??={};attacker.equipmentDynamicCooldowns[basicCooldownKey]=sim.time+effect.cooldown;}
      if(effect.type==='onBasicDot'&&effect.duration>0){const slot=effectSlot(item.itemId,'dot',target.id);attacker.buffs=attacker.buffs.filter(b=>b.slot!==slot);attacker.buffs.push({slot,until:sim.time+effect.duration+1e-6,dotTargetId:target.id,dotAmount:bonus,dotSkillId:500000+item.itemId,dotDamageType:effect.damageType||'physical',dotNext:sim.time+1,dotInterval:effect.interval||1});}
      else sim.damage(attacker,target,bonus,500000+item.itemId,effect.damageType||'physical',undefined,undefined,{equipmentProc:true,element:effect.element});
      sim.event('passive',{id:attacker.id,effect:'equipment-on-basic',itemId:item.itemId,amount:bonus,damageType:effect.damageType||'physical'});
    }
  }
  for(const effect of magicEffects(attacker)){
    if(amount<=0||!target?.alive)continue;
    const key=`${effect.setId}:${effect.effectId||0}:${effect.type}`;
    if(effect.type==='magicGemSpeedSteal'){
      const ownSlot=magicSlot(effect,'speed-steal');
      const old=attacker.buffs.find(b=>b.slot===ownSlot&&b.until>sim.time), layers=Math.min(Number(effect.max)||10,(old?.layers||0)+1);
      attacker.buffs=attacker.buffs.filter(b=>b.slot!==ownSlot);attacker.buffs.push({slot:ownSlot,until:sim.time+(Number(effect.duration)||3),layers,speed:1+layers*(Number(effect.amount)||0)/100});
      const enemySlot=magicSlot(effect,'speed-steal-target',target.id);target.buffs=target.buffs.filter(b=>b.slot!==enemySlot);target.buffs.push({slot:enemySlot,until:sim.time+(Number(effect.duration)||3),layers,speed:Math.max(0,1-layers*(Number(effect.amount)||0)/100),negative:true,debuff:true});
      sim.updateBuffs(attacker);sim.updateBuffs(target);sim.event('passive',{id:attacker.id,effect:'magic-gem-speed-steal',setId:effect.setId,layers,target:target.id});
    }
    if(effect.type==='magicGemWeaknessProc'){
      const count=(attacker.magicGemCounters?.[key]||0)+1;attacker.magicGemCounters??={};attacker.magicGemCounters[key]=count;
      if(count>=Math.max(1,Number(effect.every)||1)){
        attacker.magicGemCounters[key]=0;
        const bonus=Math.floor((Number(effect.flat)||0)+magicRules.bonusAD(attacker)*(Number(effect.adRatio)||0)+(attacker.attributes?.[31]||0)*(Number(effect.apRatio)||0));
        if(bonus>0)sim.damage(attacker,target,bonus,520000+Number(effect.setId||0),'true',undefined,undefined,{equipmentProc:true,adRatio:Number(effect.adRatio)||0,apRatio:Number(effect.apRatio)||0});
        sim.event('passive',{id:attacker.id,effect:'magic-gem-weakness-proc',setId:effect.setId,amount:bonus});
      }
    }
    if(effect.type==='magicGemManaStrike'){
      const bonus=Math.floor((Number(effect.flat)||0)+(attacker.mpMax||0)*(Number(effect.manaRatio)||0));
      if(bonus>0)sim.damage(attacker,target,bonus,521000+Number(effect.setId||0),'magic',undefined,undefined,{equipmentProc:true});
    }
    if(effect.type==='magicGemAdaptiveStrike'){
      const hit=magicRules.adaptive(attacker,effect),bonus=hit.amount;
      if(bonus>0)sim.damage(attacker,target,bonus,522000+Number(effect.setId||0),hit.damageType,undefined,undefined,{equipmentProc:true,adRatio:hit.adRatio,apRatio:hit.apRatio});
    }
  }
  triggerWarSoulDamage(sim,attacker,target);
  entryCombat.onBasicHit(sim,attacker,target,{amount,basic:true});
}
function onSkillHit(sim,attacker,target,{amount=0,raw=amount,skillId=0,damageType='physical'}={}){
  if(!attacker?.alive||!target||amount<=0)return;
  for(const item of attacker.passives?.generic||[]) for(const effect of item.effects||[]) {
    if(!battlefieldEffect(effect))continue;
    if(effect.type==='onPhysicalStackDebuff'&&damageType==='physical'&&amount>0&&target.alive)stackDebuff(sim,attacker,target,item,effect,1);
    if(effect.type==='onSkillTrueBurn'&&amount>0&&target.alive){
      const total=Math.floor(Number(raw||amount)*Number(effect.ratio||0)),duration=Number(effect.duration||3),slot=effectSlot(item.itemId,'skill-true-burn',target.id);
      if(total>0){attacker.buffs=attacker.buffs.filter(b=>b.slot!==slot);attacker.buffs.push({slot,until:sim.time+duration+1e-6,dotTargetId:target.id,dotAmount:total/duration,dotSkillId:530000+item.itemId,dotDamageType:'true',dotNext:sim.time+1,dotInterval:1});sim.event('passive',{id:attacker.id,effect:'equipment-skill-true-burn',itemId:item.itemId,target:target.id,total});}
    }
    if(effect.type==='onDamageArmorReduction'&&target.alive)debuff(sim,attacker,target,item.itemId,{...effect,armorReduction:effect.amount});
    if(effect.type==='onSkillSlow'&&target.alive&&(!effect.chance||sim.random()*100<effect.chance))debuff(sim,attacker,target,item.itemId,effect);
    if(effect.type==='onSkillRoot'&&target.alive&&(!effect.chance||sim.random()*100<effect.chance))debuff(sim,attacker,target,item.itemId,{...effect,root:true});
    if(effect.type==='onDamageSlow'&&target.alive)debuff(sim,attacker,target,item.itemId,effect);
    if(effect.type==='onSkillMRReduction'&&target.alive)debuff(sim,attacker,target,item.itemId,{...effect,magicResistanceReduction:effect.percent?(target.magicResistance||0)*effect.amount/100:effect.amount});
    if(effect.type==='grievous'&&target.alive)debuff(sim,attacker,target,item.itemId,{...effect,healingReduction:effect.amount});
    if(effect.type==='damageMana'&&amount>0){const before=attacker.mp||0;attacker.mp=Math.min(attacker.mpMax||before,before+Math.floor(amount*(effect.ratio||0)));if(attacker.mp>before)sim.event('mana',{id:attacker.id,amount:attacker.mp-before,reason:'equipment-damage'});}
    if(effect.type!=='onSkill')continue;
    if(effect.chance<100&&sim.random()*100>=effect.chance)continue;
    const bonus=Math.floor((effect.amount||0)+((attacker.attributes?.[effect.scaling?.attr]||0)*(effect.scaling?.ratio||0)));
    if(!(bonus>0))continue;
    sim.damage(attacker,target,bonus,510000+item.itemId,effect.damageType||'magic',undefined,undefined,{equipmentProc:true,element:effect.element});
    sim.event('passive',{id:attacker.id,effect:'equipment-on-skill',itemId:item.itemId,skillId,amount:bonus,damageType:effect.damageType||'magic'});
  }
  for(const effect of magicEffects(attacker))if(effect.type==='magicGemSkillBurn'&&target.alive&&target.kind==='hero'&&sim.enemies(attacker,target)){
    const key=`${effect.setId}:${effect.effectId||0}:${effect.type}`,ready=attacker.magicGemCooldowns?.[key]||0;
    if(ready<=sim.time){
      attacker.magicGemCooldowns??={};attacker.magicGemCooldowns[key]=sim.time+(Number(effect.cooldown)||12);
      const slot=magicSlot(effect,'skill-burn',target.id);attacker.buffs=attacker.buffs.filter(b=>b.slot!==slot);
      const until=sim.time+(Number(effect.duration)||7);
      const buff={slot,until,dotUntil:until,magicGemDot:true,dotTargetId:target.id,dotAmount:Math.floor((target.hpMax||0)*(Number(effect.ratio)||0)),dotSkillId:523000+Number(effect.setId||0),dotDamageType:'magic',dotNext:sim.time+1,dotInterval:1};
      const pending=magicDotsByHero.get(attacker)||[];
      for(const old of pending)if(old.slot===slot)old.dotFinished=true;
      magicDotsByHero.set(attacker,[...pending.filter(b=>!b.dotFinished),buff]);
      magicDotBindings.set(buff,{sim,source:attacker,sourceLife:attacker.reviveCount||0,target,targetLife:target.reviveCount||0});attacker.buffs.push(buff);
      sim.event('passive',{id:attacker.id,effect:'magic-gem-skill-burn',setId:effect.setId,target:target.id});
    }
  }
  triggerWarSoulDamage(sim,attacker,target);
}
function onHeal(sim,source,target,gained=0){
  if(!source?.alive||!target?.alive||source.id===target.id||!(gained>0))return;
  for(const item of source.passives?.generic||[])for(const effect of item.effects||[])if(battlefieldEffect(effect)&&effect.type==='onAllyHealBuff'){
    const slot=effectSlot(item.itemId,'allyHeal',target.id);
    const value=Math.max(0,Math.floor((target.attributes?.[effect.attr]||0)*(effect.percent||0)/100)+(effect.flat||0));
    if(!(value>0))continue;
    target.buffs=target.buffs.filter(b=>b.slot!==slot);
    target.buffs.push({slot,until:sim.time+(effect.duration||3),attackBonus:effect.attr===30?value:0,abilityPower:effect.attr===31?value:0});
    sim.updateBuffs(target);
    sim.event('passive',{id:source.id,target:target.id,effect:'equipment-ally-heal-buff',itemId:item.itemId,attribute:effect.attr,amount:value,until:sim.time+(effect.duration||3)});
  }
}
function onDamageTaken(sim,target,attacker,{amount=0,basic=false}={}){
  if(!target?.alive||!attacker?.alive||amount<=0)return;
  target.lastDamagedAt=sim.time;
  for(const item of target.passives?.generic||[])for(const effect of item.effects||[]) {
    if(!battlefieldEffect(effect))continue;
    if(effect.type==='onDamagedSlow'&&(!effect.chance||sim.random()*100<effect.chance))debuff(sim,target,attacker,item.itemId,effect);
    if(effect.type==='damageMana'&&amount>0){const before=target.mp||0;target.mp=Math.min(target.mpMax||before,before+Math.floor(amount*(effect.ratio||0)));if(target.mp>before)sim.event('mana',{id:target.id,amount:target.mp-before,reason:'equipment-damage'});}
    if(effect.type==='combatRegen'){const slot=effectSlot(item.itemId,'combatRegen');target.buffs=target.buffs.filter(b=>b.slot!==slot);target.buffs.push({slot,until:sim.time+effect.duration,regenHp:effect.hp||0,regenMp:effect.mp||0,regenInterval:Math.min(effect.hpInterval||5,effect.mpInterval||5),regenNext:sim.time+1});}
    if(effect.type==='onDamagedBasic'&&!basic)continue;
    if(effect.type==='onDamagedBasic'){
      const cooldownKey=`reflect:${item.itemId}`;
      if((target.equipmentDynamicCooldowns?.[cooldownKey]||0)>sim.time)continue;
      target.equipmentDynamicCooldowns??={};target.equipmentDynamicCooldowns[cooldownKey]=sim.time+.25;
      const reflected=Math.max(0,Math.floor(effect.amount+(amount*effect.ratio/100)+((target.attributes?.[effect.scaling?.attr]||0)*(effect.scaling?.ratio||0))));
      if(reflected>0&&attacker.alive)sim.damage(target,attacker,reflected,600000+item.itemId,'magic',undefined,undefined,{equipmentProc:true});
      sim.event('passive',{id:target.id,effect:'equipment-reflect',itemId:item.itemId,amount:reflected});
    }else if(effect.type==='lowHealthShield'&&target.hp>0&&target.hp/target.hpMax*100<effect.threshold){
      const key=`shield:${item.itemId}`;
      target.equipmentDynamicCooldowns??={};
      if((target.equipmentDynamicCooldowns[key]||0)<=sim.time){
        target.equipmentDynamicCooldowns[key]=sim.time+60;
        const value=Math.floor(effect.amount+(target.hpMax*effect.ratio/100));
        if(value>0){sim.setShield(target,Math.max(target.shield||0,value));sim.event('passive',{id:target.id,effect:'equipment-low-health-shield',itemId:item.itemId,amount:value});}
      }
    }
  }
  for(const effect of magicEffects(target)){
    if(effect.type==='magicGemDamageStack'){
      const slot=magicSlot(effect,'damage-stack');const old=target.buffs.find(b=>b.slot===slot&&b.until>sim.time),layers=Math.min(Number(effect.max)||10,(old?.layers||0)+1);
      target.buffs=target.buffs.filter(b=>b.slot!==slot);target.buffs.push({slot,until:sim.time+(Number(effect.duration)||2.5),layers,attack:1+layers*(Number(effect.attack)||0)/100,abilityPower:layers*(Number(effect.abilityPower)||0),speed:1+layers*(Number(effect.speed)||0)/100});
      sim.updateBuffs(target);sim.event('passive',{id:target.id,effect:'magic-gem-damage-stack',setId:effect.setId,layers});
    }
    if(effect.type==='magicGemLowHealthBarrier'&&target.hp>0&&target.hp/Math.max(1,target.hpMax)*100<Number(effect.threshold||70)){
      const key=`${effect.setId}:${effect.effectId||0}:${effect.type}`;target.magicGemCooldowns??={};
      if((target.magicGemCooldowns[key]||0)<=sim.time){target.magicGemCooldowns[key]=sim.time+60;const resource=Math.max(target.hpMax||0,target.mpMax||0),cap=Math.max(target.attributes?.[30]||target.attackDamage||0,target.attributes?.[31]||0),amount=Math.floor(Math.min(resource*(Number(effect.ratio)||0),cap));if(amount>0&&!(target.shield>0)){const slot=magicSlot(effect,'low-health-barrier');target.buffs=target.buffs.filter(b=>b.slot!==slot);const buff={slot,until:sim.time+6,magicGemShieldHeal:true,magicGemShieldHealRemaining:amount,progressionOwned:true,setId:114,sourceId:target.id,nativeStatusId:34334};target.buffs.push(buff);magicLowHealthShields.set(target,{sim,life:target.reviveCount||0,key,buff});sim.setShield(target,amount);sim.event('passive',{id:target.id,effect:'magic-gem-low-health-barrier',setId:effect.setId,amount});}}
    }
    if(effect.type==='magicGemGuard')target.buffs=target.buffs.filter(b=>!(b.magicGemGuard&&b.until>sim.time));
  }
  triggerWarSoulTaken(sim,target);
  entryCombat.onDamageTaken(sim,target,attacker,{amount,basic});
}
function equipmentRecovery(sim,hero,item,effect,reason){
  const missing=Math.max(0,(hero.hpMax||0)-(hero.hp||0));
  const level=Math.max(0,Number(item.level||0));
  const amount=Math.max(0,Math.floor((effect.amount||0)+missing*((effect.lostRatio||0)+level*(effect.lostRatioPerLevel||0))/100));
  const gained=sim.heal(hero,amount,{reason});
  if(gained)sim.event('passive',{id:hero.id,effect:`equipment-${reason}-heal`,itemId:item.itemId,amount:gained});
  return gained;
}
function onKill(sim,killer,target){
  const progression=require('./battle-progression-effects');
  progression.onKill(sim,killer,target,{attackerLife:killer?.reviveCount,
    hasBattleMage:progression.battleMageEquipped(killer?.loadout?.slots||[],require('./current-item-catalog').load().byId)});
  if(killer?.passives?.genesis){
    const state=genesisState(sim,killer);genesisCooldown(sim,killer,state.cooldownUntil-2);
  }
  for(const item of killer?.passives?.generic||[])for(const effect of item.effects||[]) {
    if(!battlefieldEffect(effect))continue;
    // Keep every on-kill clause independent.  A single item may restore both
    // resources and add a stack; an else-if chain silently dropped all but the
    // first parsed sentence.
    if(effect.type==='onKillHeal'&&!(effect.heroOnly&&target?.kind!=='hero')){
      equipmentRecovery(sim,killer,item,effect,'kill');
    }
    if(effect.type==='onKillMana'){
      const before=killer.mp||0;killer.mp=Math.min(killer.mpMax||before,before+Math.max(0,effect.amount||0));
      if(killer.mp>before)sim.event('passive',{id:killer.id,effect:'equipment-kill-mana',itemId:item.itemId,amount:killer.mp-before});
    }
    // Kill/assist bounty text belongs to the arena economy.  The ordinary
    // Eternal Battlefield simulator deliberately has no per-hero reward wallet;
    // only an explicitly arena-scoped host may apply these parsed effects.
    if(effect.type==='onKillGold'&&(sim.economyMode==='arena'||sim.mode==='arena')){
      const eligible=!(effect.heroOnly&&target.kind!=='hero')&&!(effect.nonHeroOnly&&target.kind==='hero');
      if(eligible){
        killer.equipmentKillCounts??={};
        const count=killer.equipmentKillCounts[item.itemId]||0;
        if(!effect.maxKills||count<effect.maxKills){
          killer.equipmentKillCounts[item.itemId]=count+1;
          killer.gold=(killer.gold||0)+Math.max(0,effect.amount||0);sim.event('passive',{id:killer.id,effect:'equipment-kill-gold',itemId:item.itemId,amount:effect.amount||0,count:count+1});
        }
      }
    }
    if(effect.type==='onKillStack'){
      killer.equipmentStacks??={};killer.equipmentStacks[item.itemId]=Math.min(effect.max||Infinity,(killer.equipmentStacks[item.itemId]||0)+(effect.killLayers||1));sim.updateBuffs(killer);
    }
  }
}
function onAssist(sim,assistant,target,killer){
  if(!assistant?.alive||!target||assistant.id===killer?.id)return;
  if(assistant.passives?.genesis){
    const state=genesisState(sim,assistant);genesisCooldown(sim,assistant,state.cooldownUntil-1);
  }
  for(const item of assistant.passives?.generic||[])for(const effect of item.effects||[]) {
    if(!battlefieldEffect(effect))continue;
    if(effect.type==='onAssistHeal'&&!(effect.heroOnly&&target.kind!=='hero'))equipmentRecovery(sim,assistant,item,effect,'assist');
    if(effect.type==='onKillStack'&&effect.assistLayers){
      assistant.equipmentStacks??={};
      assistant.equipmentStacks[item.itemId]=Math.min(effect.max||Infinity,
        (assistant.equipmentStacks[item.itemId]||0)+effect.assistLayers);
      sim.updateBuffs(assistant);
    }
  }
}
function onDeath(sim,target,attacker){
  if(!target?.alive)return false;
  const genesis=genesisState(sim,target);if(genesis)genesis.hits=[];
  const rainbow=rainbowState(sim,target);if(rainbow){rainbow.hits=0;rainbow.healHits=0;}
  const lowShield=magicLowHealthShields.get(target);if(lowShield)lowShield.buff.until=sim.time;expireMagicLowHealthShield(sim,target);
  delete target.warSoulShieldExpires;delete target.warSoulShieldAmount;
  for(const effect of magicEffects(target))if(effect.type==='magicGemLowHealthBarrier'){
    const key=`${effect.setId}:${effect.effectId||0}:${effect.type}`;if(target.magicGemCooldowns)delete target.magicGemCooldowns[key];
  }
  target.magicGemTraps=[];target.magicGemTrapHits=[];
  for(const item of target.passives?.generic||[])for(const effect of item.effects||[])if(battlefieldEffect(effect)&&effect.type==='onKillStack'&&target.equipmentStacks?.[item.itemId]){
    target.equipmentStacks[item.itemId]=Math.max(0,Math.floor(target.equipmentStacks[item.itemId]*2/3));
  }
  for(const item of target.passives?.generic||[])for(const effect of item.effects||[])if(battlefieldEffect(effect)&&effect.type==='revive'){
    const key=`revive:${item.itemId}`;target.equipmentDynamicCooldowns??={};
    if((target.equipmentDynamicCooldowns[key]||0)>sim.time)continue;
    const cooldown=Math.max(0,Number(effect.cooldown||60)-Number(item.level||0)*Number(effect.cooldownPerLevel||0));
    target.equipmentDynamicCooldowns[key]=sim.time+cooldown;
    const restored=reviveValues(effect,item,target);
    if(effect.delay>0){
      target.pendingEquipmentRevive={at:sim.time+effect.delay,itemId:item.itemId,heal:restored.hp,mana:restored.mp,attacker:attacker?.id};
      sim.event('equipment-revive-pending',{id:target.id,itemId:item.itemId,at:sim.time+effect.delay});
      return false;
    }
    target.alive=true;target.hp=Math.max(1,Math.min(target.hpMax,Math.floor(restored.hp>0?restored.hp:target.hpMax)));
    target.mp=Math.max(0,Math.min(target.mpMax||0,Math.floor(restored.mp>0?restored.mp:target.mpMax||0)));target.reviveCount=(target.reviveCount||0)+1;target.respawnAt=Infinity;
    sim.setShield(target,0);sim.event('equipment-revive',{id:target.id,itemId:item.itemId,attacker:attacker?.id,at:sim.time});
    sim.updateBuffs(target);return true;
  }
  return false;
}
module.exports={install,tick,onBasicHit,onSkillHit,onHeal,onDamageTaken,onCommittedDamage,beforeActive,onKill,onAssist,onDeath,markSlot};
