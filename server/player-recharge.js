'use strict';
const crypto=require('node:crypto'),vipCatalog=require('./player-vip-catalog');
const copy=value=>JSON.parse(JSON.stringify(value));
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const u32=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;
const uint=value=>u32(value)&&value>0;
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(value);
const eventId=id=>'development-recharge:'+id;
function payload(tx){return {kind:tx.kind,uid:tx.uid,playerId:tx.playerId,transactionId:tx.transactionId,amountMinor:tx.amountMinor,
 createdAt:tx.createdAt,before:tx.before,after:tx.after,thresholdSha256:tx.thresholdSha256,
 ...(tx.firstGiftGeneration===undefined?{}:{firstGiftGeneration:tx.firstGiftGeneration})};}
function validateTransaction(tx,account,catalog=vipCatalog.load()){
 if(!tx||tx.kind!=='development-recharge'||tx.uid!==account.uid||tx.playerId!==account.playerId||!validId(tx.transactionId)||
  tx.eventId!==eventId(tx.transactionId)||!uint(tx.amountMinor)||tx.amountMinor%100!==0||
  !Number.isSafeInteger(tx.createdAt)||tx.createdAt<0||tx.thresholdSha256!==catalog.thresholdSha256)throw Error('Invalid development recharge transaction');
 if(tx.firstGiftGeneration!==undefined&&(!Number.isSafeInteger(tx.firstGiftGeneration)||tx.firstGiftGeneration<1))throw Error('Invalid first gift recharge generation');
 for(const section of ['before','after']){
  const v=tx[section];if(!v||!u32(v.diamond)||!u32(v.rechargeTotal)||!u32(v.vipPoints)||!Number.isInteger(v.vipLevel)||v.vipLevel<0||v.vipLevel>12)throw Error('Invalid recharge account balances');
 }
 const a=tx.after,b=tx.before;
 if(a.diamond!==b.diamond+tx.amountMinor||a.rechargeTotal!==b.rechargeTotal+tx.amountMinor||a.vipPoints!==b.vipPoints+tx.amountMinor/100||
  a.vipLevel!==vipCatalog.levelFor(a.rechargeTotal,catalog.thresholdMinor)||a.vipLevel<b.vipLevel||tx.sha256!==hash(payload(tx)))throw Error('Development recharge arithmetic or receipt mismatch');
 return tx;
}
function validate(state,account,catalog=vipCatalog.load()){
 if(!state||state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||!state.transactions||typeof state.transactions!=='object'||Array.isArray(state.transactions))throw Error('Invalid recharge state');
 for(const [id,tx]of Object.entries(state.transactions)){
  validateTransaction(tx,account,catalog);
  if(id!==tx.transactionId||account.receipts?.[tx.eventId]!==tx.sha256)throw Error('Recharge transaction has no committed receipt');
 }
 return state;
}
function prepare(account,wallet,{transactionId,diamonds,now=Date.now(),catalog=vipCatalog.load()}={}){
 if(!account||!uint(account.uid)||!uint(account.playerId)||!Number.isSafeInteger(account.revision)||account.revision<0||!validId(transactionId)||
  !Number.isSafeInteger(diamonds)||diamonds<1||!uint(diamonds*100)||!Number.isSafeInteger(now)||now<0)throw Error('Invalid development recharge request');
 if(account.rechargeState)validate(account.rechargeState,account,catalog);
 if(Object.hasOwn(account.rechargeState?.transactions||{},transactionId))throw Error('Development recharge already committed');
 const attrs=wallet?.attrs,before={diamond:attrs?.[72],rechargeTotal:attrs?.[91],vipPoints:attrs?.[52],vipLevel:account.vip?.level};
 const amountMinor=diamonds*100,after={diamond:before.diamond+amountMinor,rechargeTotal:before.rechargeTotal+amountMinor,
  vipPoints:before.vipPoints+diamonds,vipLevel:vipCatalog.levelFor(before.rechargeTotal+amountMinor,catalog.thresholdMinor)};
 const transaction={kind:'development-recharge',uid:account.uid,playerId:account.playerId,transactionId,eventId:eventId(transactionId),
  amountMinor,createdAt:now,before,after,thresholdSha256:catalog.thresholdSha256};
 if(account.firstGiftResetState){
  require('./public-beta/first-gift-reset').validate(account.firstGiftResetState,account);
  transaction.firstGiftGeneration=account.firstGiftResetState.generation;
 }
 transaction.sha256=hash(payload(transaction));validateTransaction(transaction,account,catalog);
 return {expectedRevision:account.revision,eventId:transaction.eventId,payload:payload(transaction),transaction};
}
// Run inside the existing account+wallet economy commit. PlayerAccounts.update
// appends the exact payload digest; no assets can be committed by this helper.
function apply(account,wallet,prepared,{catalog=vipCatalog.load()}={}){
 const tx=validateTransaction(prepared?.transaction,account,catalog);
 if(account.revision!==prepared.expectedRevision||prepared.eventId!==tx.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(payload(tx)))throw Error('Stale or changed recharge preparation');
 if(account.rechargeState)validate(account.rechargeState,account,catalog);
 if(Object.hasOwn(account.rechargeState?.transactions||{},tx.transactionId))throw Error('Development recharge already committed');
 if((tx.firstGiftGeneration??0)!==(account.firstGiftResetState?.generation??0))throw Error('First gift reset changed after recharge preparation');
 const attrs=wallet?.attrs,b=tx.before;
 if(attrs?.[72]!==b.diamond||attrs?.[91]!==b.rechargeTotal||attrs?.[52]!==b.vipPoints||account.vip?.level!==b.vipLevel)throw Error('Recharge balances changed');
 account.rechargeState??={version:1,uid:account.uid,playerId:account.playerId,transactions:{}};
 account.rechargeState.transactions[tx.transactionId]=copy(tx);
 account.vip={version:1,level:tx.after.vipLevel,observedAt:tx.createdAt,source:tx.eventId,receiptSha256:tx.sha256};
 // A GM reset starts a new eligibility cycle, without erasing historical
 // observations or any currency/VIP progress. Only a new recharge opens it.
 if(!account.firstGiftClaim&&(account.firstGiftResetState||account.firstGiftObservation?.status!=='claimed')&&!account.firstGiftEntitlement){
  account.firstGiftEntitlement={version:1,uid:account.uid,playerId:account.playerId,amountMinor:tx.amountMinor,
   issuedAt:tx.createdAt,source:tx.eventId,receiptSha256:tx.sha256,
   ...(tx.firstGiftGeneration===undefined?{}:{generation:tx.firstGiftGeneration})};
 }
 attrs[72]=tx.after.diamond;attrs[91]=tx.after.rechargeTotal;attrs[52]=tx.after.vipPoints;attrs[89]=tx.after.vipLevel;
 return {transactionId:tx.transactionId,vipLevel:tx.after.vipLevel,diamonds:tx.amountMinor/100,
  newlyReachedLevels:Array.from({length:tx.after.vipLevel-b.vipLevel},(_,i)=>b.vipLevel+i+1)};
}
function validateVip(state,account,catalog=vipCatalog.load()){
 const id=String(state?.source||'').replace(/^development-recharge:/,'');
 if(state?.source!==eventId(id)||!validId(id))throw Error('Invalid development VIP provenance');
 const tx=account.rechargeState?.transactions?.[id];validate(account.rechargeState,account,catalog);
 if(!tx||state.receiptSha256!==tx.sha256||state.level!==tx.after.vipLevel||state.observedAt!==tx.createdAt)throw Error('VIP state differs from committed recharge');
 return state;
}
function validateFirstGift(entitlement,account,catalog=vipCatalog.load()){
 if(!entitlement||entitlement.version!==1||entitlement.uid!==account.uid||entitlement.playerId!==account.playerId)throw Error('Invalid first recharge entitlement identity');
 const id=String(entitlement.source||'').replace(/^development-recharge:/,'');
 validate(account.rechargeState,account,catalog);const tx=account.rechargeState.transactions[id];
 if(!tx||entitlement.source!==tx.eventId||entitlement.receiptSha256!==tx.sha256||entitlement.amountMinor!==tx.amountMinor||entitlement.issuedAt!==tx.createdAt)throw Error('First recharge entitlement has no matching recharge receipt');
 if((entitlement.generation??0)!==(tx.firstGiftGeneration??0))throw Error('First gift recharge generation differs from receipt');
 if(entitlement.generation!==undefined){
  const reset=Object.values(account.firstGiftResetState?.transactions||{}).find(row=>row.generation===entitlement.generation);
  if(!reset||tx.createdAt<reset.createdAt)throw Error('First gift entitlement predates reset');
 }
 return entitlement;
}
module.exports={prepare,apply,validate,validateTransaction,validateVip,validateFirstGift,payload,eventId};
