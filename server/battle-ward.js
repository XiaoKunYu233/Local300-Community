'use strict';
const W=require('./battle-wire'),B=require('./battle-protocol'),N=require('./battle-native');
// Clean original 6052 spawn (match002); no captured attached buffs are retained.
const TEMPLATE=Buffer.from('7000000041bc26ff1a04000015000500cfc8d6aa00a026e02600640a000a030000000300000000000000000000000000000000000000000000a41700001c00000000080008000f00b7c2c9fab5dba4ceb1b1b7bdbdb400023ffc3120ffff09640065d10000b4000000b4000000000000','hex');
const skill=Object.freeze({id:8034,level:1,cooldown:150,mana:0,type:'ward'});
function spawn(ward,owner){
 const source=B.readSpawn(TEMPLATE),p=TEMPLATE.subarray(12),name=Buffer.concat([owner.nameBytes||require('./gbk').encode(owner.name||'Player'),Buffer.from([0])]);
 const head=Buffer.from(p.subarray(0,source.offset+51));head.writeUInt16LE(name.length,source.offset+49);
 const tail=Buffer.from(p.subarray(source.teamOffset));tail[0]=owner.team;tail.writeUInt32LE(owner.id,1);tail.writeUInt32LE(ward.skinItem||0,10);
 tail.writeUInt32LE(ward.duration,14);tail.writeUInt32LE(ward.duration,18);
 return N.spawn(W.frame(1050,source.id,Buffer.concat([head,name,tail])),ward);
}
function cast(sim,owner,aim){
 if(!owner||sim.active(owner.id)!==owner||owner.kind!=='hero')return {ok:false,reason:'dead-or-finished'};
 if(!aim||![aim.x,aim.z].every(v=>Number.isFinite(v)&&v>=0&&v<=655.35))return {ok:false,reason:'invalid-point'};
 if(owner.controlUntil>sim.time||sim.airborne(owner)||!require('./summoner-effects').canAct(sim,owner,'cast')||!sim.heroes.canAct(owner,'cast'))return {ok:false,reason:'controlled'};
 if((owner.wardReadyAt||0)>sim.time)return {ok:false,reason:'cooldown'};
 if(Math.hypot(aim.x-owner.x,aim.z-owner.z)>5+1e-6)return {ok:false,reason:'out-of-range'};
 if(sim.terrain&&!sim.terrain.clear(aim,0))return {ok:false,reason:'blocked-point'};
 while(sim.entities.has(sim.nextId))sim.nextId++;
 const duration=sim.mode==='arena'&&sim.time>=480?150:120;
 const ward=sim.add({id:sim.nextId++,kind:'ward',monsterId:6052,team:owner.team,ownerId:owner.id,
   x:aim.x,z:aim.z,hpMax:3,attackDamage:0,speed:0,bodyRadius:0,visionRadius:6,
   skinItem:owner.wardSkinItem||0,duration,expiresAt:sim.time+duration});
 ward.template=spawn(ward,owner);owner.wardReadyAt=sim.time+150;
 sim.cancelWindup(owner);sim.stopMotion(owner);owner.path=[];owner.targetId=null;sim.cancelChannel(owner,'ward');
 sim.event('spawn',{id:ward.id});
 // Original 8034 reply names the caster as its zero-damage target.
 sim.event('ward-cast',{id:owner.id,aim:{x:aim.x,z:aim.z},targetIds:[owner.id],cooldown:150});
 return {ok:true,id:ward.id,expiresAt:ward.expiresAt};
}
function tick(sim){
 for(const ward of sim.entities.values())if(ward.kind==='ward'){
  if(!ward.alive||ward.expiresAt<=sim.time){sim.entities.delete(ward.id);sim.event('ward-remove',{id:ward.id});continue;}
  for(const target of sim.entities.values())if(target.alive&&target.team!==ward.team&&Math.hypot(target.x-ward.x,target.z-ward.z)<=ward.visionRadius)
   sim.vision.reveal(ward,target,.1);
 }
}
function hit(sim,attacker,target,skillId,shotId,origin,options){
 const basic=!options.deferred&&options.basic!==false&&(options.basic||shotId!==undefined||skillId===0);
 if(!basic)return 0;
 target.hp=Math.max(0,target.hp-1);
 sim.event('damage',{attacker:attacker.id,target:target.id,amount:1,hp:target.hp,skillId,shotId,origin,typeOfDamage:'true'});
 if(!target.hp){target.alive=false;sim.event('death',{id:target.id,kind:'ward',killer:attacker.id});}
 return 1;
}
module.exports={cast,tick,hit,spawn,skill};
