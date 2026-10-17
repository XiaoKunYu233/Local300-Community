'use strict';
const equipment=require('./battle-equipment'),native=require('./hero-bootstrap-native');
const profiles=require('./research/hero-combat-20261010/base-profiles/profile-loader').load();
const summoners=require('./summoner-effects');
const point=value=>value&&[value.x,value.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
// A combat baseline is not a complete player bootstrap or a playable hero.
// Caller timing is required: raw speed, shake and fly-delay do not by
// themselves establish melee/ranged mode, overlap or attack-speed scaling.
function create(sim,{id,heroId,level,team,position,skinId=0,loadout,timing,
  summonerSkills,installBehavior=false,heroOptions={}}={}){
  if(!sim?.heroes||sim.heroes.closed||sim.winner!==null||!Number.isInteger(id)||id<1||id>0xffffffff||sim.entities.has(id)||
    ![1,2,3].includes(team)||!point(position)||!Number.isInteger(skinId)||skinId<0||skinId>31||
    typeof installBehavior!=='boolean')throw Error('Invalid hero combat baseline identity');
  const input=profiles.inputs(heroId),profile=profiles.get(heroId),attack=input.attackRow;
  const base=profiles.attributes(heroId,level,equipment.heroBase);
  if(!timing||!Number.isFinite(timing.attackWindup)||timing.attackWindup<0||
    !Number.isFinite(timing.projectileSpeed)||timing.projectileSpeed<0||
    typeof timing.evidence!=='string'||!timing.evidence.trim())throw Error('Explicit hero attack timing policy required');
  if(!loadout||!Array.isArray(loadout.slots))throw Error('Hero baseline requires a loadout snapshot');
  for(const key of ['magicGemEffects','warSoulEffects'])if(loadout[key]!==undefined&&!Array.isArray(loadout[key]))
    throw Error('Invalid hero baseline effect snapshot');
  if(summonerSkills!==undefined&&!summoners.validSelection(summonerSkills,252))throw Error('Invalid hero summoner selection');
  if(installBehavior&&!sim.heroes.registry.get(heroId))throw Error('Hero behavior is not registered');
  const calculated=equipment.calculate(base,loadout),interval=10000/(calculated[130]*calculated[15]);
  if(!Number.isFinite(interval)||interval<=0)throw Error('Invalid current hero attack speed');
  const skills=summonerSkills?Object.fromEntries(['D','F'].map(slot=>[slot,summoners.definition(summonerSkills[slot])])):{};
  const eventStart=sim.events.length,entity=sim.add({id,heroId,skinId,kind:'hero',team,x:position.x,z:position.z,level,
    hpMax:calculated[8],hp:calculated[8],mpMax:calculated[9],mp:calculated[9],
    bodyRadius:profile.hero.named.fBodySize,range:attack.fRange,speed:calculated[129]/100,
    attackDamage:calculated[30],attackInterval:interval,attackSkillId:input.commonAttackSkillID,
    attackSkillLevel:attack.nLevel,attackWindup:timing.attackWindup,projectileSpeed:timing.projectileSpeed,
    attackProfiles:{[input.commonAttackSkillID]:{range:attack.fRange,attackWindup:timing.attackWindup,projectileSpeed:timing.projectileSpeed}},
    attackTimingPolicy:{...timing},rawAttackTiming:{shakeMs:attack.nSkillShakeTime,flyDelayMs:attack.nFlyDelayTime,
      prepareMs:attack.nPrepareTime,flyTime:attack.nFlyTime,speed:attack.fSpeed},skills,
    reviveStatus:native.statusReset({id,heroId,skinId}),equipmentBase:base,attributes:{...calculated},loadout});
  let behaviorInstalled=false,behaviorAttempted=false;
  try{
    if(installBehavior){behaviorAttempted=true;behaviorInstalled=sim.heroes.install(entity,heroOptions);
      if(!behaviorInstalled)throw Error('Hero behavior refused baseline installation');}
    // Refused hero installation must occur before equipment can apply auras
    // or other effects to existing actors. Cleanup is not a world transaction.
    equipment.apply(sim,entity,calculated,loadout,{initial:true});
  }catch(error){
    let cleanupError;
    try{if(behaviorAttempted)sim.heroes.registry.get(heroId)?.onLeave?.(sim,entity);}catch(failure){cleanupError=failure;}
    finally{sim.entities.delete(id);sim.events.splice(eventStart);}
    if(cleanupError)throw new AggregateError([error,cleanupError],'Hero baseline initialization and cleanup failed');
    throw error;
  }
  return {entity,behaviorInstalled,scope:'base-attributes-and-host-timed-normal-attack',
    completePlayerBootstrap:false,heroComplete:false,sourceHeroId:profile.heroId};
}
module.exports={create};
