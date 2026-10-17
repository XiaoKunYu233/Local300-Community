'use strict';
// Historical evidence only. A source label, zero deadline or observed worn
// item never authorizes owned.pets, selected state, growth or battle effects.
const crypto=require('node:crypto'),wire=require('./player-pet-wire'),R=require('./roledata');
const verified=new WeakSet(),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const sha=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s),index=n=>Number.isSafeInteger(n)&&n>=0;
const clone=v=>JSON.parse(JSON.stringify(v));
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function identity(account){if(!account||![account.uid,account.playerId].every(n=>Number.isSafeInteger(n)&&n>0&&n<=0xffffffff))throw Error('Pet observation identity mismatch');}
function bytes(base64,digest){
  if(typeof base64!=='string'||!sha(digest))throw Error('Invalid pet observation bytes');
  const out=Buffer.from(base64,'base64');if(out.toString('base64')!==base64||hash(out)!==digest)throw Error('Pet observation integrity mismatch');return out;
}
function roleIdentity(frame){
  if(frame.length<12||frame.readUInt32LE(0)!==frame.length||![1166,1013].includes(frame.readUInt16LE(8)))throw Error('Invalid pet identity frame');
  const role=frame.readUInt16LE(8)===1166?R.inflate(frame.subarray(12)):frame;
  // The actual captured inner1013 declares288540 while carrying288458.
  if(!role||role.length!==288458||role.readUInt16LE(8)!==1013)throw Error('Invalid pet role identity');
  return {uid:role.readUInt32LE(26),playerId:role.readUInt32LE(22),roleSha256:hash(role)};
}
function binding(e){return hash(Buffer.from(JSON.stringify([e.uid,e.playerId,e.sourceSha256,e.identityFrameIndex,e.identityFrameSha256,e.roleSha256,e.frameIndex,e.frameSha256,e.clock?e.clock.frameIndex:null,e.clock?.sha256??null])));}
function content(frame){const d=wire.decode(frame);return d.tag===9035?{kind:'pets',selectedItemId:d.selectedItemId,count:d.count,records:d.records}:{kind:'stones',records:d.records,selectedWord:d.selectedWord};}
function validateEntry(e,account){
  identity(account);if(e?.version!==1||e.uid!==account.uid||e.playerId!==account.playerId)throw Error('Pet observation identity mismatch');
  if(!sha(e.sourceSha256)||!sha(e.bindingSha256)||!index(e.identityFrameIndex)||!index(e.frameIndex)||e.frameIndex<=e.identityFrameIndex)throw Error('Invalid pet observation provenance');
  const role=roleIdentity(bytes(e.identityFrameBase64,e.identityFrameSha256));
  if(role.uid!==e.uid||role.playerId!==e.playerId||role.roleSha256!==e.roleSha256)throw Error('Pet observation role identity mismatch');
  const parsed=content(bytes(e.frameBase64,e.frameSha256));
  if(e.kind!==parsed.kind||JSON.stringify(e.records)!==JSON.stringify(parsed.records)||(e.kind==='pets'?(e.count!==parsed.count||e.selectedItemId!==parsed.selectedItemId):e.selectedWord!==parsed.selectedWord))throw Error('Pet observation fields mismatch');
  if(e.clock===null){if(e.observedAt!==null||e.clockState!=='unknown')throw Error('Pet observation clock mismatch');}
  else{
    if(!e.clock||!index(e.clock.frameIndex)||e.clock.frameIndex<=e.identityFrameIndex||e.clock.frameIndex>=e.frameIndex)throw Error('Invalid pet observation clock provenance');
    const clock=bytes(e.clock.frameBase64,e.clock.sha256);
    if(clock.length!==16||clock.readUInt32LE(0)!==16||clock.readUInt16LE(8)!==11533||e.observedAt!==clock.readUInt32LE(12)*1000||e.clockState!=='observed')throw Error('Pet observation clock mismatch');
  }
  if(binding(e)!==e.bindingSha256)throw Error('Pet observation source binding mismatch');return e;
}
function validate(value,account){
  identity(account);if(value?.version!==1||value.uid!==account.uid||value.playerId!==account.playerId||!Array.isArray(value.entries))throw Error('Pet observation identity mismatch');
  const keys=new Set();for(const e of value.entries){validateEntry(e,account);const key=e.sourceSha256+':'+e.frameIndex;if(keys.has(key))throw Error('Duplicate pet observation');keys.add(key);}return value;
}
// Full original plain lobby bytes prove source membership and preceding role.
// Hash labels in persisted history provide integrity, not outside permission.
function fromCapture(source,{sourceSha256}={}){
  if(!Buffer.isBuffer(source)||!sha(sourceSha256)||hash(source)!==sourceSha256)throw Error('Pet capture source integrity mismatch');
  const frames=R.split(source);if(frames.reduce((n,f)=>n+f.length,0)!==source.length)throw Error('Incomplete pet capture source');
  const entries=[];let role=null,clock=null;
  for(let at=0;at<frames.length;at++){
    const frame=frames[at],tag=frame.readUInt16LE(8);
    if(tag===1166||tag===1013){role={...roleIdentity(frame),identityFrameIndex:at,identityFrameSha256:hash(frame),identityFrameBase64:frame.toString('base64')};identity(role);clock=null;}
    else if(tag===11533&&frame.length===16&&role)clock={frameIndex:at,sha256:hash(frame),frameBase64:frame.toString('base64')};
    if(![9035,9151].includes(tag))continue;
    if(!role)throw Error('Unbound pet capture observation');
    const e={version:1,...role,sourceSha256,frameIndex:at,frameSha256:hash(frame),frameBase64:frame.toString('base64'),clock:clone(clock),observedAt:clock?Buffer.from(clock.frameBase64,'base64').readUInt32LE(12)*1000:null,clockState:clock?'observed':'unknown',...content(frame)};
    e.bindingSha256=binding(e);validateEntry(e,role);freeze(e);verified.add(e);entries.push(e);
  }
  return entries;
}
function observe(account,entry){
  identity(account);if(!entry||!verified.has(entry))throw Error('Pet observation has no verified capture source');validateEntry(entry,account);
  const value=account.petObservations!==undefined?clone(validate(account.petObservations,account)):{version:1,uid:account.uid,playerId:account.playerId,entries:[]};
  const previous=value.entries.find(e=>e.sourceSha256===entry.sourceSha256&&e.frameIndex===entry.frameIndex);
  if(previous){if(JSON.stringify(previous)!==JSON.stringify(entry))throw Error('Conflicting pet source observation');return false;}
  value.entries.push(clone(entry));validate(value,account);account.petObservations=value;return true;
}
function project(value,account){validate(value,account);return value.entries.map(e=>({kind:e.kind,sourceSha256:e.sourceSha256,frameSha256:e.frameSha256,observedAt:e.observedAt,clockState:e.clockState,records:clone(e.records),...(e.kind==='pets'?{observedSelectedItemId:e.selectedItemId,count:e.count,experienceState:'unknown',expirationState:'unknown'}:{observedSelectedWord:e.selectedWord,authorizationState:'unknown'})}));}
module.exports={fromCapture,observe,validate,validateEntry,project};
