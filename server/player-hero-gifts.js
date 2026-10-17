'use strict';
const rows=require('./client-shop-config.json'),{loadConfig}=require('./runtime/catalogs');
const rewards=require('./player-hero-rewards'),heroes=require('./player-heroes'),{containerOf}=require('./item-containers');
const items=new Map(loadConfig('current-items').data.map(row=>[row[1],row]));
// Column 35 is a contents list, not probability evidence. Only explicit fixed
// and choice gifts are accepted; self references and ambiguous pools stay shut.
function rule(itemId){
  const item=items.get(itemId);if(!item||item[10]!=='restore')return null;
  if(rewards.entitlement(itemId)?.durationMs)return {kind:'items',items:[{itemId,count:1}],choice:false,pool:false};
  const matches=rows.filter(row=>row[8]===itemId&&typeof row[35]==='string'&&row[35]!=='0.000000');
  if(!matches.length||matches.some(row=>row[35]!==matches[0][35]))return null;
  const description=[item[23],item[24],...matches.map(row=>row[36])].join('\n');
  if(/随机|概率|几率|机率/.test(description))return null;
  const choice=/自选|任选|自由选择|选择.*其中/.test(description);
  if(!choice&&!/使用后.*获得|开启后.*获得/.test(description))return null;
  const list=[];let hasEntitlement=false;
  for(const part of matches[0][35].split(':')){
    const match=/^(\d+);(\d+)$/.exec(part);if(!match)return null;
    const id=+match[1],count=+match[2];
    if(id===itemId||!items.has(id)||!Number.isSafeInteger(count)||count<1||list.some(x=>x.itemId===id))return null;
    let entitlement;try{entitlement=rewards.entitlement(id);}catch{return null;}
    if(entitlement){if(count!==1)return null;hasEntitlement=true;}
    else if(['unknown','dedicated'].includes(containerOf(id)))return null;
    list.push({itemId:id,count});
  }
  if(!hasEntitlement||!list.length||choice&&(list.length<2||list.length>120))return null;
  return {kind:'items',items:list,choice,pool:false};
}
function prepare(account,list,source,now=Date.now()){
  const ordinary=[],entitlements=[];
  for(const entry of list){
    const reward=entry.itemId?rewards.entitlement(entry.itemId):null;
    if(reward)entitlements.push({entry,reward});else ordinary.push(entry);
  }
  if(!entitlements.length)return {ordinary,grants:[]};
  const draft=structuredClone(account),grants=[];
  // A gift may list its skin before the corresponding hero. Ownership is
  // checked against the complete gift draft, without granting anything yet.
  entitlements.sort((a,b)=>Number(!!a.reward.index)-Number(!!b.reward.index));
  for(const {entry}of entitlements){
    const prepared=rewards.prepare(draft,entry.itemId,entry.count,source,now);
    rewards.apply(draft,prepared);grants.push(prepared);
  }
  return {ordinary,grants,revision:account.revision};
}
function frames(account,grants,options){
  const out=[],notified=new Set();
  for(const {reward}of grants)if(reward.index&&!notified.has(reward.hero)){
    notified.add(reward.hero);out.push(heroes.skinNotice(account,reward.hero,Date.now(),options));
  }
  out.push(heroes.render(account,Date.now(),options));return out.filter(Boolean);
}
module.exports={rule,prepare,frames};
