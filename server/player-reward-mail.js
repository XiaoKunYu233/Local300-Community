'use strict';
// Explicit online/VIP rewards create owned game mails, never assets.
// Attachment delivery and its pending journal belong to the mail claim handler.
const crypto=require('node:crypto'),wire=require('./player-online-protocol');
const {chinaDay,claimOnline}=require('./player-account-state'),{mkFrame}=require('./bag');
const mailgen=require('./mailgen'),GBK=require('./gbk');
const copy=value=>JSON.parse(JSON.stringify(value));
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const millis=value=>Number.isSafeInteger(value)&&value>=0&&Math.floor(value/1000)<=0xffffffff;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function keys(value,expected){if(!object(value)||Object.keys(value).sort().join('|')!==expected.slice().sort().join('|'))throw Error('Invalid reward mail fields');}
function authorize(account,context){
 if(!account||!uint(account.uid)||!uint(account.playerId)||context?.authenticated!==true||context?.frozen!==false||
   context.uid!==account.uid||context.playerId!==account.playerId)throw Error('Reward mail account unavailable');
}
function eventId(day,tier){return `reward-mail:online:${day}:${tier}`;}
function payload(mail){if(mail.kind==='vip-bundle')return copy(mail);return mail.kind==='online'?{kind:'online',uid:mail.uid,playerId:mail.playerId,mailId:mail.mailId,createdAt:mail.createdAt,day:mail.day,tier:mail.tier,
 itemId:mail.attachments[0].itemId,count:mail.attachments[0].count}:{kind:mail.kind,uid:mail.uid,playerId:mail.playerId,mailId:mail.mailId,createdAt:mail.createdAt,
 tier:mail.tier,eventId:mail.eventId,source:mail.source,catalogSha256:mail.catalogSha256,attachments:copy(mail.attachments)};}
