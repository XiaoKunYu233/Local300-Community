'use strict';

// Pure MSG_SKILL_NOTIFYSTATUS projection. Supply the current installed table
// and an explicit list of reviewed status/level pairs; never reuse capture bytes.
const P=require('./battle-protobuf'),W=require('./battle-wire');
// Native remove finds the first record by status ID, without selecting its
// source/level. Keep one displayed record per status ID on each target.
const key=e=>e.statusId;
const integer=(value,name,min=0,max=0xffffffff)=>{
  if(!Number.isSafeInteger(value)||value<min||value>max)throw Error(`Invalid native status ${name}`);
  return value;
};
function create({statuses,icons=[],allowed}={}){
  if(!Array.isArray(statuses)||!Array.isArray(icons)||!Array.isArray(allowed)||!allowed.length)
    throw Error('Native status catalog and reviewed allowlist required');
  const all=new Map(),iconMap=new Map(icons.map(row=>[Number(row[1]),row]));
  for(const row of statuses){
    const id=Number(row[1]),level=Number(row[2]);
    if(!Number.isSafeInteger(id)||!Number.isSafeInteger(level)||id<1||level<1)continue;
    const idKey=`${id}:${level}`;
    // Installed tables contain a few unrelated duplicate keys. Never choose
    // their first/last row by accident; a reviewed ambiguous pair is rejected.
    if(all.has(idKey)){all.set(idKey,null);continue;}
    const icon=iconMap.get(id);
    all.set(idKey,Object.freeze({statusId:id,level,name:String(row[59]||''),
      showIcon:Number(row[46])===1,canOverlap:Number(row[47])===1,
      icon:typeof icon?.[26]==='string'?icon[26]:null,description:typeof icon?.[24]==='string'?icon[24]:null}));
  }
  const reviewed=new Map();
  for(const pair of allowed){
    const id=integer(pair?.statusId,'id',1,0xffff),level=integer(pair?.level,'level',1,0xffff),idKey=`${id}:${level}`;
    if(!all.has(idKey))throw Error(`Uninstalled native status ${idKey}`);
    if(!all.get(idKey))throw Error(`Ambiguous native status ${idKey}`);
    if(reviewed.has(idKey))throw Error('Duplicate reviewed native status');
    reviewed.set(idKey,all.get(idKey));
  }
  const catalog=(id,level)=>reviewed.get(`${id}:${level}`)||null;
  function normalize(entry){
    if(!entry||typeof entry!=='object')throw Error('Native status entry required');
    const statusId=integer(entry.statusId,'id',1,0xffff),level=integer(entry.level,'level',1,0xffff);
    const row=catalog(statusId,level);if(!row)throw Error(`Unreviewed native status ${statusId}:${level}`);
    const sourceId=integer(entry.sourceId,'source actor',1),sourceHeroId=integer(entry.sourceHeroId,'source profession',1,0xffff),
      sourceSkinId=integer(entry.sourceSkinId,'source skin',0,0xffff),overlap=integer(entry.overlap,'overlap',1);
    if(overlap>1&&!row.canOverlap)throw Error('Native status does not support overlap');
    const until=entry.until;
    if(until!==Infinity&&(!Number.isFinite(until)||until<0))throw Error('Invalid native status expiry');
    return Object.freeze({statusId,level,sourceId,sourceHeroId,sourceSkinId,overlap,until});
  }
  function encode(entry,now,{operation='add'}={}){
    const targetId=integer(entry?.targetId,'target actor',1),e=normalize(entry);
    if(!Number.isFinite(now)||now<0)throw Error('Invalid native status clock');
    if(!['add','update','remove'].includes(operation))throw Error('Unsupported native status operation');
    if(operation!=='remove'&&e.until<=now)throw Error('Cannot add expired native status');
    const f=(number,value)=>({number,wire:0,value:BigInt(value)});
    const fields=[f(2,e.sourceId),f(3,e.sourceHeroId),f(5,e.statusId),f(6,e.level)];
    if(operation!=='add')fields.push(f(7,operation==='update'?1:3));
    if(operation!=='remove'&&e.until!==Infinity){
      const remainingMs=Math.max(1,Math.round((e.until-now)*1000));
      integer(remainingMs,'remaining time',1);fields.push(f(9,remainingMs));
    }
    fields.push(f(10,e.overlap),f(11,e.sourceSkinId));
    const body=P.encode(fields);if(body.length>255)throw Error('Native status envelope overflow');
    return W.frame(11007,targetId,Buffer.concat([Buffer.from([body.length]),body]));
  }
  function diff(previous,{scope,life,targetId,entries}={},now){
    if(typeof scope!=='string'||!scope||scope.length>256)throw Error('Native status scope required');
    integer(life,'life');integer(targetId,'target actor',1);
    if(!Array.isArray(entries)||!Number.isFinite(now)||now<0)throw Error('Invalid native status snapshot');
    if(previous!==null&&previous!==undefined&&(!previous||previous.version!==1||!Array.isArray(previous.entries)))
      throw Error('Invalid previous native status snapshot');
    const sameScope=previous?.scope===scope;
    if(sameScope&&previous.targetId!==targetId)throw Error('Native status target changed within scope');
    // Native respawn reconstructs actor status state. Never send old-life or
    // old-match removals into a new actor. Resend every currently desired entry.
    const sameLife=sameScope&&previous.life===life;
    const next=new Map();
    for(const input of entries){
      const e=normalize(input);if(e.until<=now)continue;
      if(next.has(key(e)))throw Error('Duplicate native status snapshot entry');
      next.set(key(e),e);
    }
    const old=new Map((sameLife?previous.entries:[]).map(e=>[key(e),normalize(e)]));
    const packets=[],counts={add:0,update:0,remove:0};
    const emit=(entry,operation)=>{packets.push(encode({...entry,targetId},now,{operation}));counts[operation]++;};
    const replaced=(a,b)=>a.sourceId!==b.sourceId||a.level!==b.level||a.sourceHeroId!==b.sourceHeroId||a.sourceSkinId!==b.sourceSkinId||
      (a.until===Infinity)!==(b.until===Infinity);
    for(const [id,e] of old){const after=next.get(id);if(!after||replaced(e,after))emit(e,'remove');}
    for(const [id,e] of next){
      const before=old.get(id);
      if(!before||replaced(before,e))emit(e,'add');
      else if(before.overlap!==e.overlap||before.until!==e.until)emit(e,'update');
    }
    const state=Object.freeze({version:1,scope,life,targetId,entries:Object.freeze([...next.values()])});
    return {packets,state,counts};
  }
  return Object.freeze({catalog,encode,diff});
}
module.exports={create};
