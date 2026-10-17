'use strict';
const path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const empty=()=>({masterLevel:null,collectorBonus:{},profile:{}});
const coefficient=Object.freeze({fine:[.6,.4,.1,.2],epic:[.6,.4,.1,.2],legendary:[1.8,1.2,.3,.5],excellent:[3,2.1,.5,.8],limited:[3,2.1,.5,.8],limitedLegendary:[12,8.4,2,3.2],eternal:[30,21,5,9],collectible:[90,63,15,27]});
// This projection is read only. It never grants skins or supplies a default Master level.
function extract(account,{catalog=require('./battle-skin-quality-catalog')}={}){
 if(!account||!Number.isInteger(account.uid)||account.uid<1||!Number.isInteger(account.playerId)||account.playerId<1)throw Error('Invalid progression account identity');
 const growth=account.growth===undefined?null:require('./player-growth-wire').validate(account.growth,account);
 const entries=account.owned?.skins;if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('Missing progression skin ledger');
 if(!catalog||catalog.version!==1||!catalog.grades||!catalog.mapping||typeof catalog.sourceSha256!=='string')throw Error('Invalid skin quality catalog');
 const rarityCounts={},gradeCounts={},missingCatalogSkinKeys=[],unknownRarityGrades=new Set(),ownership=[];
 let permanentByLedgerCount=0,permanentByProofCount=0,importLifetimeUncertainCount=0,timedExcludedCount=0;
 const totals=[0,0,0,0];
 for(const [key,entry]of Object.entries(entries).sort(([a],[b])=>Number(a)-Number(b))){
  if(!/^[1-9][0-9]*$/.test(key)||!Number.isSafeInteger(Number(key))||Number(key)>0xffffffff||!entry||!Number.isSafeInteger(entry.acquiredAt)||entry.acquiredAt<0||typeof entry.source!=='string'||!(entry.expiresAt===null||Number.isSafeInteger(entry.expiresAt)&&entry.expiresAt>=0))throw Error('Invalid progression skin entitlement');
  ownership.push([Number(key),entry.acquiredAt,entry.expiresAt,entry.source,entry.permanentProof??null]);
  if(entry.expiresAt!==null){timedExcludedCount++;continue;}
  permanentByLedgerCount++;
  if(entry.permanentProof!==undefined){require('./player-avatar').validateProof(entry.permanentProof,key,entry);permanentByProofCount++;}
  else if(/^capture:/.test(entry.source))importLifetimeUncertainCount++;
  const grade=catalog.grades[key];
  if(!Number.isInteger(grade)){missingCatalogSkinKeys.push(Number(key));continue;}
  gradeCounts[grade]=(gradeCounts[grade]||0)+1;
  const rarity=catalog.mapping[grade];
  if(rarity===null)continue; // Only an explicitly proven non-counting category may use null.
  if(!Object.hasOwn(coefficient,rarity)){unknownRarityGrades.add(grade);continue;}
  rarityCounts[rarity]=(rarityCounts[rarity]||0)+1;
  coefficient[rarity].forEach((value,index)=>totals[index]+=value);
 }
 const rounded=totals.map(n=>Math.round(n*1000000)/1000000),bonus={};
 if(rounded.some(n=>n!==0))Object.assign(bonus,{1:rounded[0],8:rounded[0],2:rounded[1],9:rounded[1],30:rounded[2],127:rounded[2],42:rounded[2],44:rounded[2],31:rounded[3],128:rounded[3]});
 return {masterLevel:growth?.level??null,collectorBonus:bonus,profile:{uid:account.uid,playerId:account.playerId,
  growth:growth?{level:growth.level,source:growth.source,observedAt:growth.observedAt,receiptSha256:growth.receiptSha256??null}:null,
  collector:{ownedCount:Object.keys(entries).length,permanentByLedgerCount,permanentByProofCount,importLifetimeUncertainCount,timedExcludedCount,
   ownershipRule:'local-ledger-null-expiry',importLifetimeRule:'capture-mask-availability-does-not-prove-historical-permanence',
   gradeCounts,rarityCounts,unknownRarityGrades:[...unknownRarityGrades].sort((a,b)=>a-b),missingCatalogSkinKeys,
   complete:unknownRarityGrades.size===0&&missingCatalogSkinKeys.length===0,catalogSha256:catalog.sourceSha256,mappingSha256:hash(catalog.mapping),ownershipSha256:hash(ownership)}}};
}
function read(file,{accountFile=process.env.DSH_PLAYER_ACCOUNTS,uid=Number(process.env.DSH_PLAYER_UID),catalog}={}){
 if(!accountFile)return empty();
 if(typeof file!=='string'||!path.isAbsolute(file)||!path.isAbsolute(accountFile)||!Number.isInteger(uid)||uid<1||uid>0xffffffff||path.dirname(path.resolve(file))!==path.dirname(path.resolve(accountFile)))throw Error('Progression ledger is outside the current loadout account');
 const native=require('node:fs');
 if(native.realpathSync(path.dirname(file))!==native.realpathSync(path.dirname(accountFile)))throw Error('Progression ledger directory binding mismatch');
 const account=new(require('./player-account-state').PlayerAccounts)(accountFile).get(uid);
 if(!account||account.uid!==uid)throw Error('Progression loadout account is unavailable');
 return extract(account,{catalog});
}
module.exports={read,extract,coefficient};
