'use strict';
// Test control for the existing single 24-hour rune activity. It never opens
// the activity itself, adds a pool, changes odds, or returns consumed assets.
// Only the owning lobby worker supplies the stores and refresh callback.
const crypto=require('node:crypto'),path=require('node:path');
const copy=value=>structuredClone(value),hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const millis=value=>Number.isSafeInteger(value)&&value>=0&&Math.floor(value/1000)<=0xffffffff;
const transaction=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(value);
const OPERATIONS=Object.freeze(['reset-limited-godsend','close-limited-godsend']);
function keys(value,expected){if(!object(value)||Object.keys(value).sort().join('|')!==expected.slice().sort().join('|'))throw Error('Invalid limited godsend control fields');}
function request(value){
 keys(value,['operation','transactionId']);
 if(!OPERATIONS.includes(value.operation)||!transaction(value.transactionId))throw Error('限定神赐控制请求无效');
 return {operation:value.operation,transactionId:value.transactionId};
}
function godsend(value){
 if(!object(value)||typeof value.enabledLimited!=='boolean'||!Number.isSafeInteger(value.limitedRemaining)||value.limitedRemaining<0||value.limitedRemaining>0xffff||!millis(value.limitedExpiresAt)||!object(value.wish)||
  ![null,'regular','limited'].includes(value.wish.type)||!(value.wish.id===null||uint(value.wish.id)&&value.wish.id<=0xffff))throw Error('限定神赐状态缺失或无效');
 return value;
}
function changed(before,operation){
 const after=copy(godsend(before));
 if(operation==='reset-limited-godsend')after.limitedRemaining=1;
 else if(operation==='close-limited-godsend'){
  after.enabledLimited=false;after.limitedExpiresAt=0;
  if(after.wish.type==='limited')after.wish={type:null,id:null};
 }else throw Error('限定神赐控制操作无效');
 return after;
}
function info(state,now=Date.now()){
 const current=godsend(state?.godsend);
 if(!millis(now))throw Error('Invalid limited godsend clock');
 return {remaining:current.limitedRemaining,active:current.enabledLimited&&current.limitedExpiresAt>now,expiresAt:current.limitedExpiresAt};
}
function protectedHash(state){const value=copy(state);delete value.godsend;delete value.updatedAt;return hash(value);}
function receiptPayload(record){return {kind:record.kind,uid:record.uid,playerId:record.playerId,eventId:record.eventId,createdAt:record.createdAt,request:copy(record.request),before:copy(record.before),after:copy(record.after),protectedSha256:record.protectedSha256};}
function checkRecord(record,id,account){
 keys(record,['kind','uid','playerId','eventId','createdAt','request','before','after','protectedSha256','sha256']);
 if(record.kind!=='public-beta-limited-godsend'||record.uid!==account.uid||record.playerId!==account.playerId||!transaction(id)||!millis(record.createdAt)||record.request?.transactionId!==id||
  JSON.stringify(request(record.request))!==JSON.stringify(record.request)||record.eventId!==`public-beta-limited-godsend:${id}`||!/^[a-f0-9]{64}$/.test(record.protectedSha256)||
  JSON.stringify(changed(record.before,record.request.operation))!==JSON.stringify(godsend(record.after))||record.sha256!==hash(receiptPayload(record)))throw Error('Invalid limited godsend control receipt');
 return record;
}
function validate(state,account){
 keys(state,['version','uid','playerId','events']);
 if(state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||!object(state.events))throw Error('Invalid limited godsend control state');
 for(const [id,record]of Object.entries(state.events)){
  checkRecord(record,id,account);
  if(account.receipts?.[record.eventId]!==record.sha256)throw Error('Limited godsend control has no exact committed receipt');
 }
 return state;
}
function events(account){if(account.limitedGodsendControlState)validate(account.limitedGodsendControlState,account);return account.limitedGodsendControlState?.events||{};}
function identity(account,context){if(!account||!uint(account.uid)||!uint(account.playerId)||context?.uid!==account.uid||context.playerId!==account.playerId)throw Error('Limited godsend account identity unavailable');}
function prepare(account,state,value,context){
 identity(account,context);const input=request(value),previous=events(account)[input.transactionId];
 if(previous){if(JSON.stringify(previous.request)!==JSON.stringify(input))throw Error('限定神赐事务编号已用于不同请求');return {repeated:true,record:copy(previous)};}
 if(!Number.isSafeInteger(account.revision)||account.revision<0||!millis(context.now)||state?.version!==1||!object(state.inventory)||!Array.isArray(state.pages))throw Error('Invalid limited godsend account state or clock');
 const before=copy(godsend(state.godsend)),after=changed(before,input.operation);
 const record={kind:'public-beta-limited-godsend',uid:account.uid,playerId:account.playerId,eventId:`public-beta-limited-godsend:${input.transactionId}`,createdAt:context.now,request:input,before,after,protectedSha256:protectedHash(state)};
 record.sha256=hash(receiptPayload(record));const next=copy(state);next.godsend=copy(after);
 return {expectedRevision:account.revision,beforeRuneSha256:hash(state),state:next,eventId:record.eventId,payload:receiptPayload(record),record};
}
function apply(account,prepared){
 const record=prepared?.record;identity(account,record);checkRecord(record,record.request?.transactionId,account);
 if(prepared.repeated||account.revision!==prepared.expectedRevision||prepared.eventId!==record.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(receiptPayload(record))||
  JSON.stringify(prepared.state?.godsend)!==JSON.stringify(record.after)||protectedHash(prepared.state)!==record.protectedSha256||events(account)[record.request.transactionId]||Object.hasOwn(account.receipts,record.eventId))throw Error('Stale or changed limited godsend preparation');
 account.limitedGodsendControlState??={version:1,uid:account.uid,playerId:account.playerId,events:{}};
 account.limitedGodsendControlState.events[record.request.transactionId]=copy(record);
}
function API(context,value){
 if(context?.enabled!==true||typeof context.isFrozen!=='function'||context.isFrozen()||!context.store||!context.commit||context.commit.frozen||typeof context.inBattle!=='function'||context.inBattle())throw Error('限定神赐测试控制未启用、存档不可用或未在大厅');
 const account=context.store.get(context.uid);identity(account,context);
 const rune=context.rune;
 if(!rune||typeof rune.save!=='function'||!path.isAbsolute(rune.file||'')||!path.isAbsolute(context.store.file||''))throw Error('Limited godsend save authority unavailable');
 const relative=path.relative(path.dirname(context.store.file),rune.file);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!relative)throw Error('Limited godsend rune path leaves account directory');
 const now=context.now?.()??Date.now(),prepared=prepare(account,rune.state,value,{uid:context.uid,playerId:context.playerId,now});
 if(prepared.repeated)return {ok:true,repeated:true,operation:prepared.record.request.operation,...info(rune.state,now)};
 const prior=rune.state;
 try{
  if(!context.commit.run('public-beta-limited-godsend',prepared.eventId,[
   {name:'rune',path:path.resolve(rune.file),save:()=>{
    if(hash(rune.state)!==prepared.beforeRuneSha256)throw Error('Limited godsend rune state changed');
    rune.state=prepared.state;rune.save();
   }},
   {name:'player-accounts',path:context.store.file,save:()=>context.store.update(context.uid,{expectedRevision:prepared.expectedRevision,eventId:prepared.eventId,payload:prepared.payload},current=>apply(current,prepared))},
  ]))throw Error('Limited godsend economic commit unavailable');
 }catch(error){rune.state=prior;throw error;}
 const answer={ok:true,repeated:false,operation:prepared.record.request.operation,...info(rune.state,now)};
 try{context.refreshLimitedGodsend?.();}catch{answer.notificationPending=true;}
 return answer;
}
module.exports={API,prepare,apply,validate,request,receiptPayload,info,OPERATIONS};
