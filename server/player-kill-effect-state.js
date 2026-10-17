'use strict';
// Only the current client's category6 item0 removal is authorized here.
// Historical selections and zero expiry observations never grant ownership.
const W=require('./player-kill-effect-wire');
const id=n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff;
const keys=['changedAt','itemId','playerId','uid','version'];
function identity(value){
  if(!value||!id(value.uid)||!id(value.playerId))throw Error('Invalid kill effect identity');
  return {uid:value.uid,playerId:value.playerId};
}
function validate(state,account){
  const bound=identity(account);
  if(!state||Array.isArray(state)||Object.keys(state).sort().join(',')!==keys.join(',')||state.version!==1||state.itemId!==0||!Number.isSafeInteger(state.changedAt)||state.changedAt<0)throw Error('Invalid kill effect clear state');
  if(state.uid!==bound.uid||state.playerId!==bound.playerId)throw Error('Kill effect identity mismatch');
  return state;
}
function request(frame,authenticatedIdentity){
  const bound=identity(authenticatedIdentity),selected=W.request(frame);
  if(selected.itemId!==0)throw Error('Nonzero kill effect selection is not supported');
  // Identity comes from authenticated session state, never the frame header.
  return Object.freeze({...bound,itemId:0});
}
function apply(account,requested,now=Date.now()){
  const bound=identity(account),from=identity(requested);
  if(bound.uid!==from.uid||bound.playerId!==from.playerId)throw Error('Kill effect identity mismatch');
  if(requested.itemId!==0)throw Error('Nonzero kill effect selection is not supported');
  if(account.killEffectState!==undefined)validate(account.killEffectState,account);
  const next={version:1,...bound,itemId:0,changedAt:now};validate(next,account);
  account.killEffectState=next;return next;
}
function reply(account,template){
  identity(account);
  if(account.killEffectState===undefined)return null;
  validate(account.killEffectState,account);
  let header;
  if(template!==undefined){
    const model=W.decode(template);if(model.tag!==9019)throw Error('Not a kill effect selection reply');
    header=Buffer.from(model.header);
  }else{header=Buffer.alloc(12);header.writeUInt32LE(20);header.writeUInt16LE(9019,8);}
  // Actual category6 self replies carry stream0; UID/role do not occur in body.
  header.writeUInt32LE(0,4);
  return W.encode({tag:9019,header,category:W.CATEGORY,itemId:0});
}
function outbound(account,frame){
  if(!Buffer.isBuffer(frame)||frame.length<12)throw Error('Invalid outbound kill effect frame');
  if(frame.readUInt16LE(8)!==9019||frame.length<20||frame.readUInt32LE(16)!==W.CATEGORY)return frame;
  W.decode(frame);
  // No saved clear means no authoritative selection, including captured values.
  return reply(account,frame);
}
module.exports={request,apply,validate,reply,outbound};
