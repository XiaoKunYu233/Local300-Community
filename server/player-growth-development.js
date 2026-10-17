'use strict';
const crypto=require('node:crypto'),catalog=require('./player-growth-catalog').load();
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const eventId=id=>'development-growth:'+id;
function payload(event){return {kind:event.kind,uid:event.uid,playerId:event.playerId,eventId:event.eventId,transactionId:event.transactionId,
 level:event.level,experience:event.experience,createdAt:event.createdAt,catalogSha256:event.catalogSha256,before:event.before};}
function validateEvent(event,account){
 if(!event||event.kind!=='development-growth'||event.uid!==account.uid||event.playerId!==account.playerId||!validId(event.transactionId)||event.eventId!==eventId(event.transactionId)||
  !Number.isSafeInteger(event.createdAt)||event.createdAt<0||event.level!==catalog.maxLevel||event.experience!==0||event.catalogSha256!==catalog.sourceSha256||
  !event.before||!Number.isInteger(event.before.level)||event.before.level<1||event.before.level>catalog.maxLevel||
  !(event.before.experience===null||Number.isInteger(event.before.experience)&&event.before.experience>=0&&event.before.experience<=0x7fffffff)||typeof event.before.source!=='string'||
  event.sha256!==hash(payload(event)))throw Error('Invalid development level-cap event');
 return event;
}
function validate(state,account){
 if(!state||state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||!state.events||typeof state.events!=='object'||Array.isArray(state.events))throw Error('Invalid development growth state');
 for(const [id,event]of Object.entries(state.events)){
  validateEvent(event,account);if(id!==event.transactionId||account.receipts?.[event.eventId]!==event.sha256)throw Error('Development growth has no committed receipt');
 }
 return state;
}
function prepare(account,{transactionId,level=catalog.maxLevel,experience=0,now=Date.now()}={}){
 if(!account||!positive(account.uid)||!positive(account.playerId)||!Number.isSafeInteger(account.revision)||account.revision<0||!validId(transactionId)||
  level!==catalog.maxLevel||experience!==0||!Number.isSafeInteger(now)||now<0)throw Error('Invalid development level-cap request');
 if(account.growthDevelopmentState)validate(account.growthDevelopmentState,account);
 if(account.growthDevelopmentState?.events?.[transactionId])throw Error('Development level-cap event already committed');
 const old=require('./player-growth-wire').validate(account.growth,account);
 const event={kind:'development-growth',uid:account.uid,playerId:account.playerId,eventId:eventId(transactionId),transactionId,level,experience,
  createdAt:now,catalogSha256:catalog.sourceSha256,before:{level:old.level,experience:old.experience??null,source:old.source}};
 event.sha256=hash(payload(event));validateEvent(event,account);
 return {expectedRevision:account.revision,eventId:event.eventId,payload:payload(event),event};
}
function apply(account,prepared){
 const event=validateEvent(prepared?.event,account);
 if(account.revision!==prepared.expectedRevision||prepared.eventId!==event.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(payload(event)))throw Error('Stale or changed development growth preparation');
 if(account.growthDevelopmentState)validate(account.growthDevelopmentState,account);
 if(account.growthDevelopmentState?.events?.[event.transactionId])throw Error('Development level-cap event already committed');
 const before={level:account.growth?.level,experience:account.growth?.experience??null,source:account.growth?.source};
 if(JSON.stringify(before)!==JSON.stringify(event.before))throw Error('Player growth changed');
 account.growthDevelopmentState??={version:1,uid:account.uid,playerId:account.playerId,events:{}};
 account.growthDevelopmentState.events[event.transactionId]=copy(event);
 account.growth={version:1,level:event.level,experience:event.experience,observedAt:event.createdAt,source:event.eventId,receiptSha256:event.sha256};
 return {level:event.level,experience:event.experience};
}
function validateGrowth(growth,account){
 validate(account.growthDevelopmentState,account);
 const id=String(growth?.source||'').replace(/^development-growth:/,''),event=account.growthDevelopmentState.events[id];
 if(!event||growth.source!==event.eventId||growth.level!==event.level||growth.experience!==event.experience||growth.observedAt!==event.createdAt||growth.receiptSha256!==event.sha256)throw Error('Player growth differs from development receipt');
 return growth;
}
module.exports={prepare,apply,validate,validateGrowth,validateEvent,payload,eventId};
