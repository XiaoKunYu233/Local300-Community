'use strict';
// Explicit selection uses the proven positive SkinHead item-ID branch and 26
// unconditional Item_Visual defaults. Automatic loss-of-eligibility fallback,
// conditional/special heads and activity-frame entitlements stay unresolved.
const catalog=require('./client-avatar-catalog.json');
const defaultCatalog=require('./client-default-avatar-catalog.json');
const heads=new Map(),conflicts=new Set();
for(const row of catalog.skinHeads){
  const previous=heads.get(row.itemId);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(row))conflicts.add(row.itemId);
  else heads.set(row.itemId,row);
}
const shown=new Set(catalog.heroes.filter(row=>row.show!==0&&row.show!==undefined).map(row=>row.id));
const defaults=new Map(),defaultConflicts=new Set();
for(const row of defaultCatalog.heads){
  const previous=defaults.get(row.itemId);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(row))defaultConflicts.add(row.itemId);
  else defaults.set(row.itemId,row);
}
const uint=value=>Number.isSafeInteger(value)&&value>0&&value<=0xffffffff;
function defaultRow(itemId){
  const row=defaults.get(itemId);
  if(defaultCatalog.version!==1||!row||defaultConflicts.has(itemId)||!Number.isInteger(itemId)||itemId<5500||itemId>5525||row.type!=='summonerpic'||row.sex!==0||row.select!==1||row.condition!==0||typeof row.art!=='string'||!row.art.length)throw Error('Unverified default avatar item');
  return row;
}
const candidateRow=itemId=>defaults.has(itemId)?defaultRow(itemId):skinRow(itemId);
function skinRow(itemId){
  const row=heads.get(itemId);
  if(!row||conflicts.has(itemId)||!row.matched||!uint(row.hero)||!Number.isInteger(row.skin)||row.skin<1||row.skin>31||typeof row.art!=='string'||!row.art.length)throw Error('Unverified skin avatar item');
  return row;
}
// A 1337 mask proves availability but does not establish a skin's lifetime.
// Record this evidence only through an already validated permanent reward.
// Existing imported masks and empty 11563 observations are never backfilled.
function recordPermanentSkin(account,prepared){
  const {reward,catalogItemId,source,now}=prepared;
  if(reward.kind!=='skins'||reward.durationMs||reward.expiresAt!==undefined&&reward.expiresAt!==null)return;
  let row;try{row=skinRow(catalogItemId);}catch{return;}
  if(row.hero!==reward.hero||row.skin!==reward.index||reward.itemId!==row.hero*128+row.skin)throw Error('Permanent skin evidence mismatch');
  const entry=account.owned.skins[reward.itemId];
  entry.permanentProof={version:1,itemId:catalogItemId,source,grantedAt:now};
}
function validateProof(proof,key,entry){
  if(proof?.version!==1||!uint(proof.itemId)||typeof proof.source!=='string'||proof.source!==entry.source||!Number.isSafeInteger(proof.grantedAt)||proof.grantedAt<entry.acquiredAt)throw Error('Invalid permanent skin evidence');
  const row=skinRow(proof.itemId),reward=require('./player-hero-rewards').entitlement(proof.itemId);
  if(+key!==row.hero*128+row.skin||!reward||reward.kind!=='skins'||reward.durationMs||reward.itemId!==+key||reward.hero!==row.hero||reward.index!==row.skin)throw Error('Unverified permanent skin evidence');
  return proof;
}
function validate(value,account){
  if(value?.version!==1||value.uid!==account.uid||value.playerId!==account.playerId||!uint(value.itemId)||!Number.isSafeInteger(value.changedAt)||value.changedAt<0)throw Error('Invalid player avatar state');
  candidateRow(value.itemId);return value;
}
// 9027 is the feature list actually replayed by this lobby. Use the union of
// its disabled skin keys so a later captured list cannot authorize a request
// that another list would disable. Missing policy evidence refuses changes.
function policyFromFrames(frames){
  let known=false;const disabled=new Set();
  for(const frame of frames){
    if(frame.readUInt16LE(8)!==9027)continue;
    if(frame.length<16||frame.readUInt32LE(0)!==frame.length||frame.length!==16+frame.readUInt32LE(12)*4)throw Error('Invalid avatar feature policy');
    known=true;
    for(let at=16;at<frame.length;at+=4){const key=frame.readUInt32LE(at);if(key>=990000000&&key<990100000)disabled.add(key-990000000);}
  }
  return {known,disabled};
}
// Legacy availability is narrower than an arbitrary null expiry. Recheck the
// complete immutable import sources on every use; this is not a permanent
// grant, and the import clock is not the skin's original acquisition time.
function legacyAvailability(account,row,hero,skin,now){
  try{
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),R=require('./roledata'),H=require('./player-heroes');
    const m=account.migration,sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
    const clock=value=>Number.isSafeInteger(value)&&value>=0&&value<=now;
    if(!uint(account.uid)||!uint(account.playerId)||!/^[a-f0-9]{64}$/.test(account.loginHash)||m?.version!==1||
      !clock(m.capturedAt)||!clock(m.importedAt)||hero.acquiredAt!==m.capturedAt||skin.acquiredAt!==m.capturedAt||
      !/^[a-f0-9]{64}$/.test(m.s2cSha256)||!/^[a-f0-9]{64}$/.test(m.c2sSha256)||
      typeof m.s2c!=='string'||typeof m.c2s!=='string'||!path.isAbsolute(m.s2c)||!path.isAbsolute(m.c2s)||
      m.s2c===m.c2s||m.s2c.replace('s2c-','c2s-')!==m.c2s)throw Error('Invalid legacy capture binding');
    const streams={};
    for(const direction of ['c2s','s2c']){
      const stat=fs.statSync(m[direction]);if(!stat.isFile()||stat.size<12||stat.size>64*1024*1024)throw Error('Invalid legacy capture size');
      const bytes=fs.readFileSync(m[direction]);if(bytes.length!==stat.size||sha(bytes)!==m[direction+'Sha256'])throw Error('Legacy capture changed');
      const frames=R.split(bytes);if(!frames.length||frames.reduce((n,f)=>n+f.length,0)!==bytes.length)throw Error('Incomplete legacy capture');
      streams[direction]=frames;
    }
    const login=streams.c2s.find(f=>f.readUInt16LE(8)===20002&&f.length>20&&f[18]===10);
    const enter=streams.c2s.find(f=>f.readUInt16LE(8)===1012&&f.length>=21);
    if(!login||!enter||!login[19]||20+login[19]>login.length||
      require('./player-account-state').loginKey(login.subarray(20,20+login[19]).toString('ascii'))!==account.loginHash||
      enter.readUInt32LE(17)!==account.uid||enter.readUInt32LE(13)!==account.playerId)throw Error('Legacy request identity mismatch');
    for(const f of streams.c2s){
      const tag=f.readUInt16LE(8);
      if(tag===1012&&(f.length<21||f.readUInt32LE(17)!==account.uid||f.readUInt32LE(13)!==account.playerId))throw Error('Mixed legacy roles');
      if(tag===20002&&(f.length<=20||f[18]!==10||!f[19]||20+f[19]>f.length||
        !f.subarray(20,20+f[19]).equals(login.subarray(20,20+login[19]))))throw Error('Mixed legacy logins');
    }
    let verifiedRole=false;
    for(const f of streams.s2c.filter(f=>f.readUInt16LE(8)===1166)){
      const blob=R.inflate(f.subarray(12));if(!blob||blob.length<30||blob.readUInt16LE(8)!==1013)continue;
      if(blob.readUInt32LE(R.UID_OFF)!==account.uid||blob.readUInt32LE(R.PLAYERID_OFF)!==account.playerId)throw Error('Legacy response identity mismatch');
      verifiedRole=true;
    }
    const frame=streams.s2c.find(f=>f.readUInt16LE(8)===1337),capturedClock=streams.s2c.find(f=>f.readUInt16LE(8)===11533&&f.length===16);
    if(!verifiedRole||!frame||!capturedClock||capturedClock.readUInt32LE(12)*1000!==m.capturedAt)throw Error('Missing legacy import observation');
    H.validateWire(account.heroWire);
    const wire=H.decode(frame),record=wire.records[row.hero],source='capture:'+sha(frame);
    if(!record||record!==account.heroWire.records[row.hero]||hero.source!==source||skin.source!==source)throw Error('Legacy ownership source mismatch');
    const raw=Buffer.from(record,'hex');
    if(raw.readUInt32LE(16)!==0||!((raw.readUInt32LE(8)>>>row.skin)&1))throw Error('Legacy avatar was not available');
    return true;
  }catch{throw Error('Legacy avatar availability has not been established');}
}
function eligible(account,itemId,policy,now=Date.now()){
  if(!policy?.known)throw Error('Avatar candidate disabled or policy unverified');
  if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid avatar ownership time');
  // e2488e admits nNeedCondition=0 without a private ownership list. No hero,
  // skin or synthetic owned grant is needed for this exact config branch.
  if(defaults.has(itemId))return defaultRow(itemId);
  const row=skinRow(itemId),hero=account.owned.heroes[row.hero],key=row.hero*128+row.skin,skin=account.owned.skins[key];
  if(!policy?.known||policy.disabled.has(row.hero*100+row.skin)||!shown.has(row.hero))throw Error('Avatar candidate disabled or policy unverified');
  if(!hero||hero.expiresAt!==null||!skin||skin.expiresAt!==null)throw Error('Permanent avatar ownership has not been established');
  if(!Number.isSafeInteger(hero.acquiredAt)||hero.acquiredAt<0||!Number.isSafeInteger(skin.acquiredAt)||skin.acquiredAt<0||hero.acquiredAt>now||skin.acquiredAt>now)throw Error('Invalid avatar ownership time');
  // A present but invalid proof must never fall back to the legacy branch.
  if(skin.permanentProof!==undefined){
    validateProof(skin.permanentProof,key,skin);
    if(skin.permanentProof.grantedAt>now)throw Error('Invalid avatar ownership time');
  }else legacyAvailability(account,row,hero,skin,now);
  return row;
}
function request(frame){
  // XClickSummonerHeadIndex 147fc49..147fc59 initializes stream/flags to 0;
  // reply 27603 has its separate role target and 0xd2 display flags.
  if(!Buffer.isBuffer(frame)||frame.length!==16||frame.readUInt32LE(0)!==16||frame.readUInt32LE(4)!==0||frame.readUInt16LE(8)!==27602||frame.readUInt16LE(10)!==0)throw Error('Invalid avatar selection request');
  return {itemId:frame.readUInt32LE(12)};
}
function apply(account,selection,policy,now=Date.now()){
  eligible(account,selection.itemId,policy,now);
  account.avatarState={version:1,uid:account.uid,playerId:account.playerId,itemId:selection.itemId,changedAt:now};
}
function selected(account,policy,now=Date.now()){
  if(account.avatarState===undefined)return null;
  const state=validate(account.avatarState,account);eligible(account,state.itemId,policy,now);return state.itemId;
}
function reply(account,policy,now=Date.now()){
  // Native fixed-message registry 11583f8/115840c: 0x6bd3 -> 0x14.
  const itemId=selected(account,policy,now);if(itemId===null)return null;
  const body=Buffer.alloc(8);body.writeUInt32LE(account.playerId);body.writeUInt32LE(itemId,4);
  return require('./bag').mkFrame(27603,body,{stream:account.playerId,flags:0xd2});
}
function outbound(account,frame,policy,now=Date.now()){
  if(!account||frame.length!==20||frame.readUInt32LE(0)!==20||frame.readUInt16LE(8)!==27603||frame.readUInt32LE(12)!==account.playerId)return null;
  const itemId=selected(account,policy,now);if(itemId===null)return null;
  const result=Buffer.from(frame);result.writeUInt32LE(itemId,16);return result;
}
// a9802a/a9802f reads the raw positive item ID at full 1013+60.
// Validate identity against this account; do not impose the inflated capture's
// historically inconsistent declared outer length on its decompressed body.
function patchRole(blob,account,policy,now=Date.now()){
  const role=require('./roledata');
  if(!Buffer.isBuffer(blob)||blob.length<64||blob.readUInt16LE(8)!==1013||blob.readUInt32LE(role.UID_OFF)!==account.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==account.playerId)throw Error('Player avatar role identity mismatch');
  const itemId=selected(account,policy,now);if(itemId===null)return blob;
  const result=Buffer.from(blob);result.writeUInt32LE(itemId,60);return result;
}
module.exports={catalog,defaultCatalog,defaultRow,skinRow,recordPermanentSkin,validateProof,validate,policyFromFrames,eligible,request,apply,selected,reply,outbound,patchRole};
