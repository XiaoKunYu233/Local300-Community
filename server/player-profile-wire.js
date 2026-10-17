'use strict';
// XGamePlayerInfoIsOpen 1487100 emits 20512 (20 bytes).
// Captured 20513: server u32 at +12, role u32 at +16, protobuf length +20.
// Protobuf identity 1=UID, 2=server, 3=role, 4=GBK name. Remaining fields
// stay opaque until native field-to-UI mappings have been established.
const P=require('./battle-protobuf');
function request(frame){
  // Native148710f/1487117 initializes stream0 and tag20512/flags0.
  if(!Buffer.isBuffer(frame)||frame.length!==20||frame.readUInt32LE(0)!==20||frame.readUInt32LE(4)!==0||
    frame.readUInt16LE(8)!==20512||frame.readUInt16LE(10)!==0)throw Error('Invalid player profile request');
  return {serverId:frame.readUInt32LE(12),playerId:frame.readUInt32LE(16)};
}
function unpack(frame,expected){
  if(!Buffer.isBuffer(frame)||frame.length<24||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==20513||frame.readUInt32LE(20)!==frame.length-24)throw Error('Invalid player profile response');
  const fields=P.decode(frame.subarray(24));
  for(const number of [1,2,3,4]){
    const rows=fields.filter(f=>f.number===number);if(rows.length!==1||rows[0].wire!==(number===4?2:0))throw Error('Invalid player profile identity fields');
  }
  const uid=P.get(fields,1),serverId=P.get(fields,2),playerId=P.get(fields,3),nameBytes=fields.find(f=>f.number===4).bytes;
  if(!Number.isInteger(uid)||uid<1||uid>0xffffffff||!Number.isInteger(playerId)||playerId<1||playerId>0xffffffff||serverId!==frame.readUInt32LE(12)||playerId!==frame.readUInt32LE(16)||nameBytes.length>15||nameBytes.includes(0))throw Error('Player profile identity mismatch');
  if(expected&&(uid!==expected.uid||playerId!==expected.playerId))throw Error('Player profile belongs to another account');
  return {uid,serverId,playerId,nameBytes:Buffer.from(nameBytes),header:Buffer.from(frame.subarray(0,24)),fields};
}
function pack(profile){
  const bytes=P.encode(profile.fields),header=Buffer.from(profile.header);
  if(header.length!==24)throw Error('Invalid profile header');header.writeUInt32LE(24+bytes.length);header.writeUInt32LE(bytes.length,20);
  const frame=Buffer.concat([header,bytes]);unpack(frame,{uid:profile.uid,playerId:profile.playerId});return frame;
}
module.exports={request,unpack,pack};
