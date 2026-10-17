'use strict';
// Explicit offline migration only. Captured selection never grants ownership.
const crypto=require('node:crypto'),role=require('./roledata'),catalog=require('./client-title-catalog.json');
const TITLE_OFF=287854,HIDDEN_OFF=287856,MASK_OFF=287857,MASK_BYTES=300,TITLE_CAPACITY=2400;
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function classify(id){
  const row=catalog.titles[id];
  if(!row||row.valid!==1)return 'unknown-or-invalid-configuration';
  if(row.ifLimit!==0||row.timeLimit!==0)return 'expiration-not-observed';
  // A current zero duration contradicts several historical "limited title"
  // descriptions. Neither the mask nor the config proves their expiry.
  if(/限时/.test(row.description))return 'ambiguous-expiration';
  return 'permanent';
}
function encoded(value){
  const bytes=Buffer.alloc(3+MASK_BYTES);bytes.writeUInt16LE(value.selectedTitleId);bytes[2]=Number(value.hidden);
  Buffer.from(value.maskHex,'hex').copy(bytes,3);return bytes;
}
function validate(value,account){
  if(value?.version!==1||value.uid!==account.uid||value.playerId!==account.playerId)throw Error('Title ownership observation identity mismatch');
  if(!Number.isSafeInteger(value.observedAt)||value.observedAt<0||!/^capture-role:[a-f0-9]{64}$/.test(value.source)||
    value.catalogSha256!==catalog.source.sha256||!new RegExp('^[a-f0-9]{'+MASK_BYTES*2+'}$').test(value.maskHex)||
    !Number.isInteger(value.selectedTitleId)||value.selectedTitleId<0||value.selectedTitleId>=TITLE_CAPACITY||typeof value.hidden!=='boolean'||
    hash(encoded(value))!==value.sha256)throw Error('Invalid title ownership observation');
  const mask=Buffer.from(value.maskHex,'hex');if(mask[0]&1)throw Error('Zero title cannot be owned');
  return value;
}
function fromRole(blob,account,observedAt){
  // This declared/actual length pair is the normal-client 1013 layout observed
  // in both independent account captures. Unknown layouts fail closed.
  if(!Buffer.isBuffer(blob)||blob.length!==288458||blob.readUInt32LE(0)!==288540||blob.readUInt16LE(8)!==1013||
    blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)throw Error('Title ownership role identity/layout mismatch');
  if(blob[HIDDEN_OFF]>1)throw Error('Invalid captured title hidden flag');
  const value={version:1,uid:account.uid,playerId:account.playerId,observedAt,source:'capture-role:'+hash(blob),catalogSha256:catalog.source.sha256,
    selectedTitleId:blob.readUInt16LE(TITLE_OFF),hidden:!!blob[HIDDEN_OFF],maskHex:blob.subarray(MASK_OFF,MASK_OFF+MASK_BYTES).toString('hex')};
  value.sha256=hash(encoded(value));return validate(value,account);
}
function inspect(value,account){
  validate(value,account);const mask=Buffer.from(value.maskHex,'hex'),permanent=[],unresolved=[];
  for(let id=1;id<TITLE_CAPACITY;id++)if(mask[id>>3]&(1<<(id&7))){const reason=classify(id);if(reason==='permanent')permanent.push(id);else unresolved.push({id,reason});}
  return {permanent,unresolved};
}
function imported(account,blob,observedAt){
  const value=fromRole(blob,account,observedAt),result=inspect(value,account);
  if(account.titleOwnershipObservation&&observedAt<account.titleOwnershipObservation.observedAt)throw Error('Title observation time moved backwards');
  // Rebuild an explicit capture baseline; a later role snapshot may revoke a
  // bit. This function is never a live entitlement/reward handler.
  account.owned.titles=Object.fromEntries(result.permanent.map(id=>[id,{acquiredAt:observedAt,expiresAt:null,source:'capture-title:'+value.source.slice(13)}]));
  account.titleOwnershipObservation=value;
  const selected=value.selectedTitleId;
  account.titleState={version:1,titleId:selected&&account.owned.titles[selected]?selected:0,hidden:selected&&account.owned.titles[selected]?value.hidden:true,changedAt:observedAt};
  require('./player-title-state').validate(account.titleState,account);
  return {...result,observedAt,sha256:value.sha256,selectedTitleId:selected,selectionRestored:account.titleState.titleId===selected};
}
module.exports={fromRole,validate,inspect,imported,classify,TITLE_OFF,HIDDEN_OFF,MASK_OFF,MASK_BYTES,TITLE_CAPACITY};
