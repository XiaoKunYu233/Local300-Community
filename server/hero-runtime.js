'use strict';
const {combine}=require('./battle-effect-stats');
const attached=new WeakMap();
const hooks=['install','isInstalled','affects','ownsSkill','resolveSkill','validateCast','applyCast',
  'modifiers','tick','canAct','onMoveOrder','onControl','onRespawn','basicAttackSkill','onAttackStart','onBasicHit',
  'modifyIncomingDamage','beforeDamage','onDamage','onDamageTaken','onLeave','basicPierceWidth','reduceExtraCooldowns','observerView'];
class HeroRegistry {
  #definitions=new Map();
  constructor(definitions=[]){for(const definition of definitions)this.register(definition);}
  register(definition){
    if(!definition||!Number.isInteger(definition.heroId)||definition.heroId<=0||definition.heroId>65535||
      typeof definition.install!=='function')throw Error('Invalid hero behavior definition');
    if(this.#definitions.has(definition.heroId))throw Error('Hero behavior already registered');
    for(const key of hooks)if(definition[key]!==undefined&&typeof definition[key]!=='function')
      throw Error('Invalid hero hook '+key);
    if(definition.managesBasicAttack!==undefined&&typeof definition.managesBasicAttack!=='boolean')
      throw Error('Invalid hero basic attack policy');
    for(const group of ['world','native'])if(definition[group]!==undefined){
      if(!definition[group]||typeof definition[group]!=='object')throw Error('Invalid hero '+group+' hooks');
      for(const value of Object.values(definition[group]))if(typeof value!=='function')throw Error('Invalid hero '+group+' hook');
    }
    const entry=Object.freeze({...definition,
      world:Object.freeze({...definition.world}),native:Object.freeze({...definition.native})});
    this.#definitions.set(entry.heroId,entry);return entry;
  }
  get(heroId){return this.#definitions.get(heroId)||null;}
  definitions(){return [...this.#definitions.values()];}
  ids(){return [...this.#definitions.keys()];}
}
const defaultRegistry=new HeroRegistry([require('./heroes/black-rock'),require('./arthur-hero')]);
function nativeFor(entity){
  if(!entity)return null;
  const attachedDefinition=attached.get(entity);
  if(attachedDefinition&&attachedDefinition.heroId===entity.heroId)return attachedDefinition.native;
  const definition=defaultRegistry.get(entity.heroId);
  return definition?.isInstalled?.(entity)?definition.native:null;
}
class HeroRuntime {
  constructor(sim,registry=defaultRegistry){
    if(!sim?.entities||!(registry instanceof HeroRegistry))throw Error('Invalid hero runtime');
    this.sim=sim;this.registry=registry;this.bound=new WeakMap();this.projectilePolicies=new WeakMap();
    this.synchronizedPolicies=new WeakMap();
  }
  behavior(entity){
    if(this.closed||!entity||this.sim.entities.get(entity.id)!==entity)return null;
    const bound=this.bound.get(entity);
    if(bound?.heroId===entity.heroId)return bound;
    const definition=this.registry.get(entity.heroId);
    return definition?.isInstalled?.(entity)?definition:null;
  }
  install(entity,options={}){
    if(this.closed)throw Error('Hero runtime is closed');
    if(!entity||this.sim.entities.get(entity.id)!==entity)throw Error('Hero belongs to another combat world');
    const definition=this.registry.get(entity.heroId);if(!definition)return false;
    if(definition.install(this.sim,entity,options)===false)return false;
    this.bound.set(entity,definition);attached.set(entity,definition);return true;
  }
  handlers(entity){
    if(this.closed||!entity||this.sim.entities.get(entity.id)!==entity)return [];
    const own=this.behavior(entity),out=own?[own]:[];
    for(const definition of this.registry.definitions())
      if(definition!==own&&definition.affects?.(entity))out.push(definition);
    return out;
  }
  modifiers(entity){return combine(...this.handlers(entity).map(definition=>definition.modifiers?.(this.sim,entity)));}
  tick(entity,step){for(const definition of this.handlers(entity))definition.tick?.(this.sim,entity,step);}
  canAct(entity,action,detail){return this.behavior(entity)?.canAct?.(this.sim,entity,action,detail)!==false;}
  observerView(entity,viewer){if(!viewer||this.sim.entities.get(viewer.id)!==viewer)return null;return this.behavior(entity)?.observerView?.(this.sim,entity,viewer)||null;}
  onMoveOrder(entity,goal){return this.behavior(entity)?.onMoveOrder?.(this.sim,entity,{x:goal.x,z:goal.z});}
  ownsSkill(entity,skill){return !!this.behavior(entity)?.ownsSkill?.(this.sim,entity,skill);}
  resolveSkill(entity,value){return this.behavior(entity)?.resolveSkill?.(this.sim,entity,value)||null;}
  validateCast(entity,skill,aim){return this.behavior(entity)?.validateCast?.(this.sim,entity,skill,aim)||
    {ok:false,reason:'unknown-hero-skill'};}
  applyCast(entity,skill,aim){return this.behavior(entity)?.applyCast?.(this.sim,entity,skill,aim)||
    {ok:false,reason:'unknown-hero-skill'};}
  onControl(entity,reason){return this.behavior(entity)?.onControl?.(this.sim,entity,reason);}
  onRespawn(entity){return this.behavior(entity)?.onRespawn?.(this.sim,entity);}
  basicAttackSkill(entity,target){return this.behavior(entity)?.basicAttackSkill?.(this.sim,entity,target)??entity.attackSkillId;}
  managesBasicAttack(entity){return !!this.behavior(entity)?.managesBasicAttack;}
  onAttackStart(entity,target){return this.behavior(entity)?.onAttackStart?.(this.sim,entity,target)||{};}
  onBasicHit(entity,target,event){
    if(!entity?.alive||this.sim.entities.get(entity.id)!==entity||this.sim.entities.get(target?.id)!==target||
      event.attackerLife!==undefined&&event.attackerLife!==entity.reviveCount||event.targetLife!==undefined&&event.targetLife!==target.reviveCount)return;
    this.behavior(entity)?.onBasicHit?.(this.sim,entity,target,event);
  }
  basicPierceWidth(entity){return this.behavior(entity)?.basicPierceWidth?.(this.sim,entity)??.4;}
  reduceExtraCooldowns(entity,step,rate){
    const result=this.behavior(entity)?.reduceExtraCooldowns?.(this.sim,entity,step,rate);
    if(result===undefined)return new Set();
    if(!result||!Array.isArray(result.managedSlots)||result.managedSlots.some(slot=>typeof slot!=='string'||!slot||
      !Object.hasOwn(entity.cooldowns,slot))||new Set(result.managedSlots).size!==result.managedSlots.length)
      throw Error('Invalid hero managed cooldown slots');
    return new Set(result.managedSlots);
  }
  beforeDamage(target,attacker,hit){
    let received=hit.received,absorbed=0,blocked=false;
    if(!attacker||this.sim.entities.get(attacker.id)!==attacker)return {received,absorbed,blocked};
    const handlers=this.handlers(target);
    // All active incoming amplifications precede every recipient's skill
    // defense. Keeping amplification inside a foreign defense hook made its
    // amount depend on whether the victim's own shield ran first.
    for(const definition of handlers){
      const result=definition.modifyIncomingDamage?.(this.sim,target,attacker,
        Object.freeze({...hit,received,phase:'post-mitigation-before-hero-defense'}));
      if(result===undefined||result===null)continue;
      if(typeof result!=='object'||Array.isArray(result)||!Number.isFinite(result.received)||result.received<0||
        result.absorbed!==undefined||result.blocked!==undefined)throw Error('Invalid hero incoming damage decision');
      received=Math.floor(result.received+1e-9);
    }
    for(const definition of handlers){
      const result=definition.beforeDamage?.(this.sim,target,attacker,
        Object.freeze({...hit,received,absorbed,blocked,phase:'post-mitigation-before-shields'}));
      if(result===undefined||result===null)continue;
      if(typeof result!=='object'||Array.isArray(result))throw Error('Invalid hero damage decision');
      const next=result.received??received,extra=result.absorbed??0;
      if(!Number.isFinite(next)||next<0||!Number.isFinite(extra)||extra<0||
        (result.blocked!==undefined&&typeof result.blocked!=='boolean'))throw Error('Invalid hero damage decision');
      received=Math.floor(next+1e-9);absorbed+=extra;blocked=blocked||result.blocked===true;
    }
    return {received,absorbed,blocked};
  }
  onDamage(attacker,target,event){
    const sourceCurrent=()=>attacker?.alive&&this.sim.entities.get(attacker.id)===attacker&&(event.attackerLife===undefined||attacker.reviveCount===event.attackerLife);
    const targetCurrent=()=>this.sim.entities.get(target?.id)===target&&(event.targetLife===undefined||target.reviveCount===event.targetLife);
    if(sourceCurrent()&&targetCurrent())this.behavior(attacker)?.onDamage?.(this.sim,attacker,target,{...event,sourceCurrent:true});
    if(targetCurrent())this.behavior(target)?.onDamageTaken?.(this.sim,target,attacker,{...event,sourceCurrent:!!sourceCurrent()});
  }
  worldEvent(name,subject,...args){
    if(this.closed||!subject||this.sim.entities.get(subject.id)!==subject)return;
    const active=new Set([...this.sim.entities.values()].map(entity=>this.behavior(entity)).filter(Boolean));
    for(const definition of this.registry.definitions())
      if(active.has(definition)||definition.affects?.(subject))definition.world[name]?.(this.sim,subject,...args);
  }
  actionObservers(name,actor,subject,context={}){
    if(this.closed||!actor||this.sim.entities.get(actor.id)!==actor)return;
    const actorLife=context.attackerLife??actor.reviveCount,targetLife=context.targetLife??(name==='onAttackStart'?subject?.reviveCount:undefined);
    const sourceCurrent=()=>this.sim.entities.get(actor.id)===actor&&actor.reviveCount===actorLife&&!!actor.alive;
    const recipients=new Map([...this.sim.entities.values()].map(e=>[e,e.reviveCount]));
    const recipientCurrent=e=>recipients.has(e)&&this.sim.entities.get(e.id)===e&&e.reviveCount===recipients.get(e);
    const active=new Set([...this.sim.entities.values()].map(e=>this.behavior(e)).filter(Boolean));
    for(const definition of this.registry.definitions()){
      if(!sourceCurrent())break;
      if(active.has(definition)||definition.affects?.(actor))definition.world[name]?.(this.sim,actor,subject,Object.freeze({...context,
        attackerLife:actorLife,targetLife,sourceCurrent:true,recipientCurrent,
        targetCurrent:name==='onAttackStart'?this.sim.entities.get(subject?.id)===subject&&subject?.reviveCount===targetLife&&!!subject?.alive:undefined}));
    }
  }
  onCast(caster,skill,context){this.actionObservers('onCast',caster,skill,context);}
  notifyAttackStart(attacker,target,context){this.actionObservers('onAttackStart',attacker,target,context);}
  onDeath(killer,victim,context){
    if(this.closed||!victim||this.sim.entities.get(victim.id)!==victim)return;
    const sourceLife=context?.attackerLife??killer?.reviveCount,victimLife=context?.targetLife??victim.reviveCount;
    const recipients=new Map([...this.sim.entities.values()].map(entity=>[entity,entity.reviveCount]));
    const recipientCurrent=entity=>recipients.has(entity)&&this.sim.entities.get(entity.id)===entity&&entity.reviveCount===recipients.get(entity);
    const active=new Set([...this.sim.entities.values()].map(entity=>this.behavior(entity)).filter(Boolean));
    for(const definition of this.registry.definitions())
      if(active.has(definition)||definition.affects?.(victim))definition.world.onDeath?.(this.sim,killer,victim,Object.freeze({...context,
        attackerLife:sourceLife,targetLife:victimLife,recipientCurrent,
        sourceCurrent:context?.sourceCurrent!==false&&!!killer?.alive&&this.sim.entities.get(killer.id)===killer&&killer.reviveCount===sourceLife,
        targetCurrent:this.sim.entities.get(victim.id)===victim&&victim.reviveCount===victimLife}));
  }
  nativePolicy(entity){return this.behavior(entity)?.native||null;}
  nativeSync(entity,options){
    if(this.closed||!entity||this.sim.entities.get(entity.id)!==entity)return [];
    const policies=new Set(this.synchronizedPolicies.get(entity)||[]);
    for(const definition of this.handlers(entity))if(definition.native.sync)policies.add(definition.native);
    // Retain former observers so their private diff cache can remove a state
    // after affects() becomes false. Weak entity keys keep worlds isolated.
    this.synchronizedPolicies.set(entity,policies);
    return [...policies].flatMap(policy=>policy.sync(this.sim,entity,options)||[]);
  }
  beforeNativeCast(entity,event,skill,options){return this.nativePolicy(entity)?.beforeCast?.(this.sim,entity,event,skill,options)||[];}
  nativeCooldownState(entity,command,playerId){
    if(this.closed||!entity||this.sim.entities.get(entity.id)!==entity||entity.id!==playerId)return null;
    return this.nativePolicy(entity)?.cooldownState?.(entity,command,playerId)??
      require('./skill-slot-native').cooldownState(playerId,command);
  }
  isProjectileEvent(entity,event){return !!entity&&(event.ownerLife===undefined||event.ownerLife===entity.reviveCount)&&!!this.nativePolicy(entity)?.isProjectileEvent?.(entity,event);}
  projectile(entity,event,id,basic=false){
    if(event.ownerLife!==undefined&&event.ownerLife!==entity?.reviveCount)return null;
    const policy=this.nativePolicy(entity),factory=basic?policy?.basicProjectile:policy?.projectile;
    const result=factory?.(entity,event,id);
    if(result?.state)this.projectilePolicies.set(result.state,policy);
    return result||null;
  }
  tickProjectile(state,time){return this.projectilePolicies.get(state)?.tickProjectile?.(state,time)||[];}
  updateProjectile(state,update){return this.closed?[]:this.projectilePolicies.get(state)?.updateProjectile?.(state,update)||[];}
  finishProjectile(state){return this.projectilePolicies.get(state)?.finishProjectile?.(state)||[];}
  close(){
    if(this.closed)return;
    const cleanup=[...this.sim.entities.values()].map(entity=>({entity,definition:this.behavior(entity)}));
    this.closed=true;const errors=[];
    this.sim.objects?.close();this.sim.vision?.close();
    for(const {entity,definition}of cleanup)try{definition?.onLeave?.(this.sim,entity);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Hero cleanup failed');
  }
}
module.exports={HeroRegistry,HeroRuntime,defaultRegistry,nativeFor};
