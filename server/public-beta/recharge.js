'use strict';
const path=require('node:path'),recharge=require('../player-recharge'),reset=require('./first-gift-reset');
const gifts=require('../player-first-gift'),vip=require('../player-vip-catalog'),mail=require('../player-reward-mail');
const copy=value=>structuredClone(value),hash=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
function checked(ctx,payload){
 if(ctx?.enabled!==true||!ctx.store||typeof ctx.store.get!=='function'||typeof ctx.store.update!=='function'||!ctx.commit||typeof ctx.commit.run!=='function'||
  typeof ctx.isFrozen!=='function'||typeof ctx.inBattle!=='function'||ctx.isFrozen()||ctx.inBattle())throw Error('公开测试操作暂不可用，请返回大厅并完成待核对存档。');
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!['recharge','reset-first-gift'].includes(payload.operation)||!reset.validId(payload.transactionId)||
  Object.keys(payload).some(key=>!['operation','transactionId','diamonds'].includes(key))||
  payload.operation==='reset-first-gift'&&payload.diamonds!==undefined)throw Error('公开测试充值请求格式不正确。');
 const account=ctx.store.get(ctx.uid);
 if(!account||account.uid!==ctx.uid||account.playerId!==ctx.playerId)throw Error('公开测试账号不匹配。');
 if(payload.operation==='recharge'&&(!Number.isSafeInteger(payload.diamonds)||payload.diamonds<1||payload.diamonds>Math.floor(0xffffffff/100)))throw Error('充值数量必须为范围内的正整数。');
 if(!ctx.wallet||!path.isAbsolute(ctx.walletPath||'')||typeof ctx.wallet.save!=='function'||!path.isAbsolute(ctx.store.file||''))throw Error('公开测试钱包或账户路径不可用。');
 return account;
}
function status(ctx,account){return {uid:account.uid,playerId:account.playerId,diamonds:ctx.wallet.attrs[72]/100,
 cumulativeRecharge:ctx.wallet.attrs[91]/100,vipPoints:ctx.wallet.attrs[52],vipLevel:account.vip.level,firstGiftStatus:gifts.entitlement(account).status};}
