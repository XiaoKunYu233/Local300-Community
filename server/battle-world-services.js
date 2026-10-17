'use strict';
const navigation=require('./battle-navigation');
const point=p=>p&&[p.x,p.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const current=(sim,e,life=e?.reviveCount)=>!sim.heroes.closed&&sim.entities.get(e?.id)===e&&e?.alive&&e.reviveCount===life;
const invisible=e=>e.invisible===true||e.effectInvisible===true||e.stealthed===true;

// This is an explicit base policy, not a reconstruction of the client fog map.
// Reveal leases validate both actors and lives; a copied handle grants nothing.
class BattleVision {
  #sim;#leases=new Map();#policy;#closed=false;
  constructor(sim,{sourceRadius=10,visibleToTeam}={}){
    if(!Number.isFinite(sourceRadius)||sourceRadius<0||visibleToTeam!==undefined&&typeof visibleToTeam!=='function')throw Error('Invalid battle vision policy');
    this.#sim=sim;this.#policy={sourceRadius,visibleToTeam};
    this.policy=Object.freeze({id:'explicit-circular-base-vision',sourceRadius,terrainOcclusion:false,provider:!!visibleToTeam});
  }
  reveal(owner,target,duration,{revealInvisible=false}={}){
    if(this.#closed||!current(this.#sim,owner)||!current(this.#sim,target)||!Number.isFinite(duration)||duration<=0||typeof revealInvisible!=='boolean')throw Error('Invalid reveal lease');
    const handle=Object.freeze({ownerId:owner.id,targetId:target.id,team:owner.team,until:this.#sim.time+duration});
    this.#leases.set(handle,{owner,target,ownerLife:owner.reviveCount,targetLife:target.reviveCount,revealInvisible});return handle;
  }
  release(handle){return this.#leases.delete(handle);}
  tick(){for(const [handle,lease]of this.#leases)if(handle.until<=this.#sim.time||lease.owner.team!==handle.team||!current(this.#sim,lease.owner,lease.ownerLife)||!current(this.#sim,lease.target,lease.targetLife))this.#leases.delete(handle);}
  visibleToTeam(entity,team){
    if(this.#closed||!current(this.#sim,entity)||![1,2,3].includes(team))return false;
    this.tick();if(entity.team===team)return true;
    for(const [handle,lease]of this.#leases)if(lease.target===entity&&handle.team===team&&(!invisible(entity)||lease.revealInvisible))return true;
    if(invisible(entity))return false;
    return this.#baseVisible(entity,team);
  }
  visibleCorpseToTeam(entity,team){
    if(this.#closed||this.#sim.heroes.closed||this.#sim.entities.get(entity?.id)!==entity||entity?.kind!=='hero'||entity.alive||
      ![1,2,3].includes(team)||entity.battleBot&&!entity.bot?.entered||!(entity.respawnAt>this.#sim.time))return false;
    if(entity.team===team)return true;
    return this.#baseVisible(entity,team);
  }
  #baseVisible(entity,team){
    if(this.#policy.visibleToTeam){const result=this.#policy.visibleToTeam(entity,team,this.#sim);if(typeof result!=='boolean')throw Error('Vision provider must return a boolean');return result;}
    return [...this.#sim.entities.values()].some(source=>source.team===team&&current(this.#sim,source)&&['hero','minion','tower'].includes(source.kind)&&
      distance(source,entity)<=(Number.isFinite(source.visionRadius)&&source.visionRadius>=0?source.visionRadius:this.#policy.sourceRadius));
  }
  close(){this.#closed=true;this.#leases.clear();}
}

class BattleObjects {
  #sim;#leases=new Map();#handles=new WeakMap();#closed=false;
  constructor(sim){this.#sim=sim;}
  create(owner,{kind,position,duration,onInteract,interactionSkillIds=[]}={}){
    if(this.#closed||!current(this.#sim,owner)||typeof kind!=='string'||!kind||!point(position)||!Number.isFinite(duration)||duration<=0||typeof onInteract!=='function'||
      !Array.isArray(interactionSkillIds)||interactionSkillIds.some(id=>!Number.isInteger(id)||id<=0||id>65535))throw Error('Invalid interactive battle object');
    while(this.#sim.entities.has(this.#sim.nextId)||this.#leases.has(this.#sim.nextId))this.#sim.nextId++;
    if(this.#sim.nextId>0xffffffff)throw Error('Battle object identities exhausted');
    const handle=Object.freeze({id:this.#sim.nextId++,ownerId:owner.id,kind,position:Object.freeze({x:position.x,z:position.z}),expiresAt:this.#sim.time+duration});
    const lease={handle,owner,life:owner.reviveCount,onInteract,interactionSkillIds:new Set(interactionSkillIds)};
    this.#leases.set(handle.id,lease);this.#handles.set(handle,lease);this.#sim.event('object-create',{id:handle.id,ownerId:owner.id,kind,position:{...handle.position},expiresAt:handle.expiresAt});return handle;
  }
  #valid(lease){return !this.#closed&&lease&&current(this.#sim,lease.owner,lease.life)&&lease.handle.expiresAt>this.#sim.time&&!this.#sim.entities.has(lease.handle.id);}
  get(id){const lease=this.#leases.get(id);if(!this.#valid(lease)){if(lease)this.remove(lease.handle,'expired-or-owner-lost');return null;}return lease.handle;}
  owned(owner,id){const handle=this.get(id),lease=handle&&this.#leases.get(id);return lease?.owner===owner?handle:null;}
  accepts(owner,id,skillId){return !!this.owned(owner,id)&&this.#leases.get(id).interactionSkillIds.has(skillId);}
  interact(owner,id){const handle=this.owned(owner,id);if(!handle)return {ok:false,reason:'invalid-interaction-owner'};
    const result=this.#leases.get(id).onInteract(this.#sim,owner,handle);
    if(!result||typeof result.ok!=='boolean')throw Error('Invalid battle object interaction result');return result;
  }
  remove(handle,reason='removed'){
    const lease=this.#handles.get(handle);if(!lease||this.#leases.get(handle.id)!==lease)return false;
    this.#leases.delete(handle.id);
    if(!this.#closed&&!this.#sim.heroes.closed)this.#sim.event('object-remove',{id:handle.id,ownerId:handle.ownerId,kind:handle.kind,reason});return true;
  }
  tick(){for(const lease of [...this.#leases.values()])this.get(lease.handle.id);}
  close(){this.#closed=true;this.#leases.clear();}
}

function traceDisplacement(sim,entity,goal,{mode='push',ignoreIds=[]}={}){
  if(!current(sim,entity)||sim.winner!==null||!point(goal)||!['push','dash','blink'].includes(mode)||!Array.isArray(ignoreIds)||ignoreIds.some(id=>!Number.isInteger(id)||id<=0||id>0xffffffff))return {ok:false,blocked:true,reason:'invalid-displacement'};
  const start={x:entity.x,z:entity.z},radius=entity.bodyRadius||0;
  if(mode==='blink'){
    try{const position=sim.freeSpawn(goal,radius,entity.id);return {ok:true,position,blocked:distance(position,goal)>1e-6,reason:'landing',mode};}
    catch{return {ok:false,position:start,blocked:true,reason:'no-landing',mode};}
  }
  const ignore=new Set([entity.id,...ignoreIds]);
  const circles=[...sim.entities.values()].filter(other=>!ignore.has(other.id)&&other.bodyRadius>0&&(other.alive||['tower','base','barracks','fountain'].includes(other.kind)))
    .map(other=>({x:other.x,z:other.z,r:radius+other.bodyRadius+.02}));
  const clear=p=>navigation.segmentClear(start,p,circles)&&(!sim.terrain||sim.terrain.segment(start,p,radius));
  const length=distance(start,goal),steps=Math.max(1,Math.ceil(length/.1));let fraction=0;
  for(let i=1;i<=steps;i++){
    const next=i/steps,p={x:start.x+(goal.x-start.x)*next,z:start.z+(goal.z-start.z)*next};
    if(!clear(p)){let low=fraction,high=next;for(let n=0;n<18;n++){const middle=(low+high)/2,c={x:start.x+(goal.x-start.x)*middle,z:start.z+(goal.z-start.z)*middle};if(clear(c))low=middle;else high=middle;}
      const position={x:start.x+(goal.x-start.x)*low,z:start.z+(goal.z-start.z)*low};return {ok:true,position,blocked:true,reason:'collision',mode};}
    fraction=next;
  }
  return {ok:true,position:{x:goal.x,z:goal.z},blocked:false,reason:'clear',mode};
}
module.exports={BattleVision,BattleObjects,traceDisplacement};
