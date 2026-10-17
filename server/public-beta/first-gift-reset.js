'use strict';
// Explicit test-tool resets archive eligibility and claims, never currency or
// VIP. Historical capture evidence stays on the account for audit.
const crypto=require('node:crypto');
const copy=value=>structuredClone(value),hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(value);
const eventId=id=>'public-beta:first-gift-reset:'+id;
function payload(tx){return {kind:tx.kind,uid:tx.uid,playerId:tx.playerId,transactionId:tx.transactionId,eventId:tx.eventId,
 generation:tx.generation,createdAt:tx.createdAt,previous:tx.previous};}
function validate(state,account){
 if(!state||state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||
  !Number.isSafeInteger(state.generation)||state.generation<1||!state.transactions||typeof state.transactions!=='object'||Array.isArray(state.transactions))throw Error('Invalid first gift reset state');
 const rows=Object.values(state.transactions).sort((a,b)=>a.generation-b.generation);
 if(rows.length!==state.generation)throw Error('Missing first gift reset generation');
 let previousTime=0;
 for(let i=0;i<rows.length;i++){
  const tx=rows[i];
  if(!tx||tx.kind!=='public-beta-first-gift-reset'||tx.uid!==account.uid||tx.playerId!==account.playerId||!validId(tx.transactionId)||
   state.transactions[tx.transactionId]!==tx||tx.eventId!==eventId(tx.transactionId)||tx.generation!==i+1||
   !Number.isSafeInteger(tx.createdAt)||tx.createdAt<previousTime||!tx.previous||
   Object.keys(tx.previous).sort().join(',')!=='claim,entitlement,observation'||tx.sha256!==hash(payload(tx))||account.receipts?.[tx.eventId]!==tx.sha256)throw Error('First gift reset has no exact committed receipt');
  previousTime=tx.createdAt;
  if([tx.previous.claim?.claimedAt,tx.previous.entitlement?.issuedAt,tx.previous.observation?.observedAt].some(time=>time!==undefined&&time>tx.createdAt))throw Error('First gift reset predates archived eligibility');
  const snapshot={...account,firstGiftClaim:tx.previous.claim??undefined,firstGiftEntitlement:tx.previous.entitlement??undefined,
   firstGiftObservation:tx.previous.observation??undefined};
  if(i===0)delete snapshot.firstGiftResetState;
  else snapshot.firstGiftResetState={...state,generation:i};
  const gift=require('../player-first-gift');
  if(snapshot.firstGiftObservation)gift.validate(snapshot.firstGiftObservation,snapshot);
  if(snapshot.firstGiftEntitlement)require('../player-recharge').validateFirstGift(snapshot.firstGiftEntitlement,snapshot);
  if(snapshot.firstGiftClaim)gift.validateClaim(snapshot.firstGiftClaim,snapshot);
 }
 if(account.firstGiftEntitlement&&(account.firstGiftEntitlement.generation??0)!==state.generation)throw Error('Active first gift entitlement predates reset');
 return state;
}
function prepare(account,{transactionId,now=Date.now()}={}){
 if(!validId(transactionId)||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(account?.revision)||account.revision<0)throw Error('Invalid first gift reset request');
 if(account.firstGiftResetState)validate(account.firstGiftResetState,account);
 if(Object.hasOwn(account.firstGiftResetState?.transactions||{},transactionId))throw Error('First gift reset already committed');
 const gift=require('../player-first-gift');gift.entitlement(account);
 const tx={kind:'public-beta-first-gift-reset',uid:account.uid,playerId:account.playerId,transactionId,eventId:eventId(transactionId),
  generation:(account.firstGiftResetState?.generation??0)+1,createdAt:now,
  previous:{claim:copy(account.firstGiftClaim??null),entitlement:copy(account.firstGiftEntitlement??null),observation:copy(account.firstGiftObservation??null)}};
 if([tx.previous.claim?.claimedAt,tx.previous.entitlement?.issuedAt,tx.previous.observation?.observedAt].some(time=>time!==undefined&&time>now))throw Error('First gift reset predates eligibility');
 if(account.firstGiftResetState&&now<Math.max(...Object.values(account.firstGiftResetState.transactions).map(row=>row.createdAt)))throw Error('First gift reset time moved backwards');
 tx.sha256=hash(payload(tx));return {expectedRevision:account.revision,eventId:tx.eventId,payload:payload(tx),transaction:tx};
}
function apply(account,prepared){
 if(account.revision!==prepared?.expectedRevision)throw Error('First gift reset account revision changed');
 const expected=prepare(account,{transactionId:prepared.transaction?.transactionId,now:prepared.transaction?.createdAt});
 if(JSON.stringify(expected)!==JSON.stringify(prepared))throw Error('First gift reset preparation changed');
 account.firstGiftResetState??={version:1,uid:account.uid,playerId:account.playerId,generation:0,transactions:{}};
 account.firstGiftResetState.generation=prepared.transaction.generation;
 account.firstGiftResetState.transactions[prepared.transaction.transactionId]=copy(prepared.transaction);
 delete account.firstGiftClaim;delete account.firstGiftEntitlement;
 return {generation:prepared.transaction.generation,status:'unavailable'};
}
module.exports={prepare,apply,validate,payload,eventId,validId};
