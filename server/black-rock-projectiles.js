'use strict';
const W=require('./battle-wire');
const launched=new WeakSet();

// 001/003 native type-13 records. Bullet-table IDs are independent from skill
// IDs: bullet 2857 is E's visible missile; skill 2857 is the melee attack.
const source={
  Q:Buffer.from('2a0000002dce2eff1a0400000d00010000b350894e36ad18011f0bd4836400010a1f0bf15b3650010000','hex'),
  E:Buffer.from('2a0000003ace2eff1a0400000d00010000e5501d4e2ba79600290b8e7664000114290bf15b3650010000','hex'),
  R:Buffer.from('2a00000042ce2eff1a0400000d00010000aa508e4e2da8f000240bc6786400013c260bf15b3650010000','hex')
};
const definitions=Object.freeze({
  // `speed` retains the original tail byte (native 4444 parameter), not m/s.
  2850:{kind:'E',bullet:2857,reference:2857,speed:20,movementWord:150,impact:2851},
  2842:{kind:'Q',speed:10,movementWord:270,impact:2842},
  2940:{kind:'Q',speed:10,movementWord:270,impact:2940},
  20187:{kind:'Q',speed:10,movementWord:270,impact:20187},
  // The captured first R starts with 2854; its later 1051 uses 2852.
  // The transition trigger is not yet known. Do not schedule a guessed switch.
  2854:{kind:'R',bullet:64832,reference:2854,speed:60,movementWord:240,impact:2855},
  2837:{kind:'R',bullet:64832,reference:2852,speed:60,movementWord:240,impact:2855},
  2838:{kind:'R',bullet:64832,reference:2852,speed:60,movementWord:240,impact:2855}
});
const uint=(n,max=0xffffffff)=>Number.isInteger(n)&&n>0&&n<=max;
const point=p=>p&&[p.x,p.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
function inspect(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==42||![1050,1051].includes(frame.readUInt16LE(8)))return null;
  const p=frame.subarray(12);if(p.readUInt16LE(0)!==13||p.readUInt16LE(2)!==1||p[4]!==0)return null;
  return {id:frame.readUInt32LE(4),tag:frame.readUInt16LE(8),x:p.readUInt16LE(5)/100,z:p.readUInt16LE(7)/100,
    directionRaw:[p.readInt8(9),p.readInt8(10)],movementWord:p.readUInt16LE(11),height:p.readUInt16LE(11),
    movementSpeed:p.readUInt16LE(11)/10,bullet:p.readUInt16LE(13),
    endpoint:{x:p.readUInt16LE(15)/100,z:p.readUInt16LE(17)/100},team:p[19],speed:p[20],
    reference:p.readUInt16LE(21),owner:p.readUInt32LE(23),flags:[...p.subarray(27)]};
}
function spawnFrame(kind,data){
  const movementWord=data.movementWord??data.height; // Legacy capture alias.
  if(!source[kind]||![1050,1051].includes(data.tag??1050)||!uint(data.id)||!uint(data.owner)||data.id===data.owner||!point(data)||!point(data.endpoint)||
    ![1,2,3].includes(data.team)||!uint(data.bullet,65535)||!uint(data.reference,65535)||
    !Number.isInteger(data.speed)||data.speed<1||data.speed>255||!Number.isInteger(movementWord)||movementWord<0||movementWord>65535||
    !Array.isArray(data.directionRaw)||data.directionRaw.length!==2||data.directionRaw.some(n=>!Number.isInteger(n)||Math.abs(n)>100))
    throw Error('Invalid BRS projectile');
  const out=Buffer.from(source[kind]),p=out.subarray(12);out.writeUInt32LE(data.id,4);
  out.writeUInt16LE(data.tag??1050,8);
  p.writeUInt16LE(Math.round(data.x*100),5);p.writeUInt16LE(Math.round(data.z*100),7);
  p.writeInt8(data.directionRaw[0],9);p.writeInt8(data.directionRaw[1],10);p.writeUInt16LE(movementWord,11);
  p.writeUInt16LE(data.bullet,13);p.writeUInt16LE(Math.round(data.endpoint.x*100),15);p.writeUInt16LE(Math.round(data.endpoint.z*100),17);
  p[19]=data.team;p[20]=data.speed;p.writeUInt16LE(data.reference,21);p.writeUInt32LE(data.owner,23);
  if(data.flags){if(data.flags.length!==3||data.flags.some(n=>!Number.isInteger(n)||n<0||n>255))throw Error('Invalid projectile flags');Buffer.from(data.flags).copy(p,27);}
  return out;
}
function direction(origin,aim){
  let x=aim?.dirX,z=aim?.dirZ;
  if(!Number.isFinite(x)||!Number.isFinite(z)||Math.hypot(x,z)<1e-9){x=(aim?.x??origin.x)-origin.x;z=(aim?.z??origin.z)-origin.z;}
  const length=Math.hypot(x,z);return length>1e-9?{x:x/length,z:z/length}:null;
}
function clipEndpoint(origin,dir,range){
  let reach=range;
  for(const key of ['x','z'])if(dir[key]>0)reach=Math.min(reach,(655.35-origin[key])/dir[key]);
    else if(dir[key]<0)reach=Math.min(reach,-origin[key]/dir[key]);
  return {x:Math.min(655.35,Math.max(0,origin.x+dir.x*reach)),z:Math.min(655.35,Math.max(0,origin.z+dir.z*reach))};
}
function childState(hero,skill){
  if(skill.id!==2850)return [];
  // This 11035 variant is [skill u16][level u8][state u8][zero u32],
  // not the unrelated [attribute u16][count u8][type u8][value u32] form.
  const p=Buffer.alloc(8);p.writeUInt16LE(2851);p[2]=skill.level;p[3]=2;
  const cd=Buffer.alloc(7);cd.writeUInt16LE(2851);cd[2]=skill.level;cd.writeUInt32LE(100,3);
  return [W.frame(11035,hero.id,p),W.frame(11031,hero.id,cd)];
}
function travelDuration(skillId,origin,endpoint){
  const def=definitions[skillId];
  if(!def||!point(origin)||!point(endpoint))throw Error('Invalid projectile flight');
  return Math.max(.1,Math.hypot(endpoint.x-origin.x,endpoint.z-origin.z)/(def.movementWord/10));
}
function launch(hero,{skill,aim={},id,time=0,origin=aim.origin??hero,endpoint=aim.endpoint}={}){
  const def=definitions[skill?.id];if(!def)return null;
  if(!uint(hero?.id)||!uint(id)||id===hero.id||!point(origin)||!Number.isFinite(time)||
    !uint(skill.level,def.kind==='R'?3:5)||!Number.isFinite(skill.range)||skill.range<=0)throw Error('Invalid projectile launch');
  const dir=direction(origin,aim);if(!dir)throw Error('Invalid projectile direction');
  if(endpoint&&!point(endpoint))throw Error('Invalid projectile endpoint');
  const end=endpoint||clipEndpoint(origin,dir,skill.range);
  const data={id,owner:hero.id,x:origin.x,z:origin.z,directionRaw:[Math.round(dir.x*100),Math.round(dir.z*100)],
    movementWord:def.movementWord,bullet:def.kind==='Q'?2842+skill.level:def.bullet,endpoint:end,team:hero.team,speed:def.speed,
    reference:def.kind==='Q'?2842+skill.level:def.reference};
  // Current normal-client bullet 64832 has a visible R model. Old bullet 2852
  // has only a script name and no model; use the current visible resource.
  // Native bf419a converts this common u16 by /10 into e5c8/e5d4, the
  // movement speed. The tail byte goes into 4444 and is not travel speed.
  // Retain the old inspect/spawn property name `height` for captured records.
  const state={id,owner:hero.id,kind:def.kind,startAt:time,expires:time+travelDuration(skill.id,origin,end),
    endpoint:{...end},origin:{x:origin.x,z:origin.z},direction:dir,skillId:skill.id,done:false,
    segment:{at:time,origin:{x:origin.x,z:origin.z},speed:def.movementWord/10},
    nativeData:{...data,endpoint:{...end},directionRaw:[...data.directionRaw],flags:[1,0,0]}};
  const packets=[spawnFrame(def.kind,data),...childState(hero,skill)];launched.add(state);
  return {state,packets};
}
function positionAt(state,time){
  if(!launched.has(state)||!Number.isFinite(time)||time<state.segment.at)throw Error('Invalid projectile sample');
  if(time+1e-9>=state.expires)return {...state.endpoint};
  const origin=state.segment.origin,dx=state.endpoint.x-origin.x,dz=state.endpoint.z-origin.z,length=Math.hypot(dx,dz);
  const travel=Math.min(length,Math.max(0,(time-state.segment.at)*state.segment.speed));
  return length>1e-9?{x:origin.x+dx/length*travel,z:origin.z+dz/length*travel}:{...state.endpoint};
}
// Explicit movement update, with no automatic time/distance trigger. A host
// must supply the verified transition; both 1051 and cleanup use this segment.
function updateMovement(state,{time,position,movementWord,reference,flags}={}){
  if(!launched.has(state)||!Number.isFinite(time)||time<state.segment.at||
    !uint(movementWord,65535)||!uint(reference,65535)||!Array.isArray(flags)||flags.length!==3||
    flags.some(n=>!Number.isInteger(n)||n<0||n>255)||position&&!point(position))throw Error('Invalid projectile movement update');
  if(state.done)return [];
  if(time+1e-9>=state.expires)return finish(state);
  const at=position||positionAt(state,time),remaining=Math.hypot(state.endpoint.x-at.x,state.endpoint.z-at.z);
  const data={...state.nativeData,tag:1051,x:at.x,z:at.z,movementWord,reference,flags:[...flags]};
  const packet=spawnFrame(state.kind,data);
  state.segment={at:time,origin:{x:at.x,z:at.z},speed:movementWord/10};
  state.nativeData=data;state.expires=time+remaining/state.segment.speed;
  return [packet];
}
function launchBasic(hero,{shot,id,time=shot?.launchAt}={}){
  if(!hero?.blackRock||!shot?.brsPiercing||shot.skillId!==2842)return null;
  const skill={id:2842,level:hero.blackRock.levels.Q,range:shot.pierceRange};
  const aim={dirX:shot.direction?.x,dirZ:shot.direction?.z};
  return launch(hero,{skill,aim,origin:shot.source,id,time});
}
function finish(state){
  if(!state||state.done)return [];
  if(!uint(state.id)||state.id===state.owner)throw Error('Invalid projectile cleanup');
  state.done=true;
  const p=Buffer.alloc(6);p.writeUInt16LE(1);p.writeUInt32LE(state.id,2);
  return [W.frame(1369,state.id),W.frame(1021,state.id,p)];
}
function tick(state,time){
  if(!state||state.done)return [];
  if(!Number.isFinite(time))throw Error('Invalid projectile time');
  return time+1e-9>=state.expires?finish(state):[];
}
function damagePresentation(hero,event){
  const def=definitions[event.skillId];if(!def||def.kind==='Q'||!hero?.blackRock)return null;
  return {skillId:def.impact,level:def.kind==='E'?hero.blackRock.levels.E:hero.blackRock.levels.R,action:2};
}
module.exports={definitions,inspect,spawnFrame,launch,launchBasic,positionAt,updateMovement,tick,finish,damagePresentation,travelDuration};
