'use strict';
const crypto=require('node:crypto');
const LENGTH=77,CAPACITY=32;
const hash=frame=>crypto.createHash('sha256').update(frame).digest('hex');
function check(frame,msg,length){
  if(!Buffer.isBuffer(frame)||frame.length!==length||frame.readUInt32LE(0)!==length||frame.readUInt16LE(8)!==msg)throw Error('Invalid personal settings frame');
}
// bceb1a: count at +12, followed by pairs of u8 setting key/value.
// Key 1 is the title effect preference; it is independent of 14004 hiding.
function decode(frame){
  check(frame,1454,LENGTH);
  const count=frame[12];if(count>CAPACITY)throw Error('Invalid personal settings count');
  const pairs=[],keys=new Set();
  for(let i=0;i<CAPACITY;i++){
    const at=13+i*2,key=frame[at],value=frame[at+1];
    if(i>=count){if(key!==255||value!==0)throw Error('Invalid unused personal settings pair');continue;}
    if(key===255||keys.has(key))throw Error('Duplicate or invalid personal settings key');
    if((key===0||key===1)&&value>1)throw Error('Invalid personal settings boolean');
    pairs.push({key,value});keys.add(key);
  }
  const effect=pairs.find(pair=>pair.key===1);
  return {pairs,...(effect?{effectHidden:effect.value===1}:{})};
}
function request(frame){
  check(frame,1452,LENGTH);
  if(frame.readUInt32LE(4)!==0||frame.readUInt16LE(10)!==0)throw Error('Unsupported personal settings update');
  // XShowTitleEffect (14dc050) is the only write variant implemented here.
  if(frame[12]!==1||frame[13]!==1||frame[14]>1)throw Error('Unsupported personal settings update');
  for(let at=15;at<LENGTH;at+=2)if(frame[at]!==255||frame[at+1]!==0)throw Error('Unsupported personal settings update');
  return {effectHidden:frame[14]===1};
}
function query(frame){check(frame,1453,12);return true;}
function validTime(value){if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid title settings time');}
function validIdentity(account){
  if(!account||!Number.isInteger(account.uid)||account.uid<1||account.uid>0xffffffff||!Number.isInteger(account.playerId)||account.playerId<1||account.playerId>0xffffffff)throw Error('Title settings identity mismatch');
}
function validate(value,account){
  validIdentity(account);
  if(value?.version!==1||typeof value.effectHidden!=='boolean')throw Error('Invalid title settings');
  validTime(value.changedAt);
  if(value.source!==undefined){
    const source=value.source;
    if(source?.uid!==account.uid||source.playerId!==account.playerId)throw Error('Title settings observation identity mismatch');
    validTime(source.observedAt);
    if(value.changedAt<source.observedAt||typeof source.frameBase64!=='string'||!/^[a-f0-9]{64}$/.test(source.captureSha256)||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('Invalid title settings observation');
    const frame=Buffer.from(source.frameBase64,'base64');
    if(frame.toString('base64')!==source.frameBase64||hash(frame)!==source.sha256)throw Error('Title settings observation integrity mismatch');
    if(decode(frame).effectHidden===undefined)throw Error('Title settings observation has no effect preference');
  }
  return value;
}
// Apply only inside a PlayerAccounts.update draft. Keep imported source bytes
// as historical evidence even when a later authenticated request changes it.
function apply(account,change,now=Date.now()){
  if(typeof change?.effectHidden!=='boolean')throw Error('Invalid title effect preference');
  if(account.titleSettings)validate(account.titleSettings,account);
  const value={version:1,effectHidden:change.effectHidden,changedAt:now,...(account.titleSettings?.source?{source:account.titleSettings.source}:{})};
  validate(value,account);account.titleSettings=value;return value;
}
// The caller must first verify a single login identity and server clock: this
// reply has no account identity of its own. Unknown pairs remain in source.
function observe(account,frame,observedAt,captureSha256){
  const parsed=decode(frame);validIdentity(account);validTime(observedAt);
  if(!/^[a-f0-9]{64}$/.test(captureSha256))throw Error('Invalid title settings capture hash');
  if(parsed.effectHidden===undefined)return false;
  const value={version:1,effectHidden:parsed.effectHidden,changedAt:observedAt,source:{uid:account.uid,playerId:account.playerId,observedAt,captureSha256,sha256:hash(frame),frameBase64:frame.toString('base64')}};
  validate(value,account);
  if(account.titleSettings)validate(account.titleSettings,account);
  if(!account.titleSettings||observedAt>=account.titleSettings.changedAt)account.titleSettings=value;
  return true;
}
function reply(account){
  if(!account?.titleSettings)return null;
  const state=validate(account.titleSettings,account),payload=Buffer.alloc(LENGTH-12);
  payload[0]=1;for(let i=0;i<CAPACITY;i++)payload[1+i*2]=255;
  payload[1]=1;payload[2]=Number(state.effectHidden);
  return require('./bag').mkFrame(1454,payload,{stream:account.playerId,flags:0xd2});
}
// Never replay another capture's unknown preferences. The known key is sent
// from this account, while unimplemented keys are retained only as evidence.
function outbound(account,frame){decode(frame);return reply(account);}
module.exports={validate,apply,observe,decode,request,query,reply,outbound,LENGTH,CAPACITY};
