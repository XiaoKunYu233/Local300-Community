'use strict';
const crypto=require('node:crypto'),wire=require('./player-medal-wire');
const hash=frame=>crypto.createHash('sha256').update(frame).digest('hex');
function identity(account){
  if(!account||!Number.isInteger(account.uid)||account.uid<1||account.uid>0xffffffff||!Number.isInteger(account.playerId)||account.playerId<1||account.playerId>0xffffffff)throw Error('Medal observation identity mismatch');
}
function knownFields(frame){
  const parsed=wire.decode(frame).medal;
  // Only a query info observation proves the contents of a captured list.
  // Equipment/view replies and error-bearing branches are not ownership.
  if(!parsed||parsed.operation!==1||!parsed.info||parsed.fields.some(field=>field.number===5))return null;
  return {records:parsed.info.ownedRecords.map(record=>({id:record.id,...(record.new===undefined?{}:{new:record.new}),...(record.timeout===undefined?{}:{timeout:record.timeout})})),equippedIds:parsed.info.equippedIds};
}
function validate(value,account){
  identity(account);
  if(value?.version!==1||value.uid!==account.uid||value.playerId!==account.playerId)throw Error('Medal observation identity mismatch');
  if(!Number.isSafeInteger(value.observedAt)||value.observedAt<0||typeof value.frameBase64!=='string'||!/^[a-f0-9]{64}$/.test(value.captureSha256)||!/^[a-f0-9]{64}$/.test(value.sha256))throw Error('Invalid medal observation');
  const frame=Buffer.from(value.frameBase64,'base64');
  if(frame.toString('base64')!==value.frameBase64||hash(frame)!==value.sha256)throw Error('Medal observation integrity mismatch');
  const parsed=knownFields(frame);
  if(!parsed||JSON.stringify(parsed.records)!==JSON.stringify(value.records)||JSON.stringify(parsed.equippedIds)!==JSON.stringify(value.equippedIds))throw Error('Medal observation fields mismatch');
  return value;
}
// Caller must verify one login identity and a preceding server clock. The
// frame has no account key. Save evidence only; never alter owned.medals or
// selected.medals, including when an info list is empty or has timeout zero.
function observe(account,frame,observedAt,captureSha256){
  const parsed=knownFields(frame);if(!parsed)return false;
  const value={version:1,uid:account.uid,playerId:account.playerId,observedAt,captureSha256,sha256:hash(frame),frameBase64:frame.toString('base64'),...parsed};
  validate(value,account);
  if(account.medalObservation)validate(account.medalObservation,account);
  if(!account.medalObservation||observedAt>=account.medalObservation.observedAt)account.medalObservation=value;
  return true;
}
function project(value,account){
  validate(value,account);
  return {records:value.records.map(record=>({id:record.id,...(record.new===undefined?{}:{new:record.new}),
    ...(record.timeout>0?{absoluteUnixSeconds:record.timeout}:{timeoutState:'unknown',...(record.timeout===0?{rawTimeout:0}:{})})})),
    equippedIds:[...value.equippedIds]};
}
function pending(account){
  if(!account.medalObservation)return null;
  const value=validate(account.medalObservation,account),ids=value.records.map(record=>record.id),set=new Set(ids);
  return {zeroTimeoutIds:value.records.filter(record=>record.timeout===0).map(record=>record.id),
    missingTimeoutIds:value.records.filter(record=>record.timeout===undefined).map(record=>record.id),
    duplicateOwnedIds:[...new Set(ids.filter((id,index)=>ids.indexOf(id)!==index))],
    duplicateEquippedIds:[...new Set(value.equippedIds.filter((id,index)=>value.equippedIds.indexOf(id)!==index))],
    equippedWithoutRecordIds:value.equippedIds.filter(id=>!set.has(id))};
}
module.exports={validate,observe,project,pending};
