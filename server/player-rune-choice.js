'use strict';
// Verified 7617 choices from current Data9.jmp, ordinary (not tiyan) table.
// Planning is pure: the account worker must commit this rune and its exact
// owned coupon slot together under EquipmentEconomyCommit before replying.
const crypto=require('node:crypto'),runes=require('./rune-system');
const currentRows=require('./research/rune-choice-v5-20261012/Data9-charmcustomize_c.json');
const TOKEN_ID=7617,CONFIG_SHA256='9eaff9452c0a9b1a02d4a0125440224e5787f9c1e7c66a25205f14848e7ac6e1';
const expectedGodsendIds=[1,2,3,4,5,6,7,8,10,11,12,13,14,15,16,17,18,20,21,22,23,24,28,29];
const sourceRow=currentRows.find(row=>Number(row[1])===TOKEN_ID);
if(!sourceRow||sourceRow[2]!==0||sourceRow[3]!==5||sourceRow[4]!==3||String(sourceRow[6])!==expectedGodsendIds.join(';'))throw Error('Unverified current 7617 rune choice configuration');
const allowedGodsendIds=Object.freeze([...expectedGodsendIds]),godsendById=new Map(runes.godsendRows.map(row=>[row.id,row]));
const clone=value=>Buffer.isBuffer(value)?Buffer.from(value):Array.isArray(value)?value.map(clone):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clone(item)])):value;
const fail=reason=>({ok:false,reason});
const guid=value=>Buffer.isBuffer(value)?value.toString('hex'):typeof value==='string'?value.toLowerCase():'';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bagHash=bag=>hash([...bag].sort((a,b)=>a[0]-b[0]));
const ownerKey=owner=>owner&&Number.isSafeInteger(owner.uid)&&owner.uid>0&&owner.uid<=0xffffffff&&Number.isSafeInteger(owner.playerId)&&owner.playerId>0&&owner.playerId<=0xffffffff&&Number.isSafeInteger(owner.revision??0)&&(owner.revision??0)>=0
 ? `${owner.uid}:${owner.playerId}:${owner.revision??0}`:null;
