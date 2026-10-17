'use strict';
// Historical evidence from an identity-verified capture, not a grant receipt.
// 11542 contains no UID: import must bind it to the authenticated capture owner.
const crypto=require('node:crypto'),wire=require('./player-vip-wire');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function validate(snapshot,account){
  if(!snapshot||snapshot.version!==1||snapshot.uid!==account.uid||snapshot.playerId!==account.playerId||
    !Number.isSafeInteger(snapshot.observedAt)||snapshot.observedAt<0||typeof snapshot.frameBase64!=='string'||
    !/^[a-f0-9]{64}$/.test(snapshot.captureSha256))throw Error('Invalid first gift observation identity or metadata');
  const frame=Buffer.from(snapshot.frameBase64,'base64');
  if(frame.toString('base64')!==snapshot.frameBase64||hash(frame)!==snapshot.sha256)throw Error('First gift observation integrity mismatch');
  const parsed=wire.firstGiftReply(frame);
  if(snapshot.status!==parsed.status||snapshot.amountMinor!==parsed.amountMinor)throw Error('First gift observation fields mismatch');
  return parsed;
}
function observe(account,frame,observedAt,captureSha256){
  const snapshot={version:1,uid:account.uid,playerId:account.playerId,observedAt,captureSha256,
    sha256:hash(frame),frameBase64:frame.toString('base64'),...wire.firstGiftReply(frame)};
  validate(snapshot,account);
  if(account.firstGiftObservation)validate(account.firstGiftObservation,account);
  if(!account.firstGiftObservation||observedAt>=account.firstGiftObservation.observedAt)account.firstGiftObservation=snapshot;
}
function sourceEntitlement(account){
  const observed=account.firstGiftObservation?validate(account.firstGiftObservation,account):null;
  if(!account.firstGiftResetState&&observed?.status==='claimed')return {status:'claimed',amountMinor:null};
  if(account.firstGiftEntitlement){
    const source=require('./player-recharge').validateFirstGift(account.firstGiftEntitlement,account);
    if((source.generation??0)!==(account.firstGiftResetState?.generation??0))throw Error('First gift entitlement belongs to an earlier reset');
    return {status:'claimable',amountMinor:source.amountMinor,issuedAt:source.issuedAt,source:source.source,sha256:source.receiptSha256};
  }
  if(!account.firstGiftResetState&&observed)return {...observed,issuedAt:account.firstGiftObservation.observedAt,sha256:account.firstGiftObservation.sha256};
  return {status:'unavailable',amountMinor:0};
}
function entitlement(account){
  if(account.firstGiftClaim){validateClaim(account.firstGiftClaim,account);return {status:'claimed',amountMinor:null};}
  return sourceEntitlement(account);
}
function validateClaim(claim,account){
  if(!claim||claim.version!==1||claim.uid!==account.uid||claim.playerId!==account.playerId||
    !Number.isSafeInteger(claim.claimedAt)||claim.claimedAt<0||!Number.isSafeInteger(claim.amountMinor)||claim.amountMinor<=0||
    !Number.isSafeInteger(claim.tierMinor)||claim.tierMinor<=0||claim.tierMinor>claim.amountMinor||
    !/^[a-f0-9]{64}$/.test(claim.catalogSha256)||!Array.isArray(claim.items)||!claim.items.length)throw Error('Invalid first gift claim');
  if(claim.source!==undefined){
    const observed=sourceEntitlement(account);
    if(observed.status!=='claimable'||claim.source!==observed.source||claim.entitlementSha256!==observed.sha256||claim.amountMinor!==observed.amountMinor||claim.claimedAt<observed.issuedAt)throw Error('First gift recharge entitlement mismatch');
  }else{
    if(account.firstGiftResetState)throw Error('Historical first gift cannot be claimed after GM reset');
    const observation=account.firstGiftObservation;
    validate(observation,account);
    if(claim.observationSha256!==observation.sha256||observation.status!=='claimable'||claim.amountMinor!==observation.amountMinor||claim.claimedAt<observation.observedAt)throw Error('First gift claim evidence mismatch');
  }
  const seen=new Set();
  for(const item of claim.items){
    if(!Number.isInteger(item.itemId)||item.itemId<=0||item.itemId>=65535||!Number.isInteger(item.count)||item.count<=0||item.count>65535||seen.has(item.itemId))throw Error('Invalid first gift claim rewards');
    seen.add(item.itemId);
  }
  return claim;
}
function prepare(account,now=Date.now()){
  if(account.firstGiftClaim){validateClaim(account.firstGiftClaim,account);throw Error('First gift already claimed');}
  const observed=entitlement(account);
  if(observed.status!=='claimable')throw Error('First gift observation or recharge entitlement is not claimable');
  const catalog=require('./player-first-gift-catalog'),source=catalog.load(),tier=catalog.displayTier(source,observed);
  if(!tier)throw Error('First gift amount has no reward tier');
  catalog.deliveryItems(tier); // Verify all destinations before any mutation.
  const claim={version:1,uid:account.uid,playerId:account.playerId,claimedAt:now,
    ...(observed.source?{source:observed.source,entitlementSha256:observed.sha256}:{observationSha256:observed.sha256}),amountMinor:observed.amountMinor,tierMinor:tier.amountMinor,
    catalogSha256:source.sourceSha256,items:structuredClone(tier.items)};
  validateClaim(claim,account);
  return {revision:account.revision,claim,rewards:require('./player-reward-currency').convertRewards(tier.items)};
}
// Must be called in the same economy commit as the prepared assets. This
// function never grants inventory on its own and is not a public claim API.
function record(account,prepared){
  if(account.firstGiftClaim)throw Error('First gift already claimed');
  if(account.revision!==prepared.revision)throw Error('First gift account revision changed');
  const expected=prepare(account,prepared.claim.claimedAt);
  if(JSON.stringify(expected)!==JSON.stringify(prepared))throw Error('First gift preparation changed');
  account.firstGiftClaim=structuredClone(prepared.claim);
}
function reply(account){
  let value;
  if(account.firstGiftClaim){validateClaim(account.firstGiftClaim,account);value=0xffffffff;}
  else{const status=entitlement(account);value=status.status==='claimed'?0xffffffff:status.amountMinor;}
  const p=Buffer.alloc(4);p.writeUInt32LE(value);
  return require('./bag').mkFrame(11542,p,{stream:account.playerId,flags:0xd2});
}
module.exports={validate,observe,validateClaim,prepare,record,reply,entitlement};