function publish(ctx,account,mailIds){
 const errors=[];
 const send=(name,callback,...args)=>{if(typeof callback==='function')try{callback(...args);}catch{errors.push(name);}};
 for(const attr of [72,91,52])if(require('../player-wallet-wire').knownU32(ctx.wallet.attrs[attr]))send('currency',ctx.pushCurrency,attr,ctx.wallet.attrs[attr]);
 const bag=require('../bag');
 send('vip-level',ctx.pushFrame,require('../player-vip-wire').levelFrame(account));
 send('vip',ctx.pushFrame,require('../player-vip-wire').recharge(bag.mkFrame(1439,Buffer.alloc(4)),ctx.wallet.attrs));
 send('first-gift',ctx.pushFrame,gifts.reply(account));
 for(const id of mailIds)send('mail',ctx.notifyMail,id);
 return errors;
}
function execute(ctx,payload){
 const account=checked(ctx,payload),isRecharge=payload.operation==='recharge';
 const transactions=(isRecharge?account.rechargeState?.transactions:account.firstGiftResetState?.transactions)||{};
 const prior=Object.hasOwn(transactions,payload.transactionId)?transactions[payload.transactionId]:null;
 if(prior){
  if(isRecharge&&prior.amountMinor!==payload.diamonds*100)throw Error('同一充值流水号不能用于不同数量。');
  if(isRecharge)recharge.validateTransaction(prior,account);else reset.validate(account.firstGiftResetState,account);
  return {ok:true,operation:payload.operation,transactionId:payload.transactionId,repeated:true,...status(ctx,account),mailIds:[],newlyReachedLevels:[]};
 }
 // Native SetIsCanGetVipFirstGift indexes Charge_Font by the ten extracted
 // first-pay tiers. Below the first tier (10), a positive reply indexes zero.
 // No evidence establishes how the old server accumulated smaller payments.
 if(isRecharge&&gifts.entitlement(account).status==='unavailable'&&payload.diamonds<require('../player-first-gift-catalog').TIERS[0])throw Error('当前首充尚未开启，请至少充值10个单位以达到客户端最低首充档。');
 const now=typeof ctx.now==='function'?ctx.now():Date.now(),catalog=vip.load();
 const prepared=isRecharge?recharge.prepare(account,ctx.wallet,{transactionId:payload.transactionId,diamonds:payload.diamonds,now,catalog}):reset.prepare(account,{transactionId:payload.transactionId,now});
 const before={attrs:copy(ctx.wallet.attrs),state:copy(ctx.wallet.state),gold:ctx.wallet.gold,
  attrsRef:ctx.wallet.attrs,stateRef:ctx.wallet.state,stateAttrsAlias:ctx.wallet.state?.attrs===ctx.wallet.attrs};
 const projected=copy(account),walletBefore={attrs:copy(before.attrs)},mailPlans=[];
 let result;
 const project=(a,w)=>{
  const value=isRecharge?recharge.apply(a,w,prepared,{catalog}):reset.apply(a,prepared);
  // Several independently receipted VIP mails are part of this one account
  // write. Its outer recharge receipt is also added by PlayerAccounts.update.
  a.receipts[prepared.eventId]=hash(prepared.payload);
  if(isRecharge){
   const occupied=typeof ctx.occupiedMailIds==='function'?ctx.occupiedMailIds():[];
   for(const plan of vip.prepareMailPlans(a,catalog)){
    const context={authenticated:true,frozen:false,uid:a.uid,playerId:a.playerId,now,catalog,occupiedIds:occupied};
    const preparedMail=mail.prepareVip(a,plan,context);
    mail.applyVip(a,preparedMail,context);a.receipts[preparedMail.eventId]=hash(preparedMail.payload);
    mailPlans.push(preparedMail);
   }
  }
  return value;
 };
 result=project(projected,walletBefore);
 // This preflight checks the complete projected account and mailbox before
 // any persisted currency can change. Random mail IDs are fixed in this plan.
 require('../player-account-state').validate({version:1,revision:0,accounts:{[projected.uid]:projected}});
 const afterAttrs=copy(walletBefore.attrs);
 const steps=[];
 if(isRecharge)steps.push({name:'wallet',path:ctx.walletPath,save:()=>{
  if(JSON.stringify(ctx.wallet.attrs)!==JSON.stringify(before.attrs))throw Error('充值钱包余额在提交前已变更。');
  Object.assign(ctx.wallet.attrs,afterAttrs);ctx.wallet.save(true);
 }});
 steps.push({name:'player-accounts',path:ctx.store.file,save:()=>ctx.store.update(ctx.uid,{
  expectedRevision:prepared.expectedRevision,eventId:prepared.eventId,payload:prepared.payload},a=>{
  const value=isRecharge?recharge.apply(a,{attrs:copy(before.attrs)},prepared,{catalog}):reset.apply(a,prepared);
  a.receipts[prepared.eventId]=hash(prepared.payload);
  for(const m of mailPlans){
   mail.applyVip(a,m,{authenticated:true,frozen:false,uid:a.uid,playerId:a.playerId,now,catalog});
   a.receipts[m.eventId]=hash(m.payload);
  }
  return value;
 })});
 try{
  if(!ctx.commit.run(isRecharge?'public-beta-recharge':'public-beta-first-gift-reset',payload.transactionId,steps))throw Error('充值存档正在核对，操作未完成。');
 }catch(error){
  for(const key of Object.keys(before.attrsRef))delete before.attrsRef[key];Object.assign(before.attrsRef,before.attrs);
  ctx.wallet.attrs=before.attrsRef;ctx.wallet.gold=before.gold;
  if(before.stateRef){
   for(const key of Object.keys(before.stateRef))delete before.stateRef[key];Object.assign(before.stateRef,before.state);
   if(before.stateAttrsAlias)before.stateRef.attrs=before.attrsRef;
  }
  ctx.wallet.state=before.stateRef;
  throw error;
 }
 const current=ctx.store.get(ctx.uid),mailIds=mailPlans.map(p=>p.mail.mailId);
 const notificationErrors=publish(ctx,current,mailIds);
 return {ok:true,operation:payload.operation,transactionId:payload.transactionId,repeated:false,...status(ctx,current),mailIds,
  newlyReachedLevels:result.newlyReachedLevels||[],...(notificationErrors.length?{notificationErrors}:{} )};
}
module.exports={execute};
