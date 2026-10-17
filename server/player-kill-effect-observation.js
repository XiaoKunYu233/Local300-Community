'use strict';
// Historical evidence only. Unknown words and missing clocks never become
// permanent owned.killEffects, selected state, expiry or battle authorization.
const crypto=require('node:crypto'),wire=require('./player-kill-effect-wire'),R=require('./roledata');
const verified=new WeakSet(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),index=n=>Number.isSafeInteger(n)&&n>=0;
const clone=v=>JSON.parse(JSON.stringify(v));
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function identity(account){if(!account||![account.uid,account.playerId].every(n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff))throw Error('Kill effect observation identity mismatch');}
function bytes(base64,digest){
  if(typeof base64!=='string'||!sha(digest))throw Error('Invalid kill effect observation bytes');
  const out=Buffer.from(base64,'base64');if(out.toString('base64')!==base64||hash(out)!==digest)throw Error('Kill effect observation integrity mismatch');return out;
}
function roleIdentity(frame){
  if(frame.length<12||frame.readUInt32LE(0)!==frame.length||![1166,1013].includes(frame.readUInt16LE(8)))throw Error('Invalid kill effect identity frame');
  const role=frame.readUInt16LE(8)===1166?R.inflate(frame.subarray(12)):frame;
  // Captured inner 1013 intentionally declares 288540 while carrying 288458.
  if(!role||role.length!==288458||role.readUInt16LE(8)!==1013)throw Error('Invalid kill effect role identity');
  return {uid:role.readUInt32LE(26),playerId:role.readUInt32LE(22),roleSha256:hash(role)};
}
function binding(e){return hash(Buffer.from(JSON.stringify([e.uid,e.playerId,e.sourceSha256,e.identityFrameIndex,e.identityFrameSha256,e.roleSha256,e.frameIndex,e.frameSha256,e.clock?e.clock.frameIndex:null,e.clock?.sha256??null])));}
function content(frame){const d=wire.decode(frame);if(d.tag===9018)throw Error('A kill effect request is not an observation');return d.tag===9020?{kind:'owned',count:d.count,records:d.records}:{kind:'selection',itemId:d.itemId,removed:d.removed};}
function validateEntry(e,account){
  identity(account);if(e?.version!==1||e.uid!==account.uid||e.playerId!==account.playerId)throw Error('Kill effect observation identity mismatch');
  if(!sha(e.sourceSha256)||!sha(e.bindingSha256)||!index(e.identityFrameIndex)||!index(e.frameIndex)||e.frameIndex<=e.identityFrameIndex)throw Error('Invalid kill effect observation provenance');
  const role=roleIdentity(bytes(e.identityFrameBase64,e.identityFrameSha256));
  if(role.uid!==e.uid||role.playerId!==e.playerId||role.roleSha256!==e.roleSha256)throw Error('Kill effect observation role identity mismatch');
  const parsed=content(bytes(e.frameBase64,e.frameSha256));
  if(e.kind!==parsed.kind||(e.kind==='owned'?(e.count!==parsed.count||JSON.stringify(e.records)!==JSON.stringify(parsed.records)):(e.itemId!==parsed.itemId||e.removed!==parsed.removed)))throw Error('Kill effect observation fields mismatch');
  if(e.clock===null){if(e.observedAt!==null||e.clockState!=='unknown')throw Error('Kill effect observation clock mismatch');}
  else{
    if(!e.clock||!index(e.clock.frameIndex)||e.clock.frameIndex<=e.identityFrameIndex||e.clock.frameIndex>=e.frameIndex)throw Error('Invalid kill effect observation clock provenance');
    const clock=bytes(e.clock.frameBase64,e.clock.sha256);
    if(clock.length!==16||clock.readUInt32LE(0)!==16||clock.readUInt16LE(8)!==11533||e.observedAt!==clock.readUInt32LE(12)*1000||e.clockState!=='observed')throw Error('Kill effect observation clock mismatch');
  }
  if(binding(e)!==e.bindingSha256)throw Error('Kill effect observation source binding mismatch');return e;
}
function validate(value,account){
  identity(account);if(value?.version!==1||value.uid!==account.uid||value.playerId!==account.playerId||!Array.isArray(value.entries))throw Error('Kill effect observation identity mismatch');
  const keys=new Set();for(const e of value.entries){validateEntry(e,account);const key=e.sourceSha256+':'+e.frameIndex;if(keys.has(key))throw Error('Duplicate kill effect observation');keys.add(key);}
  return value;
}
// The full original plain lobby source establishes frame membership and the
// immediately preceding role. This factory is the only write-entry authority;
// arbitrary caller-supplied hashes/UIDs are not a verified capture binding.
function fromCapture(source,{sourceSha256}={}){
  if(!Buffer.isBuffer(source)||!sha(sourceSha256)||hash(source)!==sourceSha256)throw Error('Kill effect capture source integrity mismatch');
  const frames=R.split(source);if(frames.reduce((n,f)=>n+f.length,0)!==source.length)throw Error('Incomplete kill effect capture source');
  const entries=[];let role=null,clock=null;
  for(let at=0;at<frames.length;at++){
    const frame=frames[at],tag=frame.readUInt16LE(8);
    if(tag===1166||tag===1013){role={...roleIdentity(frame),identityFrameIndex:at,identityFrameSha256:hash(frame),identityFrameBase64:frame.toString('base64')};identity(role);clock=null;}
    else if(tag===11533&&frame.length===16&&role)clock={frameIndex:at,sha256:hash(frame),frameBase64:frame.toString('base64')};
    if(![9019,9020].includes(tag))continue;
    const category=frame.length>=20?frame.readUInt32LE(tag===9019?16:12):null;if(category!==wire.CATEGORY)continue;
    if(!role)throw Error('Unbound kill effect capture observation');
    const e={version:1,...role,sourceSha256,frameIndex:at,frameSha256:hash(frame),frameBase64:frame.toString('base64'),clock:clone(clock),observedAt:clock?Buffer.from(clock.frameBase64,'base64').readUInt32LE(12)*1000:null,clockState:clock?'observed':'unknown',...content(frame)};
    e.bindingSha256=binding(e);validateEntry(e,role);freeze(e);verified.add(e);entries.push(e);
  }
  return entries;
}
function observe(account,entry){
  identity(account);if(!entry||!verified.has(entry))throw Error('Kill effect observation has no verified capture source');validateEntry(entry,account);
  const value=account.killEffectObservations?clone(validate(account.killEffectObservations,account)):{version:1,uid:account.uid,playerId:account.playerId,entries:[]};
  const previous=value.entries.find(e=>e.sourceSha256===entry.sourceSha256&&e.frameIndex===entry.frameIndex);
  if(previous){if(JSON.stringify(previous)!==JSON.stringify(entry))throw Error('Conflicting kill effect source observation');return false;}
  value.entries.push(clone(entry));validate(value,account);account.killEffectObservations=value;return true;
}
function project(value,account){validate(value,account);return value.entries.map(e=>({kind:e.kind,sourceSha256:e.sourceSha256,frameSha256:e.frameSha256,observedAt:e.observedAt,clockState:e.clockState,...(e.kind==='owned'?{records:e.records.slice(0,e.count).map(r=>({...r,expirationState:'unknown'}))}:{observedItemId:e.itemId,removed:e.removed})}));}
module.exports={fromCapture,observe,validate,validateEntry,project};
