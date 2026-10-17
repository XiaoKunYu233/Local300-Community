'use strict';
const W=require('./battle-wire');
// Verified compact type13, one-record, common-byte-zero variant. Current EXE
// bf3920 (1050) and bff730 (1051) consume the same compact common fields.
// movementWord / 10 is movement speed; parameterByte is a separate native
// 4444 argument. This codec assigns no gameplay meaning to trailer flags.
const uint=(value,max=0xffffffff)=>Number.isInteger(value)&&value>0&&value<=max;
const unsigned=(value,max)=>Number.isInteger(value)&&value>=0&&value<=max;
const point=value=>value&&[value.x,value.z].every(n=>Number.isFinite(n)&&n>=0&&n<=655.35);
function write({id,owner,position,directionRaw,movementWord,bulletId,stateId,endpoint,team,parameterByte,flags,tag=1050,frameFlags=0}={}){
  if(![1050,1051].includes(tag)||!uint(id)||!uint(owner)||id===owner||!point(position)||!point(endpoint)||
    !uint(bulletId,65535)||!uint(stateId,65535)||![1,2,3].includes(team)||!unsigned(movementWord,65535)||
    !unsigned(parameterByte,255)||!unsigned(frameFlags,65535)||!Array.isArray(directionRaw)||directionRaw.length!==2||
    directionRaw.some(value=>!Number.isInteger(value)||value<-128||value>127)||!Array.isArray(flags)||flags.length!==3||
    flags.some(value=>!unsigned(value,255)))throw Error('Invalid compact native type13 record');
  const payload=Buffer.alloc(30);payload.writeUInt16LE(13,0);payload.writeUInt16LE(1,2);
  payload.writeUInt16LE(Math.round(position.x*100),5);payload.writeUInt16LE(Math.round(position.z*100),7);
  payload.writeInt8(directionRaw[0],9);payload.writeInt8(directionRaw[1],10);payload.writeUInt16LE(movementWord,11);
  payload.writeUInt16LE(bulletId,13);payload.writeUInt16LE(Math.round(endpoint.x*100),15);payload.writeUInt16LE(Math.round(endpoint.z*100),17);
  payload[19]=team;payload[20]=parameterByte;payload.writeUInt16LE(stateId,21);payload.writeUInt32LE(owner,23);
  Buffer.from(flags).copy(payload,27);return W.frame(tag,id,payload,frameFlags);
}
function inspect(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==42||frame.readUInt32LE(0)!==42||![1050,1051].includes(frame.readUInt16LE(8)))return null;
  const payload=frame.subarray(12);
  if(payload.readUInt16LE(0)!==13||payload.readUInt16LE(2)!==1||payload[4]!==0)return null;
  return {id:frame.readUInt32LE(4),owner:payload.readUInt32LE(23),tag:frame.readUInt16LE(8),frameFlags:frame.readUInt16LE(10),
    position:{x:payload.readUInt16LE(5)/100,z:payload.readUInt16LE(7)/100},directionRaw:[payload.readInt8(9),payload.readInt8(10)],
    movementWord:payload.readUInt16LE(11),bulletId:payload.readUInt16LE(13),stateId:payload.readUInt16LE(21),
    endpoint:{x:payload.readUInt16LE(15)/100,z:payload.readUInt16LE(17)/100},team:payload[19],parameterByte:payload[20],flags:[...payload.subarray(27)]};
}
module.exports={write,inspect};
