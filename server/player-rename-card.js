'use strict';
// Pure rename preparation. The caller serializes the shared current-name
// registry and commits its draft, the account ledger and bag under one journal.
// No captured identity, archived account or filesystem discovery is authority.
const crypto=require('node:crypto'),GBK=require('./gbk'),wire=require('./battle-wire');
const CARD_ITEM_ID=6,MIN_NAME_BYTES=4,MAX_NAME_BYTES=14;
const copy=value=>JSON.parse(JSON.stringify(value));
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=0xffffffff;
const identity=account=>[account?.uid,account?.playerId,account?.loginHash];
const key=name=>name.normalize('NFKC').toLocaleLowerCase('en-US');
class RenameError extends Error{constructor(reason,status){super(reason);this.reason=reason;this.status=status;}}
const reject=(reason,status=1002)=>{throw new RenameError(reason,status);};
function nameBytes(name){
  if(typeof name!=='string'||/[\s\p{C}]/u.test(name))reject('invalid-name',1001);
  const bytes=GBK.encode(name);
  if(GBK.decode(bytes)!==name||bytes.includes(0))reject('invalid-name',1001);
  if(bytes.length<MIN_NAME_BYTES)reject('name-too-short',1004);
  if(bytes.length>MAX_NAME_BYTES)reject('name-too-long',1001);
  return bytes;
}
function request(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==51||frame.readUInt32LE(0)!==51||frame.readUInt32LE(4)!==0||
    frame.readUInt16LE(8)!==1086||frame.readUInt16LE(10)!==0)reject('invalid-rename-request',1001);
  const field=frame.subarray(12),end=field.indexOf(0);
  if(end<0||field.subarray(end).some(byte=>byte!==0))reject('invalid-rename-request',1001);
  const bytes=field.subarray(0,end),name=GBK.decode(bytes),encoded=nameBytes(name);
  if(!encoded.equals(bytes))reject('invalid-name',1001);
  return {operation:'rename',name};
}
function reply(result,{stream=0,flags=0xd2}={}){
  const status=result?.ok?0:result?.status;
  if(!Number.isInteger(status)||![0,1000,1001,1002,1003,1004].includes(status)||!count(stream))throw Error('Invalid rename reply');
  // Native handler reads u16 status at +12 and 14 name bytes at +14. A
  // terminating byte also keeps its earlier C-string consumers bounded.
  const payload=Buffer.alloc(17);payload.writeUInt16LE(status);
  if(status===0)nameBytes(result.name).copy(payload,2);
  return wire.frame(1087,stream,payload,flags);
}
function registryRows(registeredAccounts){
  if(!Array.isArray(registeredAccounts)||!registeredAccounts.length)reject('registered-accounts-required');
  const rows={},uids=new Set(),players=new Set(),logins=new Set(),names=new Set();
  for(const account of registeredAccounts){
    if(!id(account?.uid)||!id(account?.playerId)||!/^[a-f0-9]{64}$/.test(account?.loginHash||''))reject('invalid-registered-account');
    nameBytes(account.name);
    if(uids.has(account.uid)||players.has(account.playerId)||logins.has(account.loginHash))reject('duplicate-registered-identity');
    if(names.has(key(account.name)))reject('registered-name-conflict',1000);
    uids.add(account.uid);players.add(account.playerId);logins.add(account.loginHash);names.add(key(account.name));
    rows[account.uid]={uid:account.uid,playerId:account.playerId,loginHash:account.loginHash,name:account.name};
  }
  return rows;
}
function createRegistry(registeredAccounts){return {version:1,revision:0,accounts:registryRows(registeredAccounts)};}
function validateRegistry(registry){
  if(registry?.version!==1||!count(registry.revision)||!registry.accounts||Array.isArray(registry.accounts))reject('invalid-name-registry');
  const rows=registryRows(Object.values(registry.accounts));
  if(Object.keys(registry.accounts).some(uid=>String(rows[uid]?.uid)!==uid))reject('invalid-name-registry-key');
  return registry;
}
function registeredRegistry(registeredAccounts,registry){
  const current=createRegistry(registeredAccounts);
  if(!registry)return current;
  validateRegistry(registry);
  if(sha(registry.accounts)!==sha(current.accounts))reject('name-registry-current-accounts-mismatch');
  return copy(registry);
}
function validateAccount(account){
  if(!id(account?.uid)||!id(account?.playerId)||!/^[a-f0-9]{64}$/.test(account?.loginHash||'')||!count(account?.revision)||
    !account.receipts||Array.isArray(account.receipts))reject('invalid-rename-account');
  nameBytes(account.name);
}
function prepare({account,registeredAccounts,registry,slots,name,locks=null,authenticated=false,frozen=false,inMatch=false,now=Date.now(),preferredSlot}={}){
  try{
    if(authenticated!==true)reject('account-not-authenticated');
    if(frozen)reject('rename-storage-frozen');
    if(inMatch)reject('rename-during-match');
    if(!Number.isSafeInteger(now)||now<0)reject('invalid-rename-time');
    validateAccount(account);nameBytes(name);
    const beforeRegistry=registeredRegistry(registeredAccounts,registry),owner=beforeRegistry.accounts[account.uid];
    if(!owner||sha(identity(owner))!==sha(identity(account))||owner.name!==account.name)reject('rename-owner-mismatch');
    if(Object.values(beforeRegistry.accounts).some(row=>row.uid!==account.uid&&key(row.name)===key(name)))reject('name-already-exists',1000);
    // Native requests have no client nonce. Retrying the already-current name
    // is always a no-op, including after reconnect or restart.
    if(account.name===name)return {ok:true,repeated:true,name,expectedRevision:account.revision,registryBefore:beforeRegistry};
    if(!(slots instanceof Map))reject('invalid-rename-inventory');
    const candidates=[...slots].filter(([slot,item])=>Number.isInteger(slot)&&slot>=0&&slot<=0xffff&&item?.itemId===CARD_ITEM_ID&&
      Number.isSafeInteger(item.count)&&item.count>0&&item.count<=0xffff&&/^[a-f0-9]{16}$/i.test(item.guid||'')&&
      !item.locked&&!locks?.get?.(item.guid)?.locked);
    if(!candidates.length)reject('rename-card-not-owned');
    let chosen;
    if(preferredSlot!==undefined){chosen=candidates.find(([slot])=>slot===preferredSlot);if(!chosen)reject('rename-card-slot-not-owned');}
    else chosen=candidates.sort(([a],[b])=>a-b)[0];
    const [slot,card]=chosen,cardBefore=copy(card),cardAfter=card.count===1?null:{...copy(card),count:card.count-1};
    const payload={uid:account.uid,playerId:account.playerId,loginHash:account.loginHash,beforeName:account.name,name,slot,
      cardId:CARD_ITEM_ID,guid:card.guid,beforeCount:card.count,afterCount:card.count-1};
    const eventId=`rename-card:${account.uid}:${account.revision}:${card.guid}:${sha(name).slice(0,24)}`;
    const registryAfter=copy(beforeRegistry);registryAfter.revision++;registryAfter.accounts[account.uid].name=name;
    validateRegistry(registryAfter);
    return {ok:true,repeated:false,name,uid:account.uid,playerId:account.playerId,loginHash:account.loginHash,
      expectedRevision:account.revision,accountBeforeSHA256:sha(account),eventId,payload,receiptSHA256:sha(payload),at:now,
      slot,cardBefore,cardAfter,registryBefore:beforeRegistry,registryAfter};
  }catch(error){if(error instanceof RenameError)return {ok:false,reason:error.reason,status:error.status};throw error;}
}
function checkPrepared(prepared){
  if(!prepared?.ok||prepared.repeated||!prepared.eventId||prepared.receiptSHA256!==sha(prepared.payload)||
    prepared.name!==prepared.payload.name||prepared.uid!==prepared.payload.uid||prepared.playerId!==prepared.payload.playerId||
    prepared.loginHash!==prepared.payload.loginHash||prepared.slot!==prepared.payload.slot||prepared.cardBefore?.itemId!==CARD_ITEM_ID||
    prepared.cardBefore.guid!==prepared.payload.guid||prepared.cardBefore.count!==prepared.payload.beforeCount||
    (prepared.cardAfter?.count??0)!==prepared.payload.afterCount||prepared.payload.afterCount!==prepared.payload.beforeCount-1||
    !count(prepared.expectedRevision)||prepared.expectedRevision>0xffffffff||!Number.isSafeInteger(prepared.at)||prepared.at<0)
    reject('invalid-rename-plan');
  nameBytes(prepared.name);validateRegistry(prepared.registryBefore);validateRegistry(prepared.registryAfter);
  const beforeOwner=prepared.registryBefore.accounts[prepared.uid],expectedCard=prepared.cardBefore.count===1?null:{...copy(prepared.cardBefore),count:prepared.cardBefore.count-1};
  if(!beforeOwner||sha(identity(beforeOwner))!==sha([prepared.uid,prepared.playerId,prepared.loginHash])||
    beforeOwner.name!==prepared.payload.beforeName||sha(expectedCard)!==sha(prepared.cardAfter)||
    prepared.eventId!==`rename-card:${prepared.uid}:${prepared.expectedRevision}:${prepared.cardBefore.guid}:${sha(prepared.name).slice(0,24)}`)
    reject('invalid-rename-plan');
  const expected=copy(prepared.registryBefore);expected.revision++;expected.accounts[prepared.uid].name=prepared.name;
  if(sha(expected)!==sha(prepared.registryAfter))reject('invalid-rename-registry-plan');
}
function checkAccount(account,prepared){
  checkPrepared(prepared);validateAccount(account);
  if(account.uid!==prepared.uid||account.playerId!==prepared.playerId||account.loginHash!==prepared.loginHash)reject('rename-owner-mismatch');
  if(account.receipts[prepared.eventId]!==undefined){
    if(account.receipts[prepared.eventId]!==prepared.receiptSHA256||account.name!==prepared.name)reject('rename-receipt-conflict');
    return {repeated:true};
  }
  if(account.revision!==prepared.expectedRevision||sha(account)!==prepared.accountBeforeSHA256)reject('rename-account-changed');
  return {repeated:false};
}
function checkSlots(slots,prepared,locks=null){
  checkPrepared(prepared);
  if(!(slots instanceof Map)||!slots.has(prepared.slot)||sha(slots.get(prepared.slot))!==sha(prepared.cardBefore))reject('rename-card-changed');
  if(slots.get(prepared.slot).locked||locks?.get?.(prepared.cardBefore.guid)?.locked)reject('rename-card-locked');
}
function applyAccount(account,prepared){
  const result=checkAccount(account,prepared);if(result.repeated)return result;
  account.name=prepared.name;
  Object.defineProperty(account.receipts,prepared.eventId,{value:prepared.receiptSHA256,enumerable:true,writable:true,configurable:true});
  return {repeated:false,name:prepared.name};
}
function applySlots(slots,prepared){
  checkSlots(slots,prepared);
  if(prepared.cardAfter)slots.set(prepared.slot,copy(prepared.cardAfter));else slots.delete(prepared.slot);
  return slots;
}
function applyRegistry(registry,prepared){
  checkPrepared(prepared);validateRegistry(registry);
  if(sha(registry)!==sha(prepared.registryBefore))reject('name-registry-changed');
  registry.revision=prepared.registryAfter.revision;registry.accounts=copy(prepared.registryAfter.accounts);return registry;
}
// In-memory integration helper checks all three preimages before touching any
// of them. Persistence must still be one caller-owned atomic economic commit.
function apply({account,slots,registry},prepared){
  const checked=checkAccount(account,prepared);
  if(checked.repeated)return {repeated:true,name:account.name};
  checkSlots(slots,prepared);validateRegistry(registry);
  if(sha(registry)!==sha(prepared.registryBefore))reject('name-registry-changed');
  applyRegistry(registry,prepared);applySlots(slots,prepared);applyAccount(account,prepared);
  return {repeated:false,name:prepared.name};
}
module.exports={CARD_ITEM_ID,MIN_NAME_BYTES,MAX_NAME_BYTES,RenameError,nameBytes,nameKey:key,request,reply,createRegistry,validateRegistry,
  prepare,checkAccount,checkSlots,applyAccount,applySlots,applyRegistry,apply};
