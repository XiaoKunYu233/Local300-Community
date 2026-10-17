'use strict';
const Type13=require('../../../projectile-type13-native'),W=require('../../../battle-wire'),candidate=require('./native-snapshot.json').cloudCandidate;
// Current model + current PathType2 candidate. Neutral flags retain the wire
// birth position; parameter0 submits no extra world-radius circle. Not captured.
const leases=new WeakMap(),claimedClouds=new WeakSet(),EPS=1e-8;
const uint=n=>Number.isInteger(n)&&n>0&&n<=0xffffffff,point=p=>p&&[p.x,p.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
const POLICY=Object.freeze({bulletId:candidate.bulletId,stateId:candidate.stateId,parameterByte:0,flags:Object.freeze([0,0,0]),
  id:'authoritative reserved cloud.id, not a second independently allocated visual ID',update:'1051 from the same cloud motion/position; no1056 corrective-speed rewrite',
  timing:'same BattleSim clock and cloud expiry; no native distance/speed expiry inference',nativeAccepted:false});
function validCloud(hero,cloud){const sim=cloud?.world;return !!sim&&!sim.heroes.closed&&sim.entities.get(hero?.id)===hero&&hero?.heroId===234&&hero.alive&&!hero.kannaBattle?.closed&&
  !sim.entities.has(cloud.id)&&hero.kannaBattle?.cloud===cloud&&cloud.owner===hero&&cloud.ownerLife===hero.reviveCount&&cloud.epoch===hero.kannaBattle.epoch&&!cloud.ended&&cloud.expiresAt>sim.time+EPS;}
function dataFor(lease,tag){const c=lease.cloud,m=c.motion||{speed:0,direction:{x:0,z:0},endpoint:{x:c.x,z:c.z}};
  if(!point(c)||!point(m.endpoint)||!Number.isFinite(m.speed)||m.speed<0||!Number.isFinite(m.direction?.x)||!Number.isFinite(m.direction?.z))throw Error('Invalid authoritative cloud motion');
  return {id:lease.id,owner:lease.owner,position:{x:c.x,z:c.z},directionRaw:[Math.round(m.direction.x*100),Math.round(m.direction.z*100)],
    movementWord:Math.min(65535,Math.round(m.speed*10)),bulletId:POLICY.bulletId,stateId:POLICY.stateId,endpoint:{...m.endpoint},team:lease.hero.team,
    parameterByte:POLICY.parameterByte,flags:[...POLICY.flags],tag,frameFlags:0};}
function launch(hero,event,_allocatedSessionId){const cloud=hero?.kannaBattle?.cloud;if(event?.type!=='kanna-cloud-create'||!validCloud(hero,cloud)||event.cloudId!==cloud.id||event.ownerLife!==cloud.ownerLife||event.epoch!==cloud.epoch||claimedClouds.has(cloud))return null;
  if(!uint(cloud.id)||cloud.id===hero.id||cloud.world.entities.has(cloud.id))throw Error('Cloud identity is not reserved');
  const lease={id:cloud.id,owner:hero.id,hero,cloud,world:cloud.world,done:false,lastTime:cloud.world.time,lastFrame:null},state={kind:'kanna-cloud'};
  Object.defineProperties(state,{id:{enumerable:true,value:lease.id},owner:{enumerable:true,value:lease.owner},logicalCloudId:{enumerable:true,value:cloud.id},done:{enumerable:true,get:()=>lease.done},expires:{enumerable:true,get:()=>cloud.expiresAt}});
  const packet=Type13.write(dataFor(lease,1050));lease.lastFrame=packet;leases.set(state,lease);claimedClouds.add(cloud);return {state,packets:[packet]};}
function finish(state){const lease=leases.get(state);if(!lease||lease.done)return [];lease.done=true;
  // Never delete an unrelated real actor that improperly reused a reserved ID.
  if(lease.world.entities.has(lease.id))return [];
  const payload=Buffer.alloc(6);payload.writeUInt16LE(1);payload.writeUInt32LE(lease.id,2);return [W.frame(1369,lease.id),W.frame(1021,lease.id,payload)];}
function tick(state,time){const lease=leases.get(state);if(!lease||lease.done)return [];if(!Number.isFinite(time)||time<lease.lastTime-EPS)throw Error('Invalid cloud visual clock');
  if(Math.abs(time-lease.world.time)>EPS)throw Error('Cloud visual clock must equal its authoritative world');lease.lastTime=time;
  if(!validCloud(lease.hero,lease.cloud))return finish(state);const frame=Type13.write(dataFor(lease,1051));
  if(frame.subarray(12).equals(lease.lastFrame.subarray(12)))return [];lease.lastFrame=frame;return [frame];}
function update(state,request={}){const lease=leases.get(state);if(!lease||lease.done)return [];
  for(const [key,value]of [['cloudId',lease.id],['owner',lease.owner],['ownerLife',lease.cloud.ownerLife]])if(request[key]!==undefined&&request[key]!==value)throw Error('Foreign cloud update');
  if(['position','endpoint','movementWord','reference','flags'].some(k=>request[k]!==undefined))throw Error('Cloud movement is owned by BattleSim');
  return tick(state,request.time??lease.world.time);}
module.exports={POLICY,launch,tick,update,finish};
