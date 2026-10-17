'use strict';

const path = require('path');
const crypto = require('crypto');
const {EnhancementEngine} = require('./enhancement-engine');
const {ReforgeEngine} = require('./reforge-engine');
const {EnhancementState, normalizeGuid} = require('./enhancement-state');
const {ReforgeState} = require('./reforge-state');
const {EquipmentEconomyCommit} = require('./equipment-economy-commit');
const {containerOf} = require('./item-containers');
const {parseReforgeRequest, parseApplyRequest} = require('./reforge-protocol');

const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const valid = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;

class EquipmentPersistenceAdapter {
  constructor({bag, resources, wallet, files, isEquipment, isFrozen = () => false,
    rules = null, wire = null, legacyFor = () => null, journal = null, random = Math.random}) {
    if (!bag?.slotMap || !bag?.itemMap || !resources || !files || typeof isEquipment !== 'function')
      throw new TypeError('live equipment containers required');
    Object.assign(this,{bag,resources,wallet,files,isEquipment,isFrozen,rules,wire,legacyFor});
    this.enhancement = new EnhancementState(files.enhancement);
    this.reforge = new ReforgeState(files.reforge);
    this.journal = journal || new EquipmentEconomyCommit(files.pending);
    this.enhancementEngine = new EnhancementEngine({
      findInstance: guid => this.findInstance(guid),
      balances: () => this.balances(),
      ruleFor: args => this.rules?.enhancementRuleFor?.(args) ?? null,
      attributesFor: (itemId,level) => this.rules?.attributesFor?.(itemId,level),
      commit: value => this.commitEnhancement(value),random,
    });
    this.reforgeEngine = new ReforgeEngine({
      findInstance: guid => this.findInstance(guid),
      readPending: guid => this.reforge.get(guid),
      balances: () => this.balances(),
      ruleFor: instance => this.rules?.reforgeRuleFor?.(instance,this.luckyItemId ?? 0) ?? null,
      generate: args => this.rules?.generateCandidate?.(args),
      commit: value => this.commitReforge(value),
    });
  }
  get frozen() { return this.journal.frozen || this.isFrozen(); }
  findInstance(guid) {
    const key=normalizeGuid(guid),matches=[];
    for(const [slot,item] of this.bag.slotMap)
      if(item?.guid?.toLowerCase()===key)matches.push({slot,item});
    if(matches.length!==1 || !this.isEquipment(matches[0].item.itemId) ||
       matches[0].item.count!==1)return null;
    const {slot,item}=matches[0];
    const saved=this.enhancement.peek(key,item.itemId);
    const legacy=this.legacyFor(key,item.itemId);
    const initial=this.rules?.initialStateFor?.({guid:key,itemId:item.itemId,legacy}) ?? null;
    const level=saved?.level ?? legacy?.level ?? initial?.level ?? null;
    const blessing=saved?.blessing ?? legacy?.blessing ?? initial?.blessing ?? null;
    const applied=this.reforge.getApplied(key);
    if(applied && applied.itemId!==item.itemId)throw new Error('reforge GUID identity changed');
    const baselineHex=applied?.candidateHex ?? this.rules?.baselineFor?.({guid:key,itemId:item.itemId,
      slot,record:legacy?.record}) ?? null;
    return {guid:key,itemId:item.itemId,slot,level,blessing,baselineHex,
      record:legacy?.record ?? null};
  }
  balances() {
    if(!this.wallet?.ok)return {resources:{},wallet:null};
    const resources={};
    for(const [id,count] of Object.entries(this.resources))
      if(containerOf(+id)==='resource')resources[id]=count;
    for(const [id,count] of this.bag.itemMap)
      if(containerOf(+id)==='material')resources[id]=count;
    return {resources,wallet:{gold:this.wallet.attrs?.[50],diamond:this.wallet.attrs?.[72]}};
  }
  checkDebits(costs,wallet) {
    if(!wallet || !valid(wallet.gold) || !valid(wallet.diamond) ||
       !valid(this.wallet?.attrs?.[50]) || !valid(this.wallet?.attrs?.[72]) ||
       this.wallet.attrs[50]<wallet.gold || this.wallet.attrs[72]<wallet.diamond)return false;
    for(const [key,amount] of Object.entries(costs)) {
      const id=+key,container=containerOf(id);
      if(!valid(amount) || !['resource','material'].includes(container))return false;
      const have=container==='resource' ? this.resources[id]??0 : this.bag.itemMap.get(id)??0;
      if(!valid(have) || have<amount)return false;
    }
    return true;
  }
  debitSteps(costs,wallet) {
    const resourceCosts=[],materialCosts=[];
    for(const [key,amount] of Object.entries(costs)) {
      if(!amount)continue;
      const id=+key;
      (containerOf(id)==='resource' ? resourceCosts : materialCosts).push([id,amount]);
    }
    const steps=[];
    if(resourceCosts.length)steps.push({name:'resource',path:this.files.resource,save:()=>{
      for(const [id,amount] of resourceCosts)this.resources[id]-=amount;
      this.files.saveResources();
    }});
    if(materialCosts.length)steps.push({name:'material',path:this.files.material,save:()=>{
      for(const [id,amount] of materialCosts)this.bag.itemMap.set(id,this.bag.itemMap.get(id)-amount);
      this.files.saveMaterials();
    }});
    if(wallet.gold || wallet.diamond)steps.push({name:'wallet',path:this.files.wallet,save:()=>{
      this.wallet.attrs[50]-=wallet.gold;
      this.wallet.attrs[72]-=wallet.diamond;
      this.wallet.gold=this.wallet.attrs[50];
      this.wallet.save(true);
    }});
    return steps;
  }
  commitEnhancement({plan,next,result}) {
    if(this.frozen || !this.wire?.enhancementOutcome || !this.rules?.blessingFor ||
       this.reforge.get(plan.guid))return false;
    const current=this.findInstance(plan.guid);
    if(!current || current.itemId!==plan.itemId || current.level!==plan.currentLevel)return false;
    const fresh=this.enhancementEngine.quote({guid:plan.guid,purchaseCurrency:plan.purchaseCurrency,
      luckyItemId:plan.luckyItemId});
    if(!fresh.ok || !same(fresh.plan,plan) || !this.checkDebits(plan.debitResources,plan.debitWallet))return false;
    const blessing=this.rules.blessingFor({previous:current.blessing,plan,next,result});
    if(!valid(blessing))return false;
    // The wire builder is a required rule interface. If it cannot represent
    // the result and changed equipment state, no debit is started.
    const frames=this.wire.enhancementOutcome({plan,next,result,blessing,instance:current});
    if(!Array.isArray(frames) || !frames.length || frames.some(f=>!Buffer.isBuffer(f)))return false;
    let milestone=null;
    if(result.success && [4,9,15].includes(next.level) && this.rules?.milestoneCandidate){
      milestone=this.rules.milestoneCandidate({instance:current,targetLevel:next.level});
      if(!Buffer.isBuffer(milestone)||milestone.length!==42||
         typeof current.baselineHex!=='string'||!/^([0-9a-f]{2}){42}$/.test(current.baselineHex))return false;
    }
    const steps=this.debitSteps(plan.debitResources,plan.debitWallet);
    steps.push({name:'enhancement',path:this.files.enhancement,save:()=>
      this.enhancement.set(plan.guid,plan.itemId,next.level,blessing)});
    if(milestone)steps.push({name:'reforge',path:this.files.reforge,save:()=>
      this.reforge.setApplied(plan.guid,{itemId:plan.itemId,
        baselineHash:crypto.createHash('sha256').update(current.baselineHex,'hex').digest('hex'),
        candidateHex:milestone.toString('hex')})});
    const saved=this.journal.run('enhancement',plan.guid,steps);
    if(saved){this.lastFrames=frames;this.lastDebits={resources:plan.debitResources,wallet:plan.debitWallet};}
    return saved;
  }
  commitReforge({kind,instance,pending,previous,costs,wallet}) {
    if(this.frozen || !this.wire?.reforgeOutcome)return false;
    const current=this.reforgeEngine.instance(instance.guid);
    if(!current || current.itemId!==instance.itemId || current.baselineHash!==instance.baselineHash ||
       current.level!==instance.level)return false;
    if(kind==='begin') {
      if(!same(this.reforge.get(instance.guid),previous))return false;
      const rule=this.rules?.reforgeRuleFor?.(current,this.luckyItemId ?? 0);
      if(!rule || rule.executionReady!==true || !same(rule.resources,costs) ||
         !same(rule.walletCost,wallet) || !this.checkDebits(costs,wallet))return false;
    } else if(!['apply','cancel'].includes(kind) || !same(this.reforge.get(instance.guid),pending))return false;
    const frames=this.wire.reforgeOutcome({kind,instance:current,pending});
    if(!Array.isArray(frames) || (kind==='begin'&&!frames.length) ||
       frames.some(f=>!Buffer.isBuffer(f)))return false;
    const steps=kind==='begin' ? this.debitSteps(costs,wallet) : [];
    steps.push({name:'reforge',path:this.files.reforge,save:()=>{
      if(kind==='begin')this.reforge.replace(instance.guid,pending);
      else this.reforge.resolve(instance.guid,kind);
    }});
    const saved=this.journal.run(`reforge-${kind}`,instance.guid,steps);
    if(saved){this.lastFrames=frames;this.lastDebits={resources:costs||{},wallet:wallet||{gold:0,diamond:0}};}
    return saved;
  }
  handle(msgid,payload) {
    if(this.frozen)return {ok:false,reason:'economy-frozen'};
    this.lastFrames=null;
    this.lastDebits=null;
    try {
      if(msgid===13510){
        if(payload.length!==9 || ![1,2].includes(payload[8]))return {ok:false,reason:'invalid-query'};
        const instance=this.findInstance(payload.subarray(0,8));
        if(!instance)return {ok:false,reason:'equipment-instance-not-found'};
        if(!Number.isInteger(instance.level)||instance.level<0||instance.level>17)
          return {ok:false,reason:'instance-level-unconfirmed'};
        if(!Number.isInteger(instance.blessing)||instance.blessing<0||instance.blessing>65535)
          return {ok:false,reason:'blessing-count-unconfirmed'};
        const rule=instance.level===17 ? null : this.rules?.enhancementRuleFor?.({itemId:instance.itemId,
          currentLevel:instance.level,targetLevel:instance.level+1});
        if(instance.level<17 && rule?.deterministicReady!==true && rule?.executionReady!==true)
          return {ok:false,reason:'rule-unconfirmed'};
        if(!this.wire?.enhancementQuery)return {ok:false,reason:'wire-unconfirmed'};
        const frames=this.wire.enhancementQuery({instance,rule,balances:this.balances(),queryType:payload[8]});
        return Array.isArray(frames)&&frames.length&&frames.every(Buffer.isBuffer)
          ? {ok:true,frames} : {ok:false,reason:'wire-unconfirmed'};
      }
      if(msgid===13512){
        if(payload.length!==19 || payload[8]!==2 || ![0,1,2].includes(payload[9]))
          return {ok:false,reason:'invalid-request'};
        const purchaseCurrency=[null,'gold','diamond'][payload[9]];
        const result=this.enhancementEngine.execute({guid:payload.subarray(0,8),purchaseCurrency,
          luckyItemId:payload.readUInt16LE(17)});
        return result.ok ? {...result,frames:this.lastFrames,debits:this.lastDebits} : result;
      }
      if(msgid===13518){
        const request=parseReforgeRequest(payload);
        this.luckyItemId=request.luckyItemId;
        try {
          const result=this.reforgeEngine.begin(request);
          return result.ok ? {...result,frames:this.lastFrames,debits:this.lastDebits} : result;
        } finally {this.luckyItemId=null;}
      }
      if(msgid===13553 || msgid===13575){
        const request=parseApplyRequest(payload);
        const result=this.reforgeEngine.resolve({...request,choice:msgid===13553?'apply':'cancel'});
        return result.ok ? {...result,frames:this.lastFrames,debits:this.lastDebits} : result;
      }
      return {ok:false,reason:'unsupported-message'};
    } catch(error){return {ok:false,reason:'adapter-error',error:error.message};}
  }
}

module.exports={EquipmentPersistenceAdapter};
