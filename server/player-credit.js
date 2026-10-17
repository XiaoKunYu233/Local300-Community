'use strict';
const crypto=require('node:crypto'),wire=require('./player-credit-wire');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(value,account){
  if(value?.version!==1||value.uid!==account.uid||value.playerId!==account.playerId)throw Error('Credit observation identity mismatch');
  if(!Number.isSafeInteger(value.observedAt)||value.observedAt<0||typeof value.frameBase64!=='string'||!/^[a-f0-9]{64}$/.test(value.captureSha256))throw Error('Invalid credit observation');
  const frame=Buffer.from(value.frameBase64,'base64');
  if(frame.toString('base64')!==value.frameBase64||hash(frame)!==value.sha256)throw Error('Credit observation integrity mismatch');
  const parsed=wire.decode(frame);
  if(!parsed||parsed.score!==value.score||parsed.experience!==value.experience)throw Error('Credit observation fields mismatch');
  return parsed;
}
// Caller must bind a single verified login connection; the reply has no UID.
function observe(account,frame,observedAt,captureSha256){
  const parsed=wire.decode(frame);if(!parsed)return false;
  const value={version:1,uid:account.uid,playerId:account.playerId,observedAt,captureSha256,sha256:hash(frame),frameBase64:frame.toString('base64'),...parsed};
  validate(value,account);
  if(!account.creditObservation||observedAt>=account.creditObservation.observedAt)account.creditObservation=value;
  return true;
}
function outbound(account,frame){
  if(!wire.decode(frame))return frame;
  const value=account?.creditObservation;
  if(value)validate(value,account);
  return wire.replaceObservation(frame,value?Buffer.from(value.frameBase64,'base64'):null);
}
function reply(account){
  if(!account?.creditObservation)return null;
  validate(account.creditObservation,account);
  const P=require('./battle-protobuf'),saved=Buffer.from(account.creditObservation.frameBase64,'base64');
  const outer=P.decode(saved.subarray(12)).find(f=>f.number===11);
  const observation=P.decode(outer.bytes).find(f=>f.number===1);
  return require('./bag').mkFrame(11888,P.encode([{...outer,bytes:P.encode([observation])}]),{stream:account.playerId,flags:0xd2});
}
module.exports={validate,observe,outbound,reply};