function splitAttachments(items){
 if(!Array.isArray(items)||!items.length)throw Error('Empty VIP reward attachments');
 const out=[];
 for(const item of items){
  keys(item,['itemId','count']);
  if(!Number.isInteger(item.itemId)||item.itemId<1||item.itemId>=65535||!uint(item.count))throw Error('Invalid VIP reward attachment');
  // The mail grant path accepts at most u16 quantity per item reward. Keep
  // chunks separate through resolveAttachments and inventory preflight;
  // joining V12 coins into 100000 would fail before the mail can be claimed.
  for(let remaining=item.count;remaining>0;remaining-=0xffff)out.push({itemId:item.itemId,count:Math.min(remaining,0xffff)});
 }
 if(out.length>100)throw Error('VIP reward attachment batch exceeds server limit');
 return out;
}
function vipRule(account,kind,tier,catalog=require('./player-vip-catalog').load()){
 if(!['vip-level','vip-privilege'].includes(kind)||!Number.isInteger(tier)||tier<(kind==='vip-level'?1:0)||tier>12||
  !Number.isInteger(account.vip?.level)||account.vip.level<tier||account.vip.level>12)throw Error('VIP reward tier is unavailable');
 const items=kind==='vip-level'?catalog.gifts[tier]:catalog.privilegeGifts[tier],catalogSha256=kind==='vip-level'?catalog.giftSha256:catalog.privilegeGiftSha256;
 if(!/^[a-f0-9]{64}$/.test(catalogSha256||''))throw Error('Invalid VIP reward catalog revision');
 return {kind,tier,uid:account.uid,playerId:account.playerId,source:'development-vip-rewards',eventId:`reward-mail:${kind}:${account.uid}:${tier}`,
  catalogSha256,attachments:copy(items)};
}
function validateVipMail(mail,account,catalog){
 keys(mail,['mailId','uid','playerId','kind','tier','createdAt','eventId','attachments','source','catalogSha256']);
 const rule=vipRule(account,mail.kind,mail.tier,catalog);
 if(!uint(mail.mailId)||mail.uid!==account.uid||mail.playerId!==account.playerId||!millis(mail.createdAt)||mail.eventId!==rule.eventId||
  mail.source!==rule.source||mail.catalogSha256!==rule.catalogSha256||JSON.stringify(mail.attachments)!==JSON.stringify(splitAttachments(rule.attachments)))throw Error('VIP mail differs from verified reward catalog');
 return mail;
}
function validateMail(mail,account){
 if(mail?.kind==='vip-bundle')return validateConsolidation(mail,account);
 if(mail?.kind==='vip-level'||mail?.kind==='vip-privilege')return validateVipMail(mail,account);
 keys(mail,['mailId','uid','playerId','kind','day','tier','createdAt','eventId','attachments']);
 if(!uint(mail.mailId)||mail.uid!==account.uid||mail.playerId!==account.playerId||mail.kind!=='online'||
   !millis(mail.createdAt)||chinaDay(mail.createdAt)!==mail.day||!Number.isInteger(mail.tier)||mail.tier<1||mail.tier>5||
   mail.eventId!==eventId(mail.day,mail.tier)||!Array.isArray(mail.attachments)||mail.attachments.length!==1)throw Error('Invalid owned reward mail');
 keys(mail.attachments[0],['itemId','count']);
 const gift=wire.gifts().find(row=>row.tier===mail.tier),attachment=mail.attachments[0];
 if(attachment.itemId!==gift.itemId||attachment.count!==gift.count)throw Error('Reward mail differs from verified gift');
 return mail;
}
function validate(state,account){
 keys(state,['version','uid','playerId','mails',...(state?.consolidations!==undefined?['consolidations']:[])]);
 if(state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||!object(state.mails))throw Error('Invalid reward mailbox');
 const retiredIds=new Set(),retiredEvents=new Set();
 if(state.consolidations!==undefined){
  if(!object(state.consolidations))throw Error('Invalid reward mail consolidations');
  for(const [event,consolidation]of Object.entries(state.consolidations)){
   validateConsolidation(consolidation,account);
   if(event!==consolidation.eventId||account.receipts?.[event]!==digest(payload(consolidation)))throw Error('VIP consolidation has no committed receipt');
   for(const member of consolidation.sourceMails){
    if(retiredIds.has(member.mail.mailId)||retiredEvents.has(member.mail.eventId)||Object.hasOwn(state.mails,String(member.mail.mailId)))throw Error('VIP consolidation source remains active or was reused');
    retiredIds.add(member.mail.mailId);retiredEvents.add(member.mail.eventId);
   }
   const active=consolidation.mailId===null?null:state.mails[consolidation.mailId];
   if(consolidation.mailId!==null&&JSON.stringify(active)!==JSON.stringify(consolidation))throw Error('VIP bundle differs from consolidation audit');
  }
 }
 const events=new Set();
 for(const [id,mail]of Object.entries(state.mails)){
  validateMail(mail,account);
  if(retiredIds.has(mail.mailId)||retiredEvents.has(mail.eventId)||mail.kind==='vip-bundle'&&JSON.stringify(state.consolidations?.[mail.eventId])!==JSON.stringify(mail))throw Error('Conflicting consolidated reward mail');
  if(String(mail.mailId)!==id||events.has(mail.eventId)||mail.kind==='online'&&!account.online?.days?.[mail.day]?.claimed?.includes(mail.tier))throw Error('Conflicting reward mail claim');
  const expected=crypto.createHash('sha256').update(JSON.stringify(payload(mail))).digest('hex');
  if(account.receipts?.[mail.eventId]!==expected)throw Error('Reward mail has no committed receipt');
  events.add(mail.eventId);
 }
 return state;
}
function mailbox(account){if(account.rewardMailState!==undefined)validate(account.rewardMailState,account);return account.rewardMailState?.mails||{};}
function retiredMailIds(account){return Object.values(account.rewardMailState?.consolidations||{}).flatMap(record=>record.sourceMails.map(member=>member.mail.mailId));}
function occupiedMailId(account,id){return Object.hasOwn(mailbox(account),String(id))||retiredMailIds(account).includes(id);}
function mailClaimSnapshot(value){
 if(!object(value)||!['claimed','read','pending'].every(key=>Array.isArray(value[key])))throw Error('Explicit current mail claim snapshot required');
 const result={};
 for(const key of ['claimed','read','pending']){
  if(value[key].some(id=>!uint(id))||new Set(value[key]).size!==value[key].length)throw Error('Invalid mail claim snapshot IDs');
  result[key]=value[key].slice().sort((a,b)=>a-b);
 }
 if(result.pending.length)throw Error('Unresolved mail claims cannot be consolidated');
 if(result.claimed.some(id=>!result.read.includes(id)))throw Error('Claimed mail snapshot must also be read');
 return result;
}
function aggregateAttachments(items){
 if(!Array.isArray(items))throw Error('Invalid aggregate reward attachments');
 const counts=new Map();
 for(const item of items){
  keys(item,['itemId','count']);
  if(!Number.isInteger(item.itemId)||item.itemId<1||item.itemId>=65535||!uint(item.count))throw Error('Invalid aggregate reward attachment');
  const total=(counts.get(item.itemId)||0)+item.count;
  if(!uint(total))throw Error('Aggregated reward quantity overflow');
  counts.set(item.itemId,total);
 }
 return [...counts].sort((a,b)=>a[0]-b[0]).map(([itemId,count])=>({itemId,count}));
}
function consolidationEvent(uid,manifestSha256){return `reward-mail:vip-bundle:${uid}:${manifestSha256}`;}
function validateConsolidation(record,account){
 keys(record,['mailId','uid','playerId','kind','createdAt','eventId','attachments','source','sourceMails','manifestSha256']);
 if(record.uid!==account.uid||record.playerId!==account.playerId||record.kind!=='vip-bundle'||record.source!=='development-vip-rewards'||!millis(record.createdAt)||
  !Array.isArray(record.sourceMails)||!record.sourceMails.length||record.sourceMails.length>25||!/^[a-f0-9]{64}$/.test(record.manifestSha256)||
  record.manifestSha256!==digest(record.sourceMails)||record.eventId!==consolidationEvent(account.uid,record.manifestSha256))throw Error('Invalid VIP consolidation identity or manifest');
 const ids=new Set(),events=new Set();let previous=0;
 for(const member of record.sourceMails){
  keys(member,['mail','receiptSha256','claimed','read']);
  validateVipMail(member.mail,account);
  if(typeof member.claimed!=='boolean'||typeof member.read!=='boolean'||member.claimed&&!member.read||member.mail.createdAt>record.createdAt||
   member.mail.mailId<=previous||ids.has(member.mail.mailId)||events.has(member.mail.eventId)||member.receiptSha256!==digest(payload(member.mail))||
   account.receipts?.[member.mail.eventId]!==member.receiptSha256)throw Error('VIP consolidation source has no exact original receipt');
  ids.add(member.mail.mailId);events.add(member.mail.eventId);previous=member.mail.mailId;
 }
 const expected=aggregateAttachments(record.sourceMails.filter(member=>!member.claimed).flatMap(member=>member.mail.attachments));
 if(JSON.stringify(record.attachments)!==JSON.stringify(expected)||(expected.length?(!uint(record.mailId)||ids.has(record.mailId)):record.mailId!==null))throw Error('VIP bundle attachments differ from unclaimed sources');
 return record;
}
function prepareConsolidation(account,context){
 authorize(account,context);const current=mailbox(account),claims=mailClaimSnapshot(context.mailState);
 if(!Number.isSafeInteger(account.revision)||account.revision<0||!millis(context.now))throw Error('Invalid VIP consolidation preparation');
 const sources=Object.values(current).filter(mail=>['vip-level','vip-privilege'].includes(mail.kind)&&mail.source==='development-vip-rewards').sort((a,b)=>a.mailId-b.mailId);
 if(!sources.length)return {unchanged:true,reason:'no-single-vip-mails'};
 const sourceMails=sources.map(mail=>({mail:copy(mail),receiptSha256:account.receipts[mail.eventId],claimed:claims.claimed.includes(mail.mailId),read:claims.read.includes(mail.mailId)}));
 const attachments=aggregateAttachments(sourceMails.filter(member=>!member.claimed).flatMap(member=>member.mail.attachments));
 const occupiedIds=context.occupiedIds||[];
 if(!Array.isArray(occupiedIds)||occupiedIds.some(id=>!uint(id)))throw Error('Invalid occupied mail IDs');
 const mailId=attachments.length?(context.mailId===undefined?allocateMailId(account,occupiedIds):context.mailId):null;
 if(mailId!==null&&(!uint(mailId)||occupiedMailId(account,mailId)||occupiedIds.includes(mailId)))throw Error('Conflicting VIP bundle mail ID');
 const manifestSha256=digest(sourceMails),consolidation={mailId,uid:account.uid,playerId:account.playerId,kind:'vip-bundle',createdAt:context.now,
  eventId:consolidationEvent(account.uid,manifestSha256),attachments,source:'development-vip-rewards',sourceMails,manifestSha256};
 validateConsolidation(consolidation,account);
 if(Object.hasOwn(account.receipts,consolidation.eventId))throw Error('VIP consolidation event already committed');
 return {expectedRevision:account.revision,eventId:consolidation.eventId,payload:payload(consolidation),consolidation,
  mail:mailId===null?null:copy(consolidation),retiredMailIds:sources.map(mail=>mail.mailId),expectedMailStateHash:digest(claims)};
}
function applyConsolidation(account,prepared,context){
 authorize(account,context);mailbox(account);
 keys(prepared,['expectedRevision','eventId','payload','consolidation','mail','retiredMailIds','expectedMailStateHash']);
 const claims=mailClaimSnapshot(context.mailState);
 if(prepared.expectedRevision!==account.revision||prepared.expectedMailStateHash!==digest(claims)||!millis(context.now)||context.now<prepared.consolidation?.createdAt)throw Error('Stale VIP consolidation account or mail claims');
 const expected=prepareConsolidation(account,{...context,now:prepared.consolidation.createdAt,mailId:prepared.consolidation.mailId});
 if(JSON.stringify(prepared)!==JSON.stringify(expected))throw Error('Changed VIP consolidation preparation');
 const next=copy(account.rewardMailState);
 for(const id of prepared.retiredMailIds)delete next.mails[id];
 next.consolidations??={};next.consolidations[prepared.eventId]=copy(prepared.consolidation);
 if(prepared.mail)next.mails[prepared.mail.mailId]=copy(prepared.mail);
 account.rewardMailState=next;
 // PlayerAccounts.update appends this complete audit payload's receipt after
 // the callback, in the same commit. Actual mail claim history is untouched.
 return {mailId:prepared.mail?.mailId||null,retiredMailIds:prepared.retiredMailIds.slice(),pendingSources:prepared.consolidation.sourceMails.filter(member=>!member.claimed).length};
}
function strictHeader(frame,tag,length){
 if(!Buffer.isBuffer(frame)||frame.length!==length||frame.readUInt32LE(0)!==length||frame.readUInt32LE(4)!==0||
   frame.readUInt16LE(8)!==tag||frame.readUInt16LE(10)!==0)throw Error('Invalid reward mail native request');
}
function onlineRequest(frame){
 if(!Buffer.isBuffer(frame)||frame.length<12)throw Error('Invalid online native request');
 const tag=frame.readUInt16LE(8);if(![11532,11543,11545,11547].includes(tag))return null;
 strictHeader(frame,tag,tag===11545?13:12);return wire.parse(tag,frame.subarray(12));
}
function request(frame){
 if(!Buffer.isBuffer(frame)||frame.length<12)throw Error('Invalid mail native request');
 const tag=frame.readUInt16LE(8);if(![20303,20305,20306,20307].includes(tag))return null;
 strictHeader(frame,tag,tag===20307?12:tag===20305?17:16);
 if(tag===20307)return {operation:'list'};
 const mailId=frame.readUInt32LE(12);if(!uint(mailId)||tag===20305&&frame[16]!==5)throw Error('Invalid mail ID or claim selector');
 return {operation:tag===20305?'claim':tag===20303?'delete':'read',mailId};
}
function allocateMailId(account,occupiedIds=[]){
 const occupied=new Set([...Object.keys(mailbox(account)).map(Number),...retiredMailIds(account)]);
 if(!Array.isArray(occupiedIds)||occupiedIds.some(id=>!uint(id)))throw Error('Invalid occupied mail IDs');
 for(const id of occupiedIds)occupied.add(id);
 for(let attempt=0;attempt<128;attempt++){const id=crypto.randomInt(1,0x100000000);if(!occupied.has(id))return id;}
 throw Error('Unable to allocate a unique mail ID');
}
function prepareOnline(account,tier,context){
 authorize(account,context);mailbox(account);
 if(!Number.isSafeInteger(account.revision)||account.revision<0||!millis(context.now))throw Error('Invalid online mail preparation');
 const draft=copy(account),reward=claimOnline(draft,tier,wire.gifts(),context.now);
 const occupiedIds=context.occupiedIds||[];if(!Array.isArray(occupiedIds)||occupiedIds.some(id=>!uint(id)))throw Error('Invalid occupied mail IDs');
 const mailId=context.mailId===undefined?allocateMailId(account,occupiedIds):context.mailId;
 if(!uint(mailId)||occupiedMailId(account,mailId)||occupiedIds.includes(mailId))throw Error('Conflicting reward mail ID');
 const day=chinaDay(context.now),mail={mailId,uid:account.uid,playerId:account.playerId,kind:'online',day,tier,
  createdAt:context.now,eventId:eventId(day,tier),attachments:[reward]};
 validateMail(mail,account);
 return {expectedRevision:account.revision,eventId:mail.eventId,payload:payload(mail),mail};
}
function applyOnline(account,prepared,context){
 authorize(account,context);mailbox(account);keys(prepared,['expectedRevision','eventId','payload','mail']);
 validateMail(prepared.mail,account);
 if(prepared.expectedRevision!==account.revision||prepared.eventId!==prepared.mail.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(payload(prepared.mail))||
   !millis(context.now)||context.now<prepared.mail.createdAt||chinaDay(context.now)!==prepared.mail.day)throw Error('Stale or changed online mail preparation');
 if(occupiedMailId(account,prepared.mail.mailId))throw Error('Conflicting reward mail ID');
 claimOnline(account,prepared.mail.tier,wire.gifts(),context.now);
 account.rewardMailState??={version:1,uid:account.uid,playerId:account.playerId,mails:{}};
 account.rewardMailState.mails[prepared.mail.mailId]=copy(prepared.mail);
 // PlayerAccounts.update appends the matching event receipt after this callback.
 return {mailId:prepared.mail.mailId,eventId:prepared.eventId};
}
function prepareVip(account,plan,context){
 authorize(account,context);mailbox(account);
 if(!Number.isSafeInteger(account.revision)||account.revision<0||!millis(context.now))throw Error('Invalid VIP mail preparation');
 keys(plan,['kind','tier','source','uid','playerId','eventId','catalogSha256','attachments']);
 const catalog=context.catalog||require('./player-vip-catalog').load(),expected=vipRule(account,plan.kind,plan.tier,catalog);
 if(JSON.stringify(plan)!==JSON.stringify(expected)){
  // Object key order is not authority; compare each declared field exactly.
  for(const key of Object.keys(expected))if(JSON.stringify(plan[key])!==JSON.stringify(expected[key]))throw Error('VIP mail plan changed or belongs to another account');
 }
 if(Object.hasOwn(account.receipts||{},plan.eventId)||Object.values(mailbox(account)).some(mail=>mail.eventId===plan.eventId))throw Error('VIP reward mail already issued');
 const occupiedIds=context.occupiedIds||[];
 if(!Array.isArray(occupiedIds)||occupiedIds.some(id=>!uint(id)))throw Error('Invalid occupied mail IDs');
 const mailId=context.mailId===undefined?allocateMailId(account,occupiedIds):context.mailId;
 if(!uint(mailId)||occupiedMailId(account,mailId)||occupiedIds.includes(mailId))throw Error('Conflicting reward mail ID');
 const mail={mailId,uid:account.uid,playerId:account.playerId,kind:plan.kind,tier:plan.tier,createdAt:context.now,eventId:plan.eventId,
  source:plan.source,catalogSha256:plan.catalogSha256,attachments:splitAttachments(expected.attachments)};
 validateVipMail(mail,account,catalog);
 return {expectedRevision:account.revision,eventId:mail.eventId,payload:payload(mail),mail};
}
function applyVip(account,prepared,context){
 authorize(account,context);mailbox(account);keys(prepared,['expectedRevision','eventId','payload','mail']);
 validateVipMail(prepared.mail,account,context.catalog||require('./player-vip-catalog').load());
 if(prepared.expectedRevision!==account.revision||prepared.eventId!==prepared.mail.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(payload(prepared.mail))||
  !millis(context.now)||context.now<prepared.mail.createdAt)throw Error('Stale or changed VIP mail preparation');
 if(Object.hasOwn(account.receipts||{},prepared.eventId)||occupiedMailId(account,prepared.mail.mailId)||
  Object.values(mailbox(account)).some(mail=>mail.eventId===prepared.eventId))throw Error('VIP reward mail already issued');
 account.rewardMailState??={version:1,uid:account.uid,playerId:account.playerId,mails:{}};
 account.rewardMailState.mails[prepared.mail.mailId]=copy(prepared.mail);
 // PlayerAccounts.update must append the matching receipt in this same write.
 return {mailId:prepared.mail.mailId,eventId:prepared.eventId};
}
function lookup(account,mailId,context){authorize(account,context);if(!uint(mailId))throw Error('Invalid mail ID');return copy(mailbox(account)[mailId]||null);}
function ids(account,context){authorize(account,context);return Object.keys(mailbox(account)).map(Number);}
function displaySnapshot(account,context){authorize(account,context);return Object.values(copy(mailbox(account)));}
function record(account,mailId,mode,context){
 const mail=lookup(account,mailId,context);if(!mail)return null;
 if(!['notify','detail','claimed'].includes(mode))throw Error('Invalid reward mail display mode');
 const title=GBK.encode(mail.kind==='vip-bundle'?'VIP奖励汇总':mail.kind==='online'?'在线奖励':mail.kind==='vip-level'?'VIP等级奖励':'VIP特权奖励');
 const body=GBK.encode(mail.kind==='vip-bundle'?'未领取的VIP奖励已合并，请领取邮件附件。':mail.kind==='online'?`第${mail.tier}档在线奖励，请领取邮件附件。`:`V${mail.tier}${mail.kind==='vip-level'?'等级':'特权'}奖励，请领取邮件附件。`);
 return mailgen.buildMail({mailId,playerId:account.playerId,time:Math.floor(mail.createdAt/1000),title,body,
  flag0:mode==='notify'?1:0,flag1:mode==='claimed'?2:0,claimed:mode==='claimed',
  attachments:mode==='claimed'?[]:mail.attachments.map((a,index)=>({...a,
   guidBytes:mailgen.writeVarint((BigInt(mailId)<<32n)|BigInt(0x40000000+index))}))});
}
function frame(account,mailId,mode,context){const bytes=record(account,mailId,mode,context);return bytes?mkFrame(mode==='notify'?20308:20310,bytes,{flags:0xd2,stream:mode==='notify'?account.playerId:0}):null;}
function listRecords(account,context,stateForId=()=>({read:false,claimed:false})){
 if(typeof stateForId!=='function')throw Error('Reward mail state callback required');
 return ids(account,context).map(id=>{const state=stateForId(id);if(!object(state)||typeof state.read!=='boolean'||typeof state.claimed!=='boolean')throw Error('Invalid server mail display state');
  return record(account,id,state.claimed?'claimed':state.read?'detail':'notify',context);});
}
module.exports={displaySnapshot,validate,validateConsolidation,onlineRequest,request,prepareOnline,applyOnline,prepareVip,applyVip,prepareConsolidation,applyConsolidation,aggregateAttachments,retiredMailIds,splitAttachments,vipRule,payload,allocateMailId,lookup,ids,record,frame,listRecords};
