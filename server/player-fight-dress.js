'use strict';
// Current XReqFightDress removal is 9018/category9/item0. No historical
// selection, empty ownership list or zero expiry grants a positive item.
const CATEGORY=9,CAPACITY=200,LIST_BYTES=2420;
const id=n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
const keys=['changedAt','itemId','playerId','uid','version'];
function identity(value){
  if(!value||!id(value.uid)||!id(value.playerId))throw Error('Fight dress identity mismatch');
  return {uid:value.uid,playerId:value.playerId};
}
function validate(state,account){
  const bound=identity(account);
  if(!state||Array.isArray(state)||Object.keys(state).sort().join(',')!==keys.join(',')||state.version!==1||state.itemId!==0||!Number.isSafeInteger(state.changedAt)||state.changedAt<0)throw Error('Invalid fight dress clear state');
  if(state.uid!==bound.uid||state.playerId!==bound.playerId)throw Error('Fight dress identity mismatch');
  return state;
}
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length)throw Error('Invalid fight dress frame');
  const tag=frame.readUInt16LE(8),header=Buffer.from(frame.subarray(0,12));
  if(tag===9018||tag===9019){
    if(frame.length!==20||frame.readUInt32LE(16)!==CATEGORY)throw Error('Invalid fight dress selector');
    return {tag,header,category:CATEGORY,itemId:frame.readUInt32LE(12)};
  }
  if(tag!==9020||frame.length!==LIST_BYTES||frame.readUInt32LE(12)!==CATEGORY||frame.readUInt32LE(16)>CAPACITY)throw Error('Invalid fight dress ownership frame');
  return {tag,header,category:CATEGORY,count:frame.readUInt32LE(16)};
}
function request(frame,authenticatedIdentity){
  const bound=identity(authenticatedIdentity);
  if(authenticatedIdentity.authenticated!==true||authenticatedIdentity.frozen!==false)throw Error('Fight dress authorization required');
  const model=decode(frame);
  if(model.tag!==9018||model.header.readUInt32LE(4)!==0||model.header.readUInt16LE(10)!==0)throw Error('Unsupported fight dress removal request');
  if(model.itemId!==0)throw Error('Nonzero fight dress selection is not supported');
  // UID and role come only from the authenticated session; the frame has neither.
  return Object.freeze({...bound,itemId:0});
}
function apply(account,requested,now=Date.now()){
  const bound=identity(account),from=identity(requested);
  if(bound.uid!==from.uid||bound.playerId!==from.playerId)throw Error('Fight dress identity mismatch');
  if(Object.keys(requested).sort().join(',')!=='itemId,playerId,uid'||requested.itemId!==0)throw Error('Invalid fight dress removal');
  if(account.fightDressState!==undefined)validate(account.fightDressState,account);
  const next={version:1,...bound,itemId:0,changedAt:now};validate(next,account);
  account.fightDressState=next;return next;
}
function reply(account,template){
  identity(account);
  if(account.fightDressState===undefined)return null;
  validate(account.fightDressState,account);
  // Preserve an actual verified self-reply header rather than manufacture an ACK.
  const model=decode(template);
  if(model.tag!==9019||model.header.readUInt32LE(4)!==0)throw Error('Verified fight dress self reply required');
  const out=Buffer.from(template);out.writeUInt32LE(0,12);return out;
}
function outbound(account,frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length)throw Error('Invalid outbound fight dress frame');
  const tag=frame.readUInt16LE(8);
  if(!([9019,9020].includes(tag))||frame.length<(tag===9019?20:16)||(tag===9019?frame.readUInt32LE(16):frame.readUInt32LE(12))!==CATEGORY)return frame;
  decode(frame);
  // Unknown ownership is never emitted as an empty or captured authorized list.
  if(tag===9020)return null;
  return reply(account,frame);
}
module.exports={CATEGORY,CAPACITY,LIST_BYTES,decode,request,apply,validate,reply,outbound};