const tierPools=Object.freeze(Array.from({length:5},(_,tier)=>Object.freeze([...new Set([1,2,3,4].flatMap(color=>runes.unlockedAttrs(color,tier+1).map(([id])=>Number(id))))])));
function recognizes(request){return request?.system==='rune'&&Number(request.tokenId)===TOKEN_ID&&['exchangeAdvanced','exchangeAdvancedSelect'].includes(request.operation);}
function parseNative(payload){
 if(!Buffer.isBuffer(payload)||![28,32].includes(payload.length))return null;
 const words=Array.from({length:payload.length/4},(_,i)=>payload.readUInt32LE(i*4));
 const mode=words.length===7?1:words.shift(),tokenId=words.shift();
 if(tokenId!==TOKEN_ID||![0,1,2].includes(mode))return null;
 return {system:'rune',operation:mode===1?'exchangeAdvanced':'exchangeAdvancedSelect',mode,tokenId,
  attributeIds:words.slice(0,5),godsendId:words[5],count:1,rawArgs:Array.from({length:payload.length/4},(_,i)=>payload.readUInt32LE(i*4))};
}
function selection(request,{preview=false}={}){
 if(!recognizes(request)||(request.operation==='exchangeAdvanced'&&(request.mode??1)!==1)||(request.operation==='exchangeAdvancedSelect'&&request.mode!==2)||request.count!==undefined&&request.count!==1||request.level!==undefined&&request.level!==null&&request.level!==5||request.color!==undefined&&request.color!==null&&request.color!==5)return fail('invalid-rune-choice-request');
 const attrs=request.attributeIds;
 if(!Array.isArray(attrs)||attrs.length!==5||attrs.some((id,tier)=>!Number.isSafeInteger(id)||!tierPools[tier].includes(id)))return fail('invalid-rune-choice-attributes');
 const selectedGodsend=godsendById.get(request.godsendId);
 if(!allowedGodsendIds.includes(request.godsendId)||!selectedGodsend)return fail('rune-choice-godsend-not-allowed');
 const values={};for(const id of attrs){
  const value=Math.max(...[1,2,3,4].map(color=>Number(runes.template(color,5).attrs[id]||0)));
  if(!Number.isSafeInteger(value)||value<=0||value>0xffff)return fail('unverified-rune-choice-attribute-value');
  values[id]=value;
 }
 return {ok:true,attributes:[...attrs],attrs:runes.sortRuneAttrs(values),godsend:clone(selectedGodsend),preview};
}
function prepare(state,request,{bag,owner,locks=null,capacity=0xffff,now=Date.now()}={}){
 const identity=ownerKey(owner);
 if(!identity)return fail('rune-choice-account-identity-required');
 if(!(bag instanceof Map)||state?.version!==1||!state.inventory||Array.isArray(state.inventory)||!Array.isArray(state.pages)||!Number.isSafeInteger(state.nextId)||state.nextId<1)return fail('invalid-rune-choice-state');
 if(!Number.isSafeInteger(capacity)||capacity<1||capacity>0xffff||!Number.isSafeInteger(now)||now<0)return fail('invalid-rune-choice-capacity-or-clock');
 const readOnly=request?.operation==='exchangeAdvancedSelect';
 if(!recognizes(request))return fail('unsupported-rune-choice-token');
 const coupons=[...bag].filter(([,item])=>item?.itemId===TOKEN_ID&&Number.isSafeInteger(item.count)&&item.count>0).sort((a,b)=>a[0]-b[0]);
 const usable=coupons.filter(([,item])=>!item.locked&&!locks?.get?.(guid(item.guid))?.locked);
 if(!usable.length)return fail(coupons.length?'rune-choice-token-locked':'rune-choice-token-not-owned');
 const [slot,coupon]=usable[0],couponGuid=guid(coupon.guid);
 if(!Number.isSafeInteger(slot)||slot<0||!(/^[0-9a-f]{16}$/.test(couponGuid))||couponGuid==='0000000000000000'||[...bag.values()].filter(item=>guid(item?.guid)===couponGuid).length!==1)return fail('invalid-rune-choice-owned-token-guid');
 // Mode 0 selects the coupon in the native UI; its six selectors are zero.
 if(readOnly&&request.mode===0){
  if(!Array.isArray(request.attributeIds)||request.attributeIds.length!==5||request.attributeIds.some(id=>id!==0)||request.godsendId!==0)return fail('invalid-rune-choice-panel-selection');
  return {ok:true,readOnly:true,request:clone(request),result:{ok:true,mode:0,tokenId:TOKEN_ID,attributes:[0,0,0,0,0],godsendId:0},slot,guid:couponGuid};
 }
 const selected=selection(request,{preview:readOnly});if(!selected.ok)return selected;
 const base={...runes.template(5,5),attrs:selected.attrs,nativeAttrIds:runes.orderedRuneAttrs(selected.attrs).map(([id])=>Number(id)),
  godsend:selected.godsend,godsendId:selected.godsend.id,godsendName:selected.godsend.name,locked:false,unlockAt:0};
 if(readOnly)return {ok:true,readOnly:true,request:clone(request),slot,guid:couponGuid,result:{ok:true,mode:2,tokenId:TOKEN_ID,attributes:selected.attributes,godsendId:selected.godsend.id,preview:true,rune:{...base,id:0}}};
 if(Object.keys(state.inventory).length>=capacity)return fail('rune-choice-inventory-full');
 let id=state.nextId;while(Object.hasOwn(state.inventory,String(id)))id++;
 if(id>0xffff)return fail('rune-choice-only-id-exhausted');
 const rune={...base,id,source:{kind:'rune-choice',tokenId:TOKEN_ID,guid:couponGuid,uid:owner.uid,playerId:owner.playerId,acquiredAt:now}};
 const next=clone(state);next.nextId=id+1;next.inventory[String(id)]=rune;
 if(next.godsend){
  next.godsend.ownedGodsendIds=[...new Set([...(next.godsend.ownedGodsendIds||[]),selected.godsend.id])];
  const earned=Math.min(10,2+Math.floor(next.godsend.ownedGodsendIds.length/3));
  next.godsend.filterSlots=Math.max(earned,Number(next.godsend.filterSlots)||2);
  next.godsend.filterBans=Array.from({length:next.godsend.filterSlots},(_,i)=>next.godsend.filterBans?.[i]||0);
 }
 const nextBag=new Map([...bag].map(([key,item])=>[key,clone(item)]));
 if(coupon.count===1)nextBag.delete(slot);else nextBag.set(slot,{...clone(coupon),count:coupon.count-1});
 return {ok:true,readOnly:false,request:clone(request),owner:identity,beforeRuneHash:hash(state),beforeBagHash:bagHash(bag),
  slot,guid:couponGuid,state:next,bag:nextBag,changedSlots:[slot],result:{ok:true,tokenId:TOKEN_ID,count:1,rune:clone(rune),runes:[clone(rune)],
   attributes:selected.attributes,godsendId:selected.godsend.id,godsend:clone(selected.godsend),consumedTokenId:TOKEN_ID,tokenSource:'inventory'}};
}
function assertCurrent(prepared,state,{bag,owner}={}){
 if(!prepared?.ok||prepared.readOnly||prepared.owner!==ownerKey(owner)||!(bag instanceof Map)||prepared.beforeRuneHash!==hash(state)||prepared.beforeBagHash!==bagHash(bag))throw Error('Rune choice preparation changed');
 return true;
}
module.exports={TOKEN_ID,CONFIG_SHA256,allowedGodsendIds,tierPools,recognizes,parseNative,selection,prepare,assertCurrent};
