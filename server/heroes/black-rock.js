'use strict';
const B=require('../black-rock-shooter');
const ids=new Set([2850,2854,2837,2838]),cooldownFirst=new Set([2843,2848,2849,2850,2854]);
module.exports={
  heroId:101,name:'black-rock-shooter',
  isInstalled:entity=>!!entity.blackRock,
  affects:entity=>!!entity.blackRockDebuffs,
  install:B.install,ownsSkill:(_sim,_entity,skill)=>B.owns(skill),
  resolveSkill:(_sim,entity,value)=>B.resolveSkill(entity,value),validateCast:B.validateCast,applyCast:B.applyCast,
  modifiers:B.modifiers,tick:B.tick,canAct:B.canAct,onControl:B.onControl,onRespawn:B.onRespawn,
  basicAttackSkill:B.basicAttackSkill,onAttackStart:B.onAttackStart,onBasicHit:B.onBasicHit,
  managesBasicAttack:true,basicPierceWidth:()=>B.RULES.qPierceWidth,
  onLeave(_sim,entity){
    const state=entity.blackRock;
    if(state){state.pending=[];state.inFlight=[];state.castingUntil=0;state.shooter=null;state.r=null;}
  },
  reduceExtraCooldowns(sim,entity,step,rate){
    const shooter=entity.blackRock?.shooter;
    if(shooter&&entity.cooldowns.ShooterShot>sim.time){
      entity.cooldowns.ShooterShot=Math.max(sim.time,entity.cooldowns.ShooterShot-step*rate);
      shooter.nextAt=Math.min(shooter.nextAt,entity.cooldowns.ShooterShot);
    }
  },
  world:{onCast:B.onEnemyCast,onDeath:B.onDeath},
  native:{
    castPosition(event,entity,skill){return ids.has(skill.id)?event.castOrigin??entity:undefined;},
    cooldownFirst:(_event,_entity,skill)=>cooldownFirst.has(skill.id),
    damagePresentation(entity,event){
      return event.shotId===undefined?require('../black-rock-projectiles').damagePresentation(entity,event):null;
    },
    sync:(sim,entity,options)=>require('../black-rock-native').sync(sim,entity,options),
    beforeCast(sim,entity,event,skill){
      return event.type==='cast'&&[2843,2848,2849].includes(skill.id)?
        require('../black-rock-native').sync(sim,entity):[];
    },
    cooldownState:(_entity,command,playerId)=>require('../black-rock-native').cooldownState(playerId,command),
    isProjectileEvent:(_entity,event)=>event.type==='brs-projectile',
    projectile:(entity,event,id)=>require('../black-rock-projectiles').launch(entity,
      {skill:event.skill,aim:event.aim,id,time:event.time}),
    basicProjectile:(entity,shot,id)=>require('../black-rock-projectiles').launchBasic(entity,
      {shot,id,time:shot.time}),
    tickProjectile:(state,time)=>require('../black-rock-projectiles').tick(state,time),
    updateProjectile:(state,update)=>require('../black-rock-projectiles').updateMovement(state,update),
    finishProjectile:state=>require('../black-rock-projectiles').finish(state),
  }
};
