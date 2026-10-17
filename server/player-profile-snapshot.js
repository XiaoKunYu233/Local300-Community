'use strict';
// Historical observation only: not an entitlement or a current statistics source.
const crypto=require('crypto'),wire=require('./player-profile-wire');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(snapshot,account){
  if(!snapshot||snapshot.version!==1||!Number.isSafeInteger(snapshot.observedAt)||snapshot.observedAt<0||
    typeof snapshot.frameBase64!=='string'||typeof snapshot.sha256!=='string')throw Error('Invalid profile snapshot');
  const frame=Buffer.from(snapshot.frameBase64,'base64');
  if(frame.toString('base64')!==snapshot.frameBase64||hash(frame)!==snapshot.sha256)throw Error('Profile snapshot integrity mismatch');
  if(snapshot.source!==undefined)require('./player-profile-source-import').validateSource(snapshot.source,account,snapshot);
  return wire.unpack(frame,account);
}
function observe(account,frame,observedAt){
  const profile=wire.unpack(frame);
  if(profile.uid!==account.uid||profile.playerId!==account.playerId)return false;
  const snapshot={version:1,observedAt,sha256:hash(frame),frameBase64:frame.toString('base64')};
  validate(snapshot,account);
  if(!account.profileSnapshot||observedAt>=account.profileSnapshot.observedAt)account.profileSnapshot=snapshot;
  return true;
}
module.exports={validate,observe};
