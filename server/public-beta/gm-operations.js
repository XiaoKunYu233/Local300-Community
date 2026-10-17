'use strict';
// Only the owning lobby worker calls API. The manager forwards authenticated
// local-tool requests over IPC; this module never opens another account file.
const crypto=require('node:crypto'),path=require('node:path'),GBK=require('../gbk'),items=require('./gm-items');
const copy=value=>JSON.parse(JSON.stringify(value));
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const transaction=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,95}$/.test(value);
const millis=value=>Number.isSafeInteger(value)&&value>=0&&Math.floor(value/1000)<=0xffffffff;
function keys(value,list){if(!object(value)||Object.keys(value).sort().join('|')!==list.slice().sort().join('|'))throw Error('Invalid public beta GM fields');}
function request(value,{normalized=false}={}){
 if(!transaction(value?.transactionId))throw Error('GM请求需要唯一事务编号');
 if(value.operation==='gold'){
  keys(value,['operation','transactionId','amount']);if(!uint(value.amount))throw Error('金币数量无效');
  return {operation:'gold',transactionId:value.transactionId,amount:value.amount};
 }
 if(value.operation!=='mail')throw Error('未知GM操作');
 keys(value,['operation','transactionId','title','message','attachments']);
 if(typeof value.title!=='string'||!value.title.trim()||value.title.length>60||typeof value.message!=='string'||value.message.length>500||
  GBK.decode(GBK.encode(value.title))!==value.title||GBK.decode(GBK.encode(value.message))!==value.message)throw Error('邮件标题或正文无效');
 return {operation:'mail',transactionId:value.transactionId,title:value.title.trim(),message:value.message,attachments:normalized?items.validateAttachments(value.attachments):items.attachments(value.attachments)};
}
function receiptPayload(record){return {kind:record.kind,uid:record.uid,playerId:record.playerId,eventId:record.eventId,createdAt:record.createdAt,request:copy(record.request),
 ...(record.kind==='gm-mail'?{mailId:record.mailId}:{before:record.before,after:record.after})};}
