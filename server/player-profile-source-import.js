'use strict';
// Explicit pinned capture observations. This imports no assets or statistics.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const role=require('./roledata'),wire=require('./player-profile-wire');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const hex64=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const uint=value=>Number.isInteger(value)&&value>0&&value<=0xffffffff;
const index=value=>Number.isSafeInteger(value)&&value>=0;
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
const sourceKeys=['version','kind','uid','playerId','loginHash','serverId','events','directions','frame','role','clock','request'];
function validateSource(source,account,snapshot){
  if(!keys(source,sourceKeys)||source.version!==1||source.kind!=='pinned-profile-events'||
    !uint(source.uid)||!uint(source.playerId)||!hex64(source.loginHash)||!uint(source.serverId)||
    source.uid!==account.uid||source.playerId!==account.playerId||source.loginHash!==account.loginHash)
    throw Error('Profile source identity or shape mismatch');
  if(!keys(source.events,['file','sha256','bytes','connection'])||!path.isAbsolute(source.events.file)||
    !hex64(source.events.sha256)||!index(source.events.bytes)||source.events.bytes<1||
    typeof source.events.connection!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(source.events.connection))throw Error('Invalid profile events provenance');
  if(!keys(source.directions,['c2s','s2c']))throw Error('Invalid profile direction provenance');
  for(const direction of ['c2s','s2c']){const row=source.directions[direction];
    if(!keys(row,['sha256','bytes','frames'])||!hex64(row.sha256)||!index(row.bytes)||row.bytes<12||!index(row.frames)||row.frames<1)
      throw Error('Invalid profile complete stream provenance');}
  for(const name of ['frame','role','clock','request']){const row=source[name];
    const fields=['index','eventOrdinal','time','sha256',...(name==='clock'?['observedAt']:[])];
    if(!keys(row,fields)||!index(row.index)||!index(row.eventOrdinal)||!hex64(row.sha256)||
      typeof row.time!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(row.time))throw Error('Invalid profile frame provenance');
    const direction=name==='request'?'c2s':'s2c';if(row.index>=source.directions[direction].frames)throw Error('Profile frame index exceeds source');
    if(name!=='frame'&&row.eventOrdinal>=source.frame.eventOrdinal)throw Error('Profile context must precede response');
  }
  if(!Number.isSafeInteger(source.clock.observedAt)||source.clock.observedAt<0||source.clock.observedAt%1000!==0)
    throw Error('Invalid profile preceding clock');
  if(snapshot){const profile=wire.unpack(Buffer.from(snapshot.frameBase64,'base64'),account);
    if(source.frame.sha256!==snapshot.sha256||source.clock.observedAt!==snapshot.observedAt||profile.serverId!==source.serverId)
      throw Error('Profile observation and source provenance mismatch');}
  return source;
}
function inspectEvents({file,eventsSHA256,connection,c2sSHA256,s2cSHA256,expectedAccount,serverId}={}){
  if(!path.isAbsolute(file||'')||![eventsSHA256,c2sSHA256,s2cSHA256].every(hex64)||
    typeof connection!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(connection)||!uint(serverId)||
    !expectedAccount||!uint(expectedAccount.uid)||!uint(expectedAccount.playerId)||!hex64(expectedAccount.loginHash))throw Error('Explicit profile source and owner confirmation required');
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024*1024||
    fs.realpathSync(file).toLowerCase()!==path.resolve(file).toLowerCase())throw Error('Invalid profile events file boundary');
  const bytes=fs.readFileSync(file);if(hash(bytes)!==eventsSHA256)throw Error('Profile events source SHA mismatch');
  const events=bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const directions=Object.fromEntries(['c2s','s2c'].map(direction=>[direction,{hash:crypto.createHash('sha256'),bytes:0,frames:0}]));
  const parsed=[];
  for(const [eventOrdinal,e]of events.entries()){
    if(e.c!==connection)continue;
    if(!['c2s','s2c'].includes(e.dir)||!index(e.i)||!Number.isInteger(e.msgid)||e.msgid<0||e.msgid>65535||
      !Number.isInteger(e.flags)||e.flags<0||e.flags>65535||!Number.isInteger(e.len)||e.len<12||e.len>16*1024*1024||
      typeof e.hex!=='string'||e.hex.length!==e.len*2||!/^[a-f0-9]+$/i.test(e.hex)||
      typeof e.t!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/.test(e.t))throw Error('Malformed complete profile event');
    const state=directions[e.dir],frame=Buffer.from(e.hex,'hex');
    if(e.i!==state.frames||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==e.msgid||frame.readUInt16LE(10)!==e.flags)
      throw Error('Profile events stream index or frame header mismatch');
    state.hash.update(frame);state.bytes+=frame.length;state.frames++;parsed.push({e,frame,eventOrdinal});
  }
  for(const direction of ['c2s','s2c']){const state=directions[direction],digest=state.hash.digest('hex');
    if(!state.frames||digest!==(direction==='c2s'?c2sSHA256:s2cSHA256))throw Error('Profile complete direction SHA mismatch');
    delete state.hash;state.sha256=digest;}
  let authenticated=false,entered=false,currentRole=null,clock=null,chosen=null;const requests=[];
  const counts={own:0,foreign:0,withoutContext:0};
  const context=row=>({index:row.e.i,eventOrdinal:row.eventOrdinal,time:row.e.t,sha256:hash(row.frame)});
  for(const row of parsed){const {e,frame}=row;
    if(e.dir==='c2s'&&e.msgid===20002){
      if(frame.length<=20||frame[18]!==10||!frame[19]||20+frame[19]>frame.length||
        require('./player-account-state').loginKey(frame.subarray(20,20+frame[19]).toString('ascii'))!==expectedAccount.loginHash)
        throw Error('Profile source login identity mismatch');
      authenticated=true;entered=false;currentRole=null;clock=null;requests.length=0;
    }
    if(e.dir==='c2s'&&e.msgid===1012){
      if(!authenticated||frame.length<21||frame.readUInt32LE(17)!==expectedAccount.uid||frame.readUInt32LE(13)!==expectedAccount.playerId)
        throw Error('Profile source role request identity mismatch');
      entered=true;currentRole=null;clock=null;requests.length=0;
    }
    if(e.dir==='s2c'&&e.msgid===1166){const blob=role.inflate(frame.subarray(12));
      if(blob?.readUInt16LE(8)===1013){
        if(blob.readUInt32LE(role.UID_OFF)!==expectedAccount.uid||blob.readUInt32LE(role.PLAYERID_OFF)!==expectedAccount.playerId)
          throw Error('Mixed profile source role identity');
        if(authenticated&&entered)currentRole=context(row);
      }}
    if(e.dir==='s2c'&&e.msgid===11533){if(frame.length!==16)throw Error('Invalid profile source clock frame');
      if(authenticated&&entered&&currentRole)clock={...context(row),observedAt:frame.readUInt32LE(12)*1000};}
    if(e.dir==='c2s'&&e.msgid===20512){const query=wire.request(frame);
      if(authenticated&&entered&&currentRole)requests.push({...query,context:context(row),consumed:false});}
    if(e.dir==='s2c'&&e.msgid===20513){const profile=wire.unpack(frame);
      if(profile.uid!==expectedAccount.uid||profile.playerId!==expectedAccount.playerId||profile.serverId!==serverId){counts.foreign++;continue;}
      const query=[...requests].reverse().find(request=>!request.consumed&&request.serverId===profile.serverId&&request.playerId===profile.playerId);
      if(!currentRole||!clock||!query){counts.withoutContext++;continue;}query.consumed=true;counts.own++;
      const candidate={version:1,observedAt:clock.observedAt,sha256:hash(frame),frameBase64:frame.toString('base64'),source:{
        version:1,kind:'pinned-profile-events',uid:expectedAccount.uid,playerId:expectedAccount.playerId,loginHash:expectedAccount.loginHash,serverId,
        events:{file:path.resolve(file),sha256:eventsSHA256,bytes:bytes.length,connection},directions:JSON.parse(JSON.stringify(directions)),
        frame:context(row),role:currentRole,clock,request:query.context}};
      validateSource(candidate.source,expectedAccount,candidate);
      if(!chosen||candidate.observedAt>=chosen.observedAt)chosen=candidate;
    }
  }
  if(!chosen)throw Error('No own profile response has a preceding authenticated role, clock and matching server request');
  return {version:1,uid:expectedAccount.uid,playerId:expectedAccount.playerId,loginHash:expectedAccount.loginHash,serverId,snapshot:chosen,counts};
}
function merge(account,prepared){
  if(!prepared||prepared.version!==1||prepared.uid!==account.uid||prepared.playerId!==account.playerId||prepared.loginHash!==account.loginHash||
    prepared.serverId!==prepared.snapshot?.source?.serverId)throw Error('Profile source merge identity mismatch');
  require('./player-profile-snapshot').validate(prepared.snapshot,account);
  if(account.profileSnapshot){const existing=account.profileSnapshot;require('./player-profile-snapshot').validate(existing,account);
    if(existing.observedAt>prepared.snapshot.observedAt)return false;
    if(existing.observedAt===prepared.snapshot.observedAt){
      if(existing.sha256!==prepared.snapshot.sha256)throw Error('Conflicting profile observations share the same server clock');
      if(existing.source)return false;
    }}
  const frame=Buffer.from(prepared.snapshot.frameBase64,'base64');
  if(!require('./player-profile-snapshot').observe(account,frame,prepared.snapshot.observedAt))throw Error('Profile source observer refused owner');
  account.profileSnapshot.source=JSON.parse(JSON.stringify(prepared.snapshot.source));return true;
}
module.exports={inspectEvents,merge,validateSource};
