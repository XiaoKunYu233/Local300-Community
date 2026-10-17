'use strict';
// Only the exact public connect greetings observed in explicit account sources.
// No login, role, entitlement or other private frame is copied into this API.
const crypto=require('node:crypto');
const ORIGINAL_SHA='e378aac48b7218e01dc67421c86ae6f6aa346e062a7c22bba3da3d4cba6a83b6';
const CURRENT_SHA='7feab73e2e2e973b00da23eb39738d50ae11cfec3080bd576e43bac7db24b269';
const MAX_SOURCE=64*1024*1024,MAX_FRAME=16*1024*1024,verified=new WeakMap();
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function matches(frame){
  if(!Buffer.isBuffer(frame)||frame.length!==23||frame.readUInt32LE(0)!==23||frame.readUInt16LE(8)!==20002||frame.readUInt32LE(4)!==0||frame.readUInt16LE(10)!==0)return false;
  const sha=hash(frame);return sha===ORIGINAL_SHA||sha===CURRENT_SHA;
}
function currentFrame(frame){
  if(!matches(frame))throw Error('Unknown public connect greeting');
  const current=Buffer.from(frame);
  // Existing liveserver 8824 compatibility: old 10 f7 44 -> current10 f8 44.
  if(hash(frame)===ORIGINAL_SHA)current[21]=0xf8;
  if(hash(current)!==CURRENT_SHA)throw Error('Unknown current public connect greeting');return current;
}
function fromCapture(source,{sourceSha256}={}){
  if(!Buffer.isBuffer(source)||source.length<23||source.length>MAX_SOURCE||!/^\p{ASCII_Hex_Digit}{64}$/u.test(sourceSha256||'')||sourceSha256!==sourceSha256.toLowerCase()||hash(source)!==sourceSha256)throw Error('Public greeting source SHA mismatch');
  // Verify that this is a complete plain source, not a sliced/search-hit frame.
  // Only the first23 bytes are retained; later private frames are never stored.
  let offset=0,frames=0;
  while(offset<source.length){
    if(offset+12>source.length)throw Error('Incomplete public greeting source');
    const size=source.readUInt32LE(offset);if(size<12||size>MAX_FRAME||offset+size>source.length)throw Error('Incomplete public greeting source');
    offset+=size;if(++frames>1000000)throw Error('Public greeting source frame limit');
  }
  const first=source.subarray(0,source.readUInt32LE(0)),current=currentFrame(first);
  const evidence=Object.freeze({version:1,sourceSha256,sourceFrameCount:frames,frameSha256:hash(first),currentFrameSha256:hash(current),currentBodySha256:hash(current.subarray(12))});
  verified.set(evidence,current);return evidence;
}
function publicFrame(observations){
  if(!Array.isArray(observations)||!observations.length)throw Error('Explicit account greeting observations required');
  let common;
  for(const observation of observations){
    const frame=verified.get(observation);if(!frame)throw Error('Verified account greeting observation required');
    if(common&&!frame.equals(common))throw Error('Account public greetings differ');common=frame;
  }
  return Buffer.from(common);
}
module.exports={fromCapture,publicFrame,matches};