function validate(state,account){
 keys(state,['version','uid','playerId','events']);if(state.version!==1||state.uid!==account.uid||state.playerId!==account.playerId||!object(state.events))throw Error('Invalid public beta GM state');
 const ids=new Set();
 for(const [id,record]of Object.entries(state.events)){
  const expected=record?.kind==='gm-mail'?['kind','uid','playerId','eventId','createdAt','request','mailId','sha256']:['kind','uid','playerId','eventId','createdAt','request','before','after','sha256'];
  keys(record,expected);
  if(record.uid!==account.uid||record.playerId!==account.playerId||!millis(record.createdAt)||!transaction(id)||record.request?.transactionId!==id||record.eventId!==`public-beta-gm:${id}`||
   !['gm-mail','gm-gold'].includes(record.kind)||record.request.operation!==(record.kind==='gm-mail'?'mail':'gold')||
   JSON.stringify(request(record.request,{normalized:true}))!==JSON.stringify(record.request)||record.sha256!==digest(receiptPayload(record))||account.receipts?.[record.eventId]!==record.sha256)throw Error('GM event has no exact committed receipt');
  if(record.kind==='gm-mail'){
   if(!uint(record.mailId)||ids.has(record.mailId))throw Error('Conflicting GM mail identity');ids.add(record.mailId);
  }else if(!Number.isInteger(record.before)||record.before<0||!uint(record.after)||record.after-record.before!==record.request.amount)throw Error('Invalid GM gold event');
 }
 return state;
}
function events(account){if(account.publicBetaGmState)validate(account.publicBetaGmState,account);return account.publicBetaGmState?.events||{};}
function authorize(account,context){
 if(!account||!uint(account.uid)||!uint(account.playerId)||context?.uid!==account.uid||context.playerId!==account.playerId)throw Error('GM account identity unavailable');
}
function prepare(account,value,context){
 authorize(account,context);const input=request(value),old=events(account)[input.transactionId];
 if(old){if(JSON.stringify(old.request)!==JSON.stringify(input))throw Error('GM事务编号已用于不同请求');return {repeated:true,record:copy(old)};}
 if(!Number.isSafeInteger(account.revision)||account.revision<0||!millis(context.now))throw Error('Invalid GM account revision or time');
 const record={kind:input.operation==='mail'?'gm-mail':'gm-gold',uid:account.uid,playerId:account.playerId,eventId:`public-beta-gm:${input.transactionId}`,createdAt:context.now,request:input};
 if(input.operation==='mail'){
  const occupied=context.occupiedIds||[];
  if(!Array.isArray(occupied)||occupied.some(id=>!uint(id)))throw Error('Invalid occupied mail IDs');
  const used=new Set([...occupied,...Object.values(events(account)).filter(r=>r.kind==='gm-mail').map(r=>r.mailId),...Object.keys(account.rewardMailState?.mails||{}).map(Number),...require('../player-reward-mail').retiredMailIds(account)]);
  let mailId=context.mailId;
  if(mailId===undefined)for(let attempt=0;attempt<128;attempt++){const candidate=crypto.randomInt(1,0x100000000);if(!used.has(candidate)){mailId=candidate;break;}}
  if(!uint(mailId)||used.has(mailId))throw Error('Conflicting GM mail ID');record.mailId=mailId;
 }else{
  if(!Number.isInteger(context.gold)||context.gold<0||context.gold>0xffffffff||context.gold+input.amount>0xffffffff)throw Error('金币余额缺失或超过上限');
  record.before=context.gold;record.after=context.gold+input.amount;
 }
 record.sha256=digest(receiptPayload(record));
 return {expectedRevision:account.revision,eventId:record.eventId,payload:receiptPayload(record),record};
}
function apply(account,prepared){
 authorize(account,prepared.record);
 if(prepared.repeated||account.revision!==prepared.expectedRevision||prepared.eventId!==prepared.record?.eventId||JSON.stringify(prepared.payload)!==JSON.stringify(receiptPayload(prepared.record))||prepared.record.sha256!==digest(prepared.payload))throw Error('Stale or changed GM preparation');
 if(events(account)[prepared.record.request.transactionId]||Object.hasOwn(account.receipts,prepared.eventId))throw Error('GM event already committed');
 account.publicBetaGmState??={version:1,uid:account.uid,playerId:account.playerId,events:{}};
 account.publicBetaGmState.events[prepared.record.request.transactionId]=copy(prepared.record);
 return result(prepared.record,false);
}
function result(record,repeated){return record.kind==='gm-mail'?{ok:true,repeated,mailId:record.mailId}:{ok:true,repeated,added:record.request.amount,balance:record.after};}
function API(context,value){
 if(context?.enabled!==true||typeof context.isFrozen!=='function'||context.isFrozen()||!context.store||!context.commit||context.commit.frozen)throw Error('公开测试GM操作未启用或账号存档不可用');
 const account=context.store.get(context.uid);authorize(account,context);
 const input=request(value);
 if(input.operation==='gold'&&(typeof context.inBattle!=='function'||context.inBattle()))throw Error('请先返回大厅再发放金币');
 const prepared=prepare(account,value,{uid:context.uid,playerId:context.playerId,now:context.now?context.now():Date.now(),gold:context.wallet?.attrs?.[50],occupiedIds:context.occupiedMailIds?context.occupiedMailIds():[]});
 if(prepared.repeated)return result(prepared.record,true);
 const prior=input.operation==='gold'?copy({attrs:context.wallet.attrs,state:context.wallet.state,gold:context.wallet.gold}):null;
 const steps=[];
 if(prior){
  if(typeof context.wallet.save!=='function'||!path.isAbsolute(context.walletPath||''))throw Error('GM wallet save authority unavailable');
  const relative=path.relative(path.dirname(context.store.file),context.walletPath);
  if(relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw Error('GM wallet path leaves account directory');
  steps.push({name:'wallet',path:context.walletPath,save:()=>{
   context.wallet.attrs={...prior.attrs,50:prepared.record.after};context.wallet.gold=prepared.record.after;
   context.wallet.state={...prior.state,attrs:context.wallet.attrs,gold:context.wallet.gold};context.wallet.save(true);
  }});
 }
 steps.push({name:'player-accounts',path:context.store.file,save:()=>context.store.update(context.uid,{expectedRevision:prepared.expectedRevision,eventId:prepared.eventId,payload:prepared.payload},a=>apply(a,prepared))});
 try{if(!context.commit.run('public-beta-gm-'+input.operation,prepared.eventId,steps))throw Error('GM economic commit unavailable');}
 catch(error){if(prior){context.wallet.attrs=prior.attrs;context.wallet.state=prior.state;context.wallet.gold=prior.gold;}throw error;}
 const answer=result(prepared.record,false);
 try{if(input.operation==='mail')context.notifyMail?.(answer.mailId);else context.pushCurrency?.(50,answer.balance);}
 catch{answer.notificationPending=true;}
 return answer;
}
function displaySnapshot(account,context){
 authorize(account,context);if(context.authenticated!==true||context.frozen!==false)throw Error('GM mailbox account unavailable');
 return Object.values(events(account)).filter(record=>record.kind==='gm-mail').map(record=>({kind:'gm',mailId:record.mailId,uid:account.uid,playerId:account.playerId,createdAt:record.createdAt,title:record.request.title,message:record.request.message,attachments:copy(record.request.attachments)}));
}
module.exports={API,prepare,apply,validate,displaySnapshot,request,receiptPayload,result};
