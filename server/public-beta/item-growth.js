'use strict';
// The client supplies explicit XP amounts and next-level UI thresholds. Carry
// and cap handling below are an explicit development policy, not native award
// evidence. No level milestones, currency or ownership rewards are inferred.
const crypto=require('node:crypto'),path=require('node:path'),items=require('./gm-items'),growth=require('../player-growth-catalog').load();
const copy=value=>JSON.parse(JSON.stringify(value));
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const policy='development-next-level-threshold-carry-v1';
function progress(before,amount){
 if(!Number.isInteger(before?.level)||before.level<1||before.level>growth.maxLevel||!Number.isInteger(before.experience)||before.experience<0||before.experience>0x7fffffff||!uint(amount))throw Error('经验基线尚未准备完成');
 if(before.level===growth.maxLevel)throw Error('等级已达到上限，经验道具未消耗');
 let level=before.level,experience=before.experience+amount;
 while(level<growth.maxLevel&&experience>=growth.levels[level].requiredExperience){experience-=growth.levels[level].requiredExperience;level++;}
 if(level===growth.maxLevel)experience=0;
 if(experience>0x7fffffff)throw Error('经验超过客户端上限');return {level,experience};
}
function payload(event){const {sha256,...data}=event;return copy(data);}
function validateEvent(event,account){
 const expected=['kind','uid','playerId','eventId','createdAt','before','after','itemId','guid','count','revision','amount','itemCatalogSha256','growthCatalogSha256','policy','sha256'];
 if(!object(event)||Object.keys(event).sort().join('|')!==expected.sort().join('|')||event.kind!=='item-growth'||event.uid!==account.uid||event.playerId!==account.playerId||
  !Number.isSafeInteger(event.createdAt)||event.createdAt<0||!Number.isSafeInteger(event.revision)||event.revision<0||!Number.isInteger(event.count)||event.count<1||event.count>65535||
  !/^[a-f0-9]{16}$/.test(event.guid)||/^0+$/.test(event.guid)||event.eventId!==`item-growth:${event.guid}:${event.revision}`||event.policy!==policy||event.growthCatalogSha256!==growth.sourceSha256||event.sha256!==digest(payload(event)))throw Error('Invalid item experience event');
 const rule=items.experience(event.itemId);
 if(!rule||event.amount!==rule.amount||event.itemCatalogSha256!==rule.catalogSha256||JSON.stringify(event.after)!==JSON.stringify(progress(event.before,event.amount)))throw Error('Experience event differs from current item policy');
 return event;
}
function validate(state,account){
 if(!object(state)||Object.keys(state).sort().join('|')!=='events|playerId|uid|version'||state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||!object(state.events))throw Error('Invalid item experience state');
 for(const [id,event]of Object.entries(state.events)){
  validateEvent(event,account);if(id!==event.eventId||account.receipts?.[id]!==event.sha256)throw Error('Item experience has no committed receipt');
 }
 return state;
}
function validateGrowth(value,account){
 validate(account.itemGrowthState,account);const event=account.itemGrowthState.events[value.source];
 if(!event||value.level!==event.after.level||value.experience!==event.after.experience||value.observedAt!==event.createdAt||value.receiptSha256!==event.sha256)throw Error('Growth differs from item experience receipt');return value;
}
function prepare(account,instance,{now=Date.now()}={}){
 const rule=items.experience(instance?.itemId);if(!rule)return null;
 if(!uint(account?.uid)||!uint(account.playerId)||!Number.isSafeInteger(account.revision)||account.revision<0||!Number.isSafeInteger(now)||now<0||
  !/^[a-f0-9]{16}$/i.test(instance.guid)||/^0+$/.test(instance.guid)||!Number.isInteger(instance.count)||instance.count<1||instance.count>65535)throw Error('Invalid owned experience item');
 require('../player-growth-wire').validate(account.growth,account);if(account.itemGrowthState)validate(account.itemGrowthState,account);
 const guid=instance.guid.toLowerCase(),event={kind:'item-growth',uid:account.uid,playerId:account.playerId,eventId:`item-growth:${guid}:${account.revision}`,createdAt:now,
  before:copy(account.growth),after:progress(account.growth,rule.amount),itemId:instance.itemId,guid,count:instance.count,revision:account.revision,amount:rule.amount,
  itemCatalogSha256:rule.catalogSha256,growthCatalogSha256:growth.sourceSha256,policy};
 event.sha256=digest(payload(event));validateEvent(event,account);
 return {expectedRevision:account.revision,eventId:event.eventId,payload:payload(event),event};
}
function apply(account,prepared){
 const event=validateEvent(prepared?.event,account);
 if(account.revision!==prepared.expectedRevision||account.revision!==event.revision||prepared.eventId!==event.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(payload(event))||JSON.stringify(account.growth)!==JSON.stringify(event.before))throw Error('Stale or changed experience item preparation');
 if(account.itemGrowthState)validate(account.itemGrowthState,account);
 if(Object.hasOwn(account.receipts,event.eventId))throw Error('Experience item already committed');
 account.itemGrowthState??={version:1,uid:account.uid,playerId:account.playerId,events:{}};
 account.itemGrowthState.events[event.eventId]=copy(event);
 account.growth={version:1,...event.after,observedAt:event.createdAt,source:event.eventId,receiptSha256:event.sha256};
 return copy(event.after);
}
function frames(account,{flags=0xd6}={}){
 require('../player-growth-wire').validate(account.growth,account);
 const p=Buffer.alloc(11);p[0]=2;p[1]=110;p.writeUInt32LE(account.growth.level,2);p[6]=111;p.writeInt32LE(account.growth.experience,7);
 return [require('../bag').mkFrame(1045,p,{stream:account.playerId,flags})];
}
function useSlot(context,slot){
 const instance=context?.bag?.get(slot);if(!items.experience(instance?.itemId))return null;
 if(context.enabled!==true||typeof context.isFrozen!=='function'||context.isFrozen()||typeof context.inBattle!=='function'||context.inBattle()||context.commit?.frozen||
  !Number.isInteger(context.capacity)||!Number.isInteger(slot)||slot<0||slot>=context.capacity||!(context.reserved instanceof Set)||context.reserved.has(slot)||
  !path.isAbsolute(context.bagPath||'')||typeof context.saveBag!=='function'||typeof context.replaceBag!=='function')throw Error('经验道具当前不可使用，道具未消耗');
 const account=context.store.get(context.uid);
 if(account?.uid!==context.uid||account.playerId!==context.playerId)throw Error('Experience item account mismatch');
 const relative=path.relative(path.dirname(context.store.file),context.bagPath);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Experience bag path leaves account directory');
 const prepared=prepare(account,instance,{now:context.now?context.now():Date.now()}),next=new Map(context.bag);
 if(instance.count===1)next.delete(slot);else next.set(slot,{...instance,count:instance.count-1});
 if(!context.commit.run('public-beta-item-experience',prepared.eventId,[
  {name:'bag',path:context.bagPath,save:()=>context.saveBag(next)},
  {name:'player-accounts',path:context.store.file,save:()=>context.store.update(context.uid,{expectedRevision:prepared.expectedRevision,eventId:prepared.eventId,payload:prepared.payload},a=>apply(a,prepared))},
 ]))throw Error('经验道具事务未完成');
 context.replaceBag(next);
 return {slot,itemId:instance.itemId,guid:instance.guid,remaining:instance.count-1,frames:frames(context.store.get(context.uid),{flags:context.flags??0xd6})};
}
module.exports={prepare,apply,validate,validateEvent,validateGrowth,progress,payload,frames,useSlot};
