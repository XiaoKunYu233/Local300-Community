'use strict';
const crypto=require('node:crypto'),PB=require('../battle-protobuf');
// The native client binds the password digest to greeting field 1. The public
// local greeting deliberately retains challenge 1; plain MD5 is not its wire
// credential. Confirmed against the native producer and two actual logins.
function passwordDigest(password,challenge=1){
  if(typeof password!=='string'||!Number.isSafeInteger(challenge)||challenge<0)throw Error('Invalid native password input');
  const first=crypto.createHash('md5').update(password,'utf8').digest('hex');
  return challenge===0?first:crypto.createHash('md5').update(first+String(challenge),'ascii').digest('hex');
}
const password=passwordDigest('admin');
const WORLD_IDS=Object.freeze([20034,20032]);
function worldId(frame){
  if(!Buffer.isBuffer(frame)||frame.length<18||frame.readUInt32LE()!==frame.length||frame.readUInt16LE(8)!==20002||frame.readUInt16LE(16)!==2)throw Error('Invalid native login envelope');
  const fields=PB.decode(frame.subarray(18)).filter(field=>field.number===6);
  if(fields.length!==1||fields[0].wire!==0||!WORLD_IDS.some(id=>fields[0].value===BigInt(id)))throw Error('Unsupported local test world');
  return Number(fields[0].value);
}
function verify(frame){
  try{const fields=PB.decode(frame.subarray(18)),names=fields.filter(f=>f.number===1&&f.wire===2),secrets=fields.filter(f=>f.number===2&&f.wire===2);
    return names.length===1&&secrets.length===1&&names[0].bytes.toString('ascii').toLowerCase()==='admin'&&secrets[0].bytes.length===32&&crypto.timingSafeEqual(secrets[0].bytes,Buffer.from(password));
  }catch{return false;}
}
module.exports={verify,passwordDigest,worldId,WORLD_IDS};
