'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const THRESHOLDS=Object.freeze([10,50,100,200,500,1000,2000,5000,10000,20000,50000,100000]);
let defaultCatalog;
// The native VIP page divides cumulative recharge by 100 before comparing
// these client thresholds. Keeping a separate minor-unit table avoids rounding.
function parseThresholds(lua){
 const matches=[...String(lua).matchAll(/local\s+GoldMaxOwn\s*=\s*\{([^}]+)\}/g)];
 if(matches.length!==1)throw Error('Missing or duplicate native VIP threshold table');
 const values=matches[0][1].split(',').map(x=>Number(x.trim()));
 if(JSON.stringify(values)!==JSON.stringify(THRESHOLDS))throw Error('Client VIP thresholds changed');
 return values.map(x=>x*100);
}
function levelFor(totalMinor,thresholds=THRESHOLDS.map(x=>x*100)){
 if(!Number.isSafeInteger(totalMinor)||totalMinor<0||totalMinor>0xffffffff||thresholds.length!==12)throw Error('Invalid cumulative VIP recharge');
 return thresholds.reduce((level,value)=>level+(totalMinor>=value?1:0),0);
}
function parseCombat(rows){
 if(!Array.isArray(rows))throw Error('Invalid VIP description catalog');
 const byLevel={};
 for(let level=0;level<=12;level++){
  const matches=rows.filter(row=>row['1']===`eClient_VIPInfo${level}`);
  if(matches.length!==1||typeof matches[0]['2']!=='string')throw Error('Missing or duplicate VIP description');
  const text=matches[0]['2'],marker='VIP战场专属属性：',stats={};
  if(text.includes(marker)){
   const tail=text.split(marker)[1].split('#')[0],fields={生命:[1,8],法力值:[2,9],攻击:[30,127],法强:[31,128],韧性:[99]};
   let found=0;
   for(const [name,attrs]of Object.entries(fields)){
    const m=new RegExp(`${name}\\+([0-9]+)`).exec(tail);if(!m)continue;
    const value=Number(m[1]);if(!Number.isSafeInteger(value)||value<=0)throw Error('Invalid VIP combat bonus');
    for(const id of attrs)stats[id]=value;found++;
   }
   if(!found||level<9)throw Error('Unexpected VIP combat description');
  }else if(level>=9)throw Error('Missing VIP combat bonus');
  byLevel[level]=Object.freeze(stats);
 }
 return Object.freeze(byLevel);
}
function parseGifts(rows){
 if(!Array.isArray(rows)||rows.length!==12)throw Error('Invalid VIP level gift catalog');
 const byLevel={};
 for(let level=1;level<=12;level++){
  const matches=rows.filter(row=>row['1']===level);if(matches.length!==1)throw Error('Missing or duplicate VIP gift level');
  const row=matches[0],ids=String(row['2']).split(';').filter(Boolean).map(Number),counts=String(row['3']).split(';').filter(Boolean).map(Number);
  if(ids.length!==counts.length)throw Error('VIP gift identity/count mismatch');
  const seen=new Set(),items=[];
  for(let i=0;i<ids.length;i++){
   if(ids[i]===0&&counts[i]===0)continue;
   if(!Number.isInteger(ids[i])||ids[i]<1||ids[i]>=65535||!Number.isInteger(counts[i])||counts[i]<1||counts[i]>0xffffffff||seen.has(ids[i]))throw Error('Invalid VIP gift item');
   seen.add(ids[i]);items.push(Object.freeze({itemId:ids[i],count:counts[i]}));
  }
  if(!items.length)throw Error('Empty VIP gift');byLevel[level]=Object.freeze(items);
 }
 return Object.freeze(byLevel);
}
function parsePrivilegeGifts(rows){
 if(!Array.isArray(rows)||rows.length!==13)throw Error('Invalid VIP privilege gift catalog');
 const byLevel={};
 for(let level=0;level<=12;level++){
  const matches=rows.filter(row=>row['1']===level);if(matches.length!==1||typeof matches[0]['2']!=='string')throw Error('Missing or duplicate VIP privilege gift');
  const seen=new Set();
  byLevel[level]=Object.freeze(matches[0]['2'].split(';').map(pair=>{
   if(!/^[1-9][0-9]*:[1-9][0-9]*$/.test(pair))throw Error('Invalid VIP privilege gift item');
   const [itemId,count]=pair.split(':').map(Number);
   if(!Number.isInteger(itemId)||itemId>=65535||!Number.isInteger(count)||count>0xffffffff||seen.has(itemId))throw Error('Invalid VIP privilege gift item');
   seen.add(itemId);return Object.freeze({itemId,count});
  }));
 }
 return Object.freeze(byLevel);
}
function load({root=__dirname}={}){
 const useDefault=arguments.length===0;if(useDefault&&defaultCatalog)return defaultCatalog;
 const lua=fs.readFileSync(path.join(root,'research/account-20261009/data__script__gamehall__playerinfo__game_heroviplevel.lua'));
 const desc=fs.readFileSync(path.join(root,'logs/cfg/string_client.json'));
 const gifts=fs.readFileSync(path.join(root,'logs/cfg/svipgift_vipgift.json'));
 const privilege=fs.readFileSync(path.join(root,'logs/cfg/svipgift_vipgiftactivity.json'));
 const catalog=Object.freeze({thresholdMinor:Object.freeze(parseThresholds(lua.toString('utf8'))),thresholdSha256:hash(lua),
  combat:parseCombat(JSON.parse(desc)),combatSha256:hash(desc),gifts:parseGifts(JSON.parse(gifts)),giftSha256:hash(gifts),
  privilegeGifts:parsePrivilegeGifts(JSON.parse(privilege)),privilegeGiftSha256:hash(privilege)});
 if(useDefault)defaultCatalog=catalog;return catalog;
}
function bonuses(level,catalog=load()){
 if(!Number.isInteger(level)||level<0||level>12)throw Error('Invalid VIP combat level');
 return {...catalog.combat[level]};
}
// These are this development recharge's newly reached level gifts. Historical
// gifts and daily/monthly rewards are not reset or inferred from a VIP badge.
function newlyReachedGifts(before,after,catalog=load()){
 if(!Number.isInteger(before)||!Number.isInteger(after)||before<0||after>12||after<before)throw Error('Invalid VIP gift progression');
 return Array.from({length:after-before},(_,i)=>({level:before+i+1,catalogSha256:catalog.giftSha256,items:catalog.gifts[before+i+1].map(x=>({...x}))}));
}
// Both catalogs were explicitly enabled by the user for the local server.
// Receipts, not the historical VIP badge, determine whether each tier remains.
function prepareMailPlans(account,catalog=load()){
 const level=account.vip?.level;
 if(!Number.isInteger(level)||level<0||level>12||!Number.isSafeInteger(account.uid)||account.uid<1||!Number.isSafeInteger(account.playerId)||account.playerId<1)throw Error('Invalid VIP reward account');
 const plans=[];
 for(const [kind,min,table,sha]of [['vip-level',1,catalog.gifts,catalog.giftSha256],['vip-privilege',0,catalog.privilegeGifts,catalog.privilegeGiftSha256]]){
  for(let tier=min;tier<=level;tier++){
   const eventId=`reward-mail:${kind}:${account.uid}:${tier}`;
   if(Object.hasOwn(account.receipts||{},eventId))continue;
   plans.push({kind,tier,source:'development-vip-rewards',uid:account.uid,playerId:account.playerId,eventId,catalogSha256:sha,attachments:table[tier].map(x=>({...x}))});
  }
 }
 return plans;
}
module.exports={load,parseThresholds,parseCombat,parseGifts,parsePrivilegeGifts,levelFor,bonuses,newlyReachedGifts,prepareMailPlans,THRESHOLDS};
