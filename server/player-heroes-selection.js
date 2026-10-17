'use strict';
// Native 27008: e6ec04 -> e6fb16 -> e72be0. e72fac reads u16
// count at +30; e73523/e735fb walk +32 in 21-byte records (max 500).
// This is a match candidate list, not an account ownership grant (1337).
const {owns}=require('./player-account-state');
const TAG=27008,HEADER_BYTES=32,RECORD_BYTES=21,MAX_RECORDS=500;
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<HEADER_BYTES||frame.readUInt32LE(0)!==frame.length||
    frame.readUInt16LE(8)!==TAG||frame.readUInt32LE(4)!==0||frame.readUInt16LE(10)!==0)
    throw Error('Invalid native hero candidate frame');
  const count=frame.readUInt16LE(30);
  if(count>MAX_RECORDS||frame.length!==HEADER_BYTES+count*RECORD_BYTES)
    throw Error('Invalid native hero candidate length');
  const rows=[],seen=new Set();
  for(let index=0;index<count;index++){
    const record=Buffer.from(frame.subarray(HEADER_BYTES+index*RECORD_BYTES,HEADER_BYTES+(index+1)*RECORD_BYTES));
    const heroId=record.readUInt16LE(0);
    if(heroId<1||heroId===65535||seen.has(heroId))throw Error('Invalid or duplicate native hero candidate');
    seen.add(heroId);rows.push({heroId,record});
  }
  return {header:Buffer.from(frame.subarray(0,HEADER_BYTES)),rows};
}
function pack(decoded){
  if(!decoded||!Buffer.isBuffer(decoded.header)||decoded.header.length!==HEADER_BYTES||!Array.isArray(decoded.rows)||decoded.rows.length>MAX_RECORDS)
    throw Error('Invalid native hero candidate data');
  const header=Buffer.from(decoded.header);header.writeUInt16LE(decoded.rows.length,30);header.writeUInt32LE(HEADER_BYTES+decoded.rows.length*RECORD_BYTES,0);
  const frame=Buffer.concat([header,...decoded.rows.map(row=>{
    if(!row||!Buffer.isBuffer(row.record)||row.record.length!==RECORD_BYTES||row.record.readUInt16LE(0)!==row.heroId)
      throw Error('Invalid native hero candidate record');
    return row.record;
  })]);
  decode(frame);return frame;
}
function project(account,frame,supportedHeroIds,now=Date.now()){
  if(!account||!Number.isInteger(account.uid)||account.uid<1||account.uid>0xffffffff||
    !Number.isInteger(account.playerId)||account.playerId<1||account.playerId>0xffffffff||
    !account.owned?.heroes||!Number.isSafeInteger(now)||now<0)
    throw Error('Verified hero candidate account and time required');
  if(!Array.isArray(supportedHeroIds)||supportedHeroIds.some(id=>!Number.isInteger(id)||id<1||id>=65535)||
    new Set(supportedHeroIds).size!==supportedHeroIds.length)
    throw Error('Explicit supported hero candidates required');
  const decoded=decode(frame),supported=new Set(supportedHeroIds);
  decoded.rows=decoded.rows.filter(row=>supported.has(row.heroId)&&owns(account,'heroes',row.heroId,now));
  // Copy only complete observed rows; do not invent missing candidates, flags,
  // display names, skills, map IDs, masks or entitlements. The authenticated
  // battle ticket/availability gate belongs to the caller before transmission.
  return pack(decoded);
}
module.exports={TAG,HEADER_BYTES,RECORD_BYTES,MAX_RECORDS,decode,pack,project};
