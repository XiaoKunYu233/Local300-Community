'use strict';
// Native 23442 carries an ordered D/F pair, including swapping two used IDs.
// Account choices are separate from entitlement selections: they grant nothing.
const rules=require('./summoner-effects');
const uint=n=>Number.isInteger(n)&&n>0&&n<=0xffffffff;
const clock=n=>Number.isSafeInteger(n)&&n>=0;
const pair=skills=>skills&&typeof skills==='object'&&!Array.isArray(skills)&&
  Object.keys(skills).length===2&&Object.hasOwn(skills,'D')&&Object.hasOwn(skills,'F');
const copy=skills=>({D:skills.D,F:skills.F});
function identity(account){
  if(!uint(account?.uid)||!uint(account.playerId)||!clock(account.revision))throw Error('Invalid summoner selection account identity');
}
function validate(state,account){
  identity(account);
  if(!state||state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||
    !state.byMap||typeof state.byMap!=='object'||Array.isArray(state.byMap))throw Error('Invalid saved summoner selection');
  for(const [map,row]of Object.entries(state.byMap)){
    if(!uint(+map)||String(+map)!==map||!row||!clock(row.savedAt)||
      !pair(row.skills)||!rules.validSelection(row.skills,+map))throw Error('Invalid saved map summoner selection');
  }
  return state;
}
function read(account,mapId,fallback){
  identity(account);
  if(!uint(mapId)||!pair(fallback)||!rules.validSelection(fallback,mapId))throw Error('Invalid summoner selection defaults');
  if(account.summonerSelection!==undefined)validate(account.summonerSelection,account);
  return copy(account.summonerSelection?.byMap[mapId]?.skills||fallback);
}
function request(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt32LE(4)!==0||
    frame.readUInt16LE(8)!==23442||frame.readUInt16LE(10)!==0)throw Error('Invalid native summoner selection request');
  return {D:frame.readUInt16LE(12),F:frame.readUInt16LE(14)};
}
function isReorder(current,next){
  return pair(current)&&pair(next)&&(current.D===next.D&&current.F===next.F||current.D===next.F&&current.F===next.D);
}
function prepare(account,frame,context,now=Date.now()){
  identity(account);const skills=request(frame);
  if(!context||context.authenticated!==true||context.available!==true||context.uid!==account.uid||
    context.playerId!==account.playerId||!uint(context.mapId)||!['selecting','preparing','playing'].includes(context.phase)||
    !clock(now)||!rules.validSelection(skills,context.mapId))throw Error('Summoner selection requires an available authenticated map session');
  if(context.phase==='playing'&&!isReorder(context.currentSkills,skills)&&!(context.entity?.id===context.playerId&&talentAvailable(context.sim,context.entity,context.mapId)))throw Error('Playing summoner changes require active godsend6 or a reorder');
  if(account.summonerSelection!==undefined)validate(account.summonerSelection,account);
  return {version:1,uid:account.uid,playerId:account.playerId,mapId:context.mapId,skills,
    expectedRevision:account.revision,preparedAt:now};
}
function apply(account,prepared,now=Date.now()){
  identity(account);
  if(!prepared||prepared.version!==1||prepared.uid!==account.uid||prepared.playerId!==account.playerId||
    prepared.expectedRevision!==account.revision||!clock(prepared.preparedAt)||!clock(now)||now<prepared.preparedAt||
    !uint(prepared.mapId)||!pair(prepared.skills)||!rules.validSelection(prepared.skills,prepared.mapId))
    throw Error('Summoner selection draft revision or identity mismatch');
  if(account.summonerSelection!==undefined)validate(account.summonerSelection,account);
  const state=account.summonerSelection??={version:1,uid:account.uid,playerId:account.playerId,byMap:{}};
  state.byMap[prepared.mapId]={skills:copy(prepared.skills),savedAt:now};validate(state,account);
  return copy(prepared.skills);
}
// The same skill objects and absolute ready times follow their new buttons.
// A channel remains bound to its real spell, and all other slots stay intact.
function swapPlan(entity,skills){
  const current={D:entity?.skills?.D?.id,F:entity?.skills?.F?.id};
  if(!pair(skills)||!isReorder(current,skills)||!entity.cooldowns||!rules.definition(current.D)||
    !rules.definition(current.F)||current.D===current.F)throw Error('Invalid live summoner reorder');
  return {entity,oldD:entity.skills.D,oldF:entity.skills.F,skills:copy(skills),swapped:current.D!==skills.D,
    oldCooldownD:entity.cooldowns.D,oldCooldownF:entity.cooldowns.F,
    hadCooldownD:Object.hasOwn(entity.cooldowns,'D'),hadCooldownF:Object.hasOwn(entity.cooldowns,'F'),
    channel:entity.channel,channelSlot:entity.channel?.slot};
}
function applySwap(entity,plan){
  if(!plan||plan.entity!==entity||entity.skills.D!==plan.oldD||entity.skills.F!==plan.oldF||
    entity.cooldowns.D!==plan.oldCooldownD||entity.cooldowns.F!==plan.oldCooldownF||
    entity.channel!==plan.channel||entity.channel?.slot!==plan.channelSlot)throw Error('Live summoner reorder changed before commit');
  if(!plan.swapped)return copy(plan.skills);
  [entity.skills.D,entity.skills.F]=[entity.skills.F,entity.skills.D];
  if(plan.hadCooldownF)entity.cooldowns.D=plan.oldCooldownF;else delete entity.cooldowns.D;
  if(plan.hadCooldownD)entity.cooldowns.F=plan.oldCooldownD;else delete entity.cooldowns.F;
  if(['D','F'].includes(entity.channel?.slot))entity.channel.slot=entity.channel.slot==='D'?'F':'D';
  return copy(plan.skills);
}
// Off-button spells retain their real objects and absolute ready times within
// this world. Neither changing buttons nor unequipping the rune clears them.
// This ledger is deliberately not account data and cannot leak to another match.
const spellLedgers=new WeakMap();
function talentAvailable(sim,entity,mapId=sim?.mapId){
  return mapId===252&&sim?.mapId===mapId&&sim.entities?.get(entity?.id)===entity&&entity?.kind==='hero'&&require('./battle-progression-effects').hasGodsend(entity,6);
}
function changePlan(sim,entity,skills){
  const current={D:entity?.skills?.D?.id,F:entity?.skills?.F?.id};
  if(isReorder(current,skills))return {kind:'reorder',sim,entity,plan:swapPlan(entity,skills)};
  if(!pair(skills)||!rules.validSelection(skills,sim?.mapId)||!talentAvailable(sim,entity)||!entity.cooldowns||!rules.validSelection(current,sim.mapId))throw Error('Live replacement requires active godsend6');
  const ledger=spellLedgers.get(entity),pool=new Map(ledger?.sim===sim?ledger.spells:[]);
  for(const slot of ['D','F'])pool.set(entity.skills[slot].id,{skill:entity.skills[slot],hadCooldown:Object.hasOwn(entity.cooldowns,slot),readyAt:entity.cooldowns[slot]});
  for(const slot of ['D','F'])if(!pool.has(skills[slot]))pool.set(skills[slot],{skill:rules.definition(skills[slot]),hadCooldown:false,readyAt:undefined});
  return {kind:'replace',sim,entity,life:entity.reviveCount,skills:copy(skills),pool,oldD:entity.skills.D,oldF:entity.skills.F,
    oldCooldownD:entity.cooldowns.D,oldCooldownF:entity.cooldowns.F,hadCooldownD:Object.hasOwn(entity.cooldowns,'D'),hadCooldownF:Object.hasOwn(entity.cooldowns,'F'),
    channel:entity.channel,channelSlot:entity.channel?.slot,ledger};
}
function applyChange(sim,entity,plan){
  if(plan?.sim!==sim||plan.entity!==entity||sim.entities.get(entity.id)!==entity)throw Error('Live summoner world changed before commit');
  if(plan.kind==='reorder')return applySwap(entity,plan.plan);
  if(plan.kind!=='replace'||!talentAvailable(sim,entity)||entity.reviveCount!==plan.life||spellLedgers.get(entity)!==plan.ledger||entity.skills.D!==plan.oldD||entity.skills.F!==plan.oldF||
    entity.cooldowns.D!==plan.oldCooldownD||entity.cooldowns.F!==plan.oldCooldownF||Object.hasOwn(entity.cooldowns,'D')!==plan.hadCooldownD||Object.hasOwn(entity.cooldowns,'F')!==plan.hadCooldownF||
    entity.channel!==plan.channel||entity.channel?.slot!==plan.channelSlot)throw Error('Live summoner replacement changed before commit');
  // The already committed channel keeps its original spell and target even
  // when that spell leaves both buttons. Native end messages use this object.
  if(entity.channel){entity.channel.skill??=plan.pool.get(entity.channel.skillId)?.skill;const slot=['D','F'].find(s=>plan.skills[s]===entity.channel.skillId);if(slot)entity.channel.slot=slot;}
  for(const slot of ['D','F']){const record=plan.pool.get(plan.skills[slot]);entity.skills[slot]=record.skill;if(record.hadCooldown)entity.cooldowns[slot]=record.readyAt;else delete entity.cooldowns[slot];}
  spellLedgers.set(entity,{sim,spells:plan.pool});return copy(plan.skills);
}
module.exports={validate,read,request,prepare,apply,isReorder,swapPlan,applySwap,talentAvailable,changePlan,applyChange};
