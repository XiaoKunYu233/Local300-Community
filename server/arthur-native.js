'use strict';
const D=require('./arthur-native-data'),N=require('./battle-native'),B=require('./black-rock-projectiles');
const catalog=require('./battle-status-native').create({statuses:D.statuses,allowed:D.statuses.map(r=>({statusId:Number(r[1]),level:Number(r[2])}))});
const previous=new WeakMap(),beams=new WeakSet(),scopes=new WeakMap();let nextScope=0;
function states(sim,e){const out=new Map(),s=e.arthur;
 const add=(id,level,until,owner=e,overlap=1)=>{if(until>sim.time){const old=out.get(id);if(!old||old.until<until)out.set(id,{statusId:id,level,until,sourceId:owner.id,sourceHeroId:owner.heroId,sourceSkinId:owner.skinId||0,overlap});}};
 if(!e.alive)return [];
 if(s){add(11891,1,Infinity);if(s.levels.W)add(11888,s.levels.W,Infinity);if(s.q)add(11886,s.levels.Q,s.q.until);
  if(s.count)add(11887,5,Infinity,e,s.count);if(s.passiveReady>sim.time)add(11893,1,s.passiveReady);
  if(s.heal){add(11892,1,s.heal.until);add(11899,1,s.heal.until);}
  if(s.r){add(11897,1,s.r.until);add(11900,1,s.r.until);if(sim.time>=s.r.start+1)add(11880,1,s.r.until);}}
 for(const b of e.buffs||[])if(b.arthur&&b.statusId&&b.targetLife===e.reviveCount&&sim.entities.get(b.owner?.id)===b.owner&&b.owner.alive&&b.ownerLife===b.owner.reviveCount)add(b.statusId,b.statusRank,b.until,b.owner);
 return [...out.values()];
}
function sync(sim,e,{force=false}={}){if(!scopes.has(sim))scopes.set(sim,'arthur:'+ ++nextScope);const result=catalog.diff(force?null:previous.get(e),{scope:scopes.get(sim),life:e.reviveCount||0,targetId:e.id,entries:states(sim,e)},sim.time);previous.set(e,result.state);return result.packets;}
function beam(e,event,id){const r=event.modelJob;if(e.arthur?.r!==r||r.done||r.life!==e.reviveCount)return null;
 const endpoint={x:Math.max(0,Math.min(655.35,r.origin.x+r.dir.x*38)),z:Math.max(0,Math.min(655.35,r.origin.z+r.dir.z*38))};
 const state={id,owner:e,life:e.reviveCount,job:r,done:false};beams.add(state);
 const packet=B.spawnFrame('E',{id,owner:e.id,team:e.team,...r.origin,endpoint,bullet:531,reference:531,directionRaw:[Math.round(r.dir.x*100),Math.round(r.dir.z*100)],movementWord:0,speed:1,flags:[80,1,0]});
 return {state,packets:[packet]};
}
function finishBeam(state){if(!beams.has(state)||state.done)return [];state.done=true;return [N.remove(state.id)];}
function tickBeam(state,time){if(!beams.has(state))return [];if(state.job.done||state.owner.arthur?.r!==state.job||!state.owner.alive||state.owner.reviveCount!==state.life||time>=state.job.until)return finishBeam(state);return [];}
module.exports={states,sync,beam,tickBeam,finishBeam,catalog};
