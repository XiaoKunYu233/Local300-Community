'use strict';
const crypto=require('crypto');
const {normalizeGuid}=require('./enhancement-state');

// The adapter supplies eligibility, costs, the attribute pool and the commit
// function. Without an executable rule this engine rejects begin.
class ReforgeEngine {
  constructor({findInstance,readPending,balances,ruleFor,generate,commit}){
    for(const [name,fn] of Object.entries({findInstance,readPending,balances,ruleFor,generate,commit}))
      if(typeof fn!=='function')throw new TypeError(`${name} must be a function`);
    Object.assign(this,{findInstance,readPending,balances,ruleFor,generate,commit});
  }
  instance(guid){
    let key,instance;
    try{key=normalizeGuid(guid);instance=this.findInstance(key);}
    catch{return null;}
    if(!instance||instance.guid!==key||!Number.isSafeInteger(instance.itemId)||instance.itemId<=0||
      !Number.isInteger(instance.level)||instance.level<0||instance.level>17||
      typeof instance.baselineHex!=='string'||!/^([0-9a-f]{2})*$/.test(instance.baselineHex))return null;
    return {...instance,guid:key,baselineHash:crypto.createHash('sha256').update(instance.baselineHex,'hex').digest('hex')};
  }
  begin({guid}={}){
    const instance=this.instance(guid);
    if(!instance)return {ok:false,reason:'equipment-instance-not-found'};
    let previous;
    try{previous=this.readPending(instance.guid);}
    catch{return {ok:false,reason:'invalid-reforge-state'};}
    if(previous && (previous.itemId!==instance.itemId || previous.baselineHash!==instance.baselineHash))
      return {ok:false,reason:'stale-candidate'};
    let rule;
    try{rule=this.ruleFor(instance);}
    catch{return {ok:false,reason:'rule-unconfirmed'};}
    if(!rule||rule.executionReady!==true)return {ok:false,reason:'rule-unconfirmed'};
    const costs=rule.resources,wallet=rule.walletCost;
    if(!costs||typeof costs!=='object'||Array.isArray(costs)||!wallet||
      !Number.isSafeInteger(wallet.gold)||wallet.gold<0||
      !Number.isSafeInteger(wallet.diamond)||wallet.diamond<0)
      return {ok:false,reason:'invalid-server-rule'};
    for(const [id,n] of Object.entries(costs))if(!/^[1-9]\d*$/.test(id)||!Number.isSafeInteger(n)||n<0)
      return {ok:false,reason:'invalid-server-rule'};
    let funds;
    try{funds=this.balances();}catch{return {ok:false,reason:'invalid-economy-state'};}
    if(!funds||!funds.resources||!funds.wallet||
      !Number.isSafeInteger(funds.wallet.gold)||funds.wallet.gold<0||
      !Number.isSafeInteger(funds.wallet.diamond)||funds.wallet.diamond<0)
      return {ok:false,reason:'invalid-economy-state'};
    for(const [id,n] of Object.entries(costs)){
      if(!Number.isSafeInteger(funds.resources[id]??0)||(funds.resources[id]??0)<0)
        return {ok:false,reason:'invalid-economy-state'};
      if((funds.resources[id]??0)<n)
      return {ok:false,reason:'materials-insufficient'};
    }
    if((funds.wallet.gold??0)<wallet.gold||(funds.wallet.diamond??0)<wallet.diamond)
      return {ok:false,reason:'balance-insufficient'};
    let candidate;
    try{candidate=this.generate({instance,rule});}
    catch{return {ok:false,reason:'candidate-generation-failed'};}
    if(!Buffer.isBuffer(candidate)||candidate.length!==42)
      return {ok:false,reason:'invalid-candidate'};
    const pending={itemId:instance.itemId,baselineHash:instance.baselineHash,
      candidateHex:candidate.toString('hex')};
    try{
      // The adapter must recheck GUID, baseline and balances, then persist the
      // debit plus candidate together before returning true.
      if(this.commit({kind:'begin',instance,pending,previous,costs,wallet})!==true)
        return {ok:false,reason:'commit-rejected'};
    }catch{return {ok:false,reason:'commit-failed'};}
    return {ok:true,candidate,pending};
  }
  resolve({guid,choice}={}){
    if(choice!=='apply'&&choice!=='cancel')return {ok:false,reason:'invalid-choice'};
    const instance=this.instance(guid);
    if(!instance)return {ok:false,reason:'equipment-instance-not-found'};
    let pending;
    try{pending=this.readPending(instance.guid);}
    catch{return {ok:false,reason:'invalid-reforge-state'};}
    if(!pending)return {ok:false,reason:'no-pending-candidate'};
    if(pending.itemId!==instance.itemId||pending.baselineHash!==instance.baselineHash)
      return {ok:false,reason:'stale-candidate'};
    try{
      // Applying changes only the matched GUID. Cancel drops only its pending
      // candidate. Neither path charges again. An absent pending means a
      // repeated 13553/13575 cannot touch another instance.
      if(this.commit({kind:choice,instance,pending})!==true)
        return {ok:false,reason:'commit-rejected'};
    }catch{return {ok:false,reason:'commit-failed'};}
    return {ok:true,choice,guid:instance.guid};
  }
}
module.exports={ReforgeEngine};
