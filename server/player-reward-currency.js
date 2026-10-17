'use strict';
const crypto=require('node:crypto');
const GOLD_ITEM=346,GOLD_ATTR=50,MAX=0xffffffff;
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=MAX;
const balance=value=>Number.isSafeInteger(value)&&value>=0&&value<=MAX;
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
let goldVerified=false;
function verifyGold(){
 if(!goldVerified){
  const item=require('./current-item-catalog').load().byId[GOLD_ITEM];
  if(item?.name!=='金币'||item.type!=='restore'||!String(item.desc||'').includes('可销毁获得等量金币'))throw Error('Gold item rule differs from current client');
  goldVerified=true;
 }
}
function goldReward(itemId,count){
 if(itemId!==GOLD_ITEM)return null;
 if(!uint(count))throw Error('Invalid gold reward quantity');verifyGold();return {attr:GOLD_ATTR,amount:count};
}
// Only the exact item346 is auto-used. Diamonds, numbered coin items and all
// gift boxes retain their existing item/use rules and original catalog IDs.
function convertRewards(rewards){
 if(!Array.isArray(rewards))throw Error('Invalid reward list');let totalGold=0;
 return rewards.map(reward=>{
  if(!reward||typeof reward!=='object')throw Error('Invalid reward');
  let out;
  if(reward.itemId!==undefined){
   if(!Number.isSafeInteger(reward.itemId)||reward.itemId<1||reward.itemId>=65535||!uint(reward.count)||reward.attr!==undefined)throw Error('Invalid reward item');
   out=goldReward(reward.itemId,reward.count)||{...reward};
  }else{
   if(!Number.isInteger(reward.attr)||reward.attr<0||reward.attr>255||!uint(reward.amount))throw Error('Invalid reward currency');
   out={...reward};
  }
  if(out.attr===GOLD_ATTR){totalGold+=out.amount;if(!balance(totalGold))throw Error('Gold reward total exceeds wallet range');}
  return out;
 });
}
function nextGold(rewards,current){
 if(!balance(current))throw Error('Unknown or invalid wallet gold balance');
 const converted=convertRewards(rewards),amount=converted.filter(r=>r.attr===GOLD_ATTR).reduce((sum,r)=>sum+r.amount,0),after=current+amount;
 if(!balance(after))throw Error('Gold reward overflows wallet');return {amount,before:current,after,rewards:converted};
}
function metadataSafe(item){
 if(item.locked||item.dual||item.soul||item.forge||item.enhancementLevel||item.enhancementSkillLevel||
  item.reforgeHex&& !/^0+$/.test(item.reforgeHex))throw Error('Gold item has locked or equipment metadata');
 if(item.instanceHex!==undefined){
  if(typeof item.instanceHex!=='string'||!/^[a-f0-9]{980}$/i.test(item.instanceHex))throw Error('Invalid gold native instance');
  const bytes=Buffer.from(item.instanceHex,'hex');
  if(bytes.readUInt16LE(0)!==GOLD_ITEM||bytes.readUInt16LE(4)!==item.count||bytes.subarray(8,16).toString('hex')!==item.guid.toLowerCase()||
   bytes[73]!==0||bytes[74]!==0||bytes.subarray(76,118).some(byte=>byte!==0))throw Error('Gold native instance has mismatched or equipment metadata');
 }
}
// Pure preflight for the user-authorized offline conversion of existing
// coins. The caller commits removed slots and wallet gold together; a plan
// itself never touches persisted inventory, wallet, equipment, or locks.
function planExistingGold(slots,currentGold,{locks=null,equippedSlots=new Set()}={}){
 if(!(slots instanceof Map)||!(equippedSlots instanceof Set)||(locks!==null&&typeof locks.get!=='function'))throw Error('Invalid gold conversion inventory context');
 verifyGold();const consumed=[],guids=new Set(),next=new Map(slots),owners=new Map();let amount=0;
 for(const item of slots.values())if(typeof item?.guid==='string'&&/^[a-f0-9]{16}$/i.test(item.guid)){
  const id=item.guid.toLowerCase();owners.set(id,(owners.get(id)||0)+1);
 }
 for(const [slot,item]of [...slots].sort(([a],[b])=>a-b)){
  if(item?.itemId!==GOLD_ITEM)continue;
  if(!Number.isInteger(slot)||slot<0||slot>65535||!uint(item.count)||item.count>65535||
   typeof item.guid!=='string'||!/^[a-f0-9]{16}$/i.test(item.guid)||/^0+$/.test(item.guid))throw Error('Invalid existing gold item instance');
  const guid=item.guid.toLowerCase();if(guids.has(guid)||owners.get(guid)!==1||equippedSlots.has(slot)||locks?.get(guid)?.locked)throw Error('Existing gold instance is duplicated, equipped or locked');
  metadataSafe(item);guids.add(guid);amount+=item.count;if(!balance(amount))throw Error('Existing gold conversion total overflow');
  consumed.push({slot,itemId:GOLD_ITEM,count:item.count,guid,instanceSha256:digest(item)});next.delete(slot);
 }
 const totals=nextGold(amount?[{itemId:GOLD_ITEM,count:amount}]:[],currentGold);
 return {itemId:GOLD_ITEM,attr:GOLD_ATTR,amount,before:totals.before,after:totals.after,consumed,nextSlots:next,sourceSha256:digest(consumed)};
}
module.exports={GOLD_ITEM,GOLD_ATTR,goldReward,convertRewards,deliveryRewards:convertRewards,nextGold,planExistingGold};
