'use strict';
// The native list proves positive absolute deadlines. Zero/absent deadlines
// remain observations; configuration prose never grants or extends ownership.
const wire=require('./player-medal-wire'),observation=require('./player-medal-observation'),catalog=require('./client-medal-catalog.json');
const scalar=(number,value)=>({number,wire:0,value:BigInt(value)});
const nested=(number,children)=>({number,wire:2,children,bytes:Buffer.alloc(0)});
const known=id=>Number.isInteger(id)&&id>0&&Object.hasOwn(catalog.medals,id);
function time(now){if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid medal time');}
function source(account){return account.medalObservation?observation.validate(account.medalObservation,account):null;}
function readable(account,observed,id){
  const count=observed.records.filter(record=>record.id===id).length;
  return known(id)&&(count===1||count===0&&!!account.owned.medals[id]);
}
function deadline(entry){
  // Zero displays the native "obtained" text. A trusted permanent ledger
  // entry may use that display; observing zero never creates such an entry.
  if(entry.expiresAt===null)return 0;
  const seconds=Math.floor(entry.expiresAt/1000);
  if(!Number.isSafeInteger(seconds)||seconds<1||seconds>0xffffffff)throw Error('Medal deadline cannot be represented by this native protocol');
  return seconds;
}
function validate(state,account){
  if(state?.version!==1||state.uid!==account.uid||state.playerId!==account.playerId)throw Error('Medal state identity mismatch');
  if(!Array.isArray(state.equippedIds)||state.equippedIds.length>4||new Set(state.equippedIds).size!==state.equippedIds.length||
    state.equippedIds.some(id=>!known(id)||!account.owned.medals[id])||!Array.isArray(state.viewedIds)||
    new Set(state.viewedIds).size!==state.viewedIds.length||state.viewedIds.some(id=>!known(id))||
    !/^[a-f0-9]{64}$/.test(state.viewObservationSha256)||!Number.isSafeInteger(state.changedAt)||state.changedAt<0)throw Error('Invalid medal state');
  const observed=source(account);if(!observed)throw Error('Medal state has no verified observation');
  if(state.viewObservationSha256===observed.sha256&&state.viewedIds.some(id=>!readable(account,observed,id)))throw Error('Viewed medal is outside this account observation');
  return state;
}
function initial(account,observed,now){return {version:1,uid:account.uid,playerId:account.playerId,equippedIds:[],viewedIds:[],viewObservationSha256:observed.sha256,changedAt:now};}
// Explicit offline migration. Preserve expired ownership as history and never
// downgrade an independently verified longer/permanent entitlement.
function importKnown(account){
  const observed=source(account);if(!observed)return null;
  const imported=[],unresolved=[];
  for(const record of observed.records){
    const reason=!known(record.id)?'unknown-configuration':observed.records.filter(row=>row.id===record.id).length!==1?'duplicate-record':!(record.timeout>0)?'expiration-not-observed':null;
    if(reason){unresolved.push({id:record.id,reason});continue;}
    const expiresAt=record.timeout*1000,existing=account.owned.medals[record.id];
    if(!existing||existing.expiresAt!==null&&existing.expiresAt<expiresAt)account.owned.medals[record.id]={acquiredAt:existing?.acquiredAt??observed.observedAt,expiresAt,source:'capture-medal:'+observed.sha256};
    imported.push(record.id);
  }
  if(!account.medalState){
    const state=initial(account,observed,observed.observedAt);
    state.equippedIds=observed.equippedIds.filter((id,index,ids)=>known(id)&&ids.indexOf(id)===index&&ids.lastIndexOf(id)===index&&
      imported.includes(id)&&account.owned.medals[id]&&(account.owned.medals[id].expiresAt===null||account.owned.medals[id].expiresAt>observed.observedAt));
    account.medalState=state;
  }
  validate(account.medalState,account);return {imported,unresolved};
}
function effectiveEquipped(account,now=Date.now()){
  time(now);if(!account.medalState)return [];
  return validate(account.medalState,account).equippedIds.filter(id=>require('./player-account-state').owns(account,'medals',id,now));
}
// Only use on a transaction draft. Request fields carry medal IDs, never an
// account/object identity; the caller must supply its authenticated account.
function apply(account,request,now=Date.now()){
  time(now);const observed=source(account);if(!observed)throw Error('No verified medal observation');
  if(!request||![2,3].includes(request.operation)||request.info||request.unknownFields?.length)throw Error('Unsupported medal write');
  const state=account.medalState?JSON.parse(JSON.stringify(validate(account.medalState,account))):initial(account,observed,now);
  if(request.operation===2){
    const id=request.viewMedalId;
    if(!readable(account,observed,id)||request.equippedIds?.length)throw Error('Viewed medal is outside this account observation');
    if(state.viewObservationSha256!==observed.sha256){state.viewedIds=[];state.viewObservationSha256=observed.sha256;}
    if(!state.viewedIds.includes(id))state.viewedIds.push(id);
  }else{
    const ids=request.equippedIds;
    if(request.viewMedalId!==undefined||!Array.isArray(ids)||ids.length>4||new Set(ids).size!==ids.length||
      ids.some(id=>!known(id)||!require('./player-account-state').owns(account,'medals',id,now)))throw Error('Medal is not owned, duplicate, or has expired');
    state.equippedIds=[...ids];
  }
  state.changedAt=now;validate(state,account);account.medalState=state;return state;
}
function currentBranch(account,operation,now){
  time(now);if(![1,2,3].includes(operation))throw Error('Invalid medal response operation');
  const observed=source(account);if(!observed)return null;
  const saved=wire.decode(Buffer.from(observed.frameBase64,'base64')),info=saved.medal.info;
  const state=account.medalState?validate(account.medalState,account):null;
  const viewed=new Set(state?.viewObservationSha256===observed.sha256?state.viewedIds:[]);
  for(const record of info.ownedRecords){
    if(viewed.has(record.id)){
      const fresh=record.fields.find(field=>field.number===2);
      if(fresh)fresh.value=0n;else record.fields.push(scalar(2,0));
    }
    const entitlement=account.owned.medals[record.id];
    if(known(record.id)&&entitlement){
      const seconds=deadline(entitlement),timeout=record.fields.find(field=>field.number===3);
      if(timeout)timeout.value=BigInt(seconds);else record.fields.push(scalar(3,seconds));
    }
  }
  // Preserve unknown ownership/info bytes, replacing only the verified equip
  // list. Unresolved zero-time records remain visible evidence, not grants.
  const children=info.fields.filter(field=>field.number!==2);
  for(const id of Object.keys(account.owned.medals).map(Number).sort((a,b)=>a-b)){
    if(known(id)&&!observed.records.some(record=>record.id===id)){
      // The account ledger is the independent entitlement authority. Add its
      // known record so the client's ID-based lock and equipment agree; omit
      // an unobserved new flag and never manufacture reward acquisition.
      children.push(nested(1,[scalar(1,id),scalar(3,deadline(account.owned.medals[id]))]));
    }
  }
  for(const id of effectiveEquipped(account,now))children.push(scalar(2,id));
  return nested(14,[scalar(1,operation),nested(2,children)]);
}
function reply(account,operation=1,now=Date.now()){
  const branch=currentBranch(account,operation,now);if(!branch)return null;
  const header=require('./bag').mkFrame(11888,Buffer.alloc(0),{stream:account.playerId,flags:0xd2});
  return wire.encode({header,fields:[branch]});
}
function outbound(frame,account,now=Date.now(),{enabled=true}={}){
  const model=wire.decode(frame);if(!model.medal)return frame;
  const replacement=enabled&&account?currentBranch(account,model.medal.operation,now):null;
  model.fields=model.fields.filter(field=>field.number!==14);if(replacement)model.fields.push(replacement);
  return model.fields.length?wire.encode(model):null;
}
module.exports={validate,importKnown,apply,effectiveEquipped,reply,outbound,catalog};
