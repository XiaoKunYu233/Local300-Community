'use strict';
// Only an explicit authenticated key0 VIP visibility preference is saved.
// A checkbox preference never grants VIP, and captured defaults are not imported.
const T=require('./player-title-settings');
const expectedKeys=['changedAt','playerId','uid','version','vipHidden'];
function identity(value){
  if(!value||![value.uid,value.playerId].every(n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff))throw Error('Personal settings identity mismatch');
  return {uid:value.uid,playerId:value.playerId};
}
function validate(value,account){
  const bound=identity(account);
  if(!value||Array.isArray(value)||Object.keys(value).sort().join(',')!==expectedKeys.join(',')||value.version!==1||typeof value.vipHidden!=='boolean'||!Number.isSafeInteger(value.changedAt)||value.changedAt<0)throw Error('Invalid personal settings');
  if(value.uid!==bound.uid||value.playerId!==bound.playerId)throw Error('Personal settings identity mismatch');return value;
}
function request(frame,authenticatedIdentity){
  const bound=identity(authenticatedIdentity);
  if(authenticatedIdentity.authenticated!==true||authenticatedIdentity.frozen!==false)throw Error('Personal settings authorization required');
  if(!Buffer.isBuffer(frame)||frame.length!==T.LENGTH||frame.readUInt32LE(0)!==T.LENGTH||frame.readUInt16LE(8)!==1452||frame.readUInt32LE(4)!==0||frame.readUInt16LE(10)!==0||frame[12]!==1||frame[13]!==0||frame[14]>1)throw Error('Unsupported VIP display settings request');
  for(let at=15;at<T.LENGTH;at+=2)if(frame[at]!==255||frame[at+1]!==0)throw Error('Unsupported VIP display settings request');
  return Object.freeze({...bound,vipHidden:frame[14]===1});
}
function apply(account,requested,now=Date.now()){
  const bound=identity(account),auth=identity(requested);
  if(bound.uid!==auth.uid||bound.playerId!==auth.playerId)throw Error('Personal settings identity mismatch');
  if(typeof requested.vipHidden!=='boolean')throw Error('Invalid VIP display preference');
  if(account.personalSettings!==undefined)validate(account.personalSettings,account);
  const next={version:1,...bound,vipHidden:requested.vipHidden,changedAt:now};validate(next,account);
  account.personalSettings=next;return next;
}
function reply(account){
  if(!account||account.personalSettings===undefined&&account.titleSettings===undefined)return null;
  identity(account);const pairs=[];
  if(account.personalSettings!==undefined)pairs.push({key:0,value:Number(validate(account.personalSettings,account).vipHidden)});
  if(account.titleSettings!==undefined)pairs.push({key:1,value:Number(T.validate(account.titleSettings,account).effectHidden)});
  const payload=Buffer.alloc(T.LENGTH-12);payload[0]=pairs.length;for(let i=0;i<T.CAPACITY;i++)payload[1+i*2]=255;
  pairs.forEach((pair,i)=>{payload[1+i*2]=pair.key;payload[2+i*2]=pair.value;});
  // Actual1454 self replies have stream0. d2 is the existing encoder convention,
  // not a claim that captured transport flags are a constant authorization key.
  return require('./bag').mkFrame(1454,payload,{stream:0,flags:0xd2});
}
function outbound(account,frame){T.decode(frame);return reply(account);}
module.exports={request,apply,validate,reply,outbound};
