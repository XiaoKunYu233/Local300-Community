'use strict';
const GBK=require('./gbk');
// The 14 populated actors have identical row indices across these four
// 40*30 tables in native match 002. 23444's 0x92 stride is also established
// by client 65d770/65d868. Do not scan arbitrary payload words for actor IDs.
const tables=new Map([
  [23435,{length:67222,start:20,stride:56,name:8}],
  [23505,{length:9616,start:16,stride:8}],
  [23444,{length:175292,start:27,stride:146,name:-15,uid:4}],
  [23560,{length:31212,start:12,stride:26}],
]);
function nameBytes(name){
  if(typeof name!=='string'||!name||name.includes('\0'))throw Error('Invalid battle name');
  const bytes=GBK.encode(name);if(bytes.length>14||GBK.decode(bytes)!==name)throw Error('Battle name exceeds native GBK field');return bytes;
}
function row(frame,actor){
  const schema=tables.get(frame.readUInt16LE(8));if(!schema)return null;
  if(frame.length!==schema.length)throw Error('Unsupported battle identity table');
  const offsets=[];for(let i=0;i<1200;i++){const offset=schema.start+i*schema.stride;if(frame.readUInt32LE(offset)===actor)offsets.push({index:i,offset});}
  if(offsets.length>1)throw Error('Duplicate actor in battle identity table');
  return offsets.length?{...offsets[0],...schema}:null;
}
function patch(frame,sourceId,account){
  if(!account)return Buffer.from(frame);
  const bytes=nameBytes(account.name),out=Buffer.from(frame),tag=out.readUInt16LE(8),record=row(out,sourceId);
  if(out.readUInt32LE(4)===sourceId)out.writeUInt32LE(account.playerId,4);
  const direct=new Map([[18606,12],[9101,12],[23439,12],[23437,12],[1330,13],[1331,12],[13535,12],[11048,12],[1104,12]]);
  const at=direct.get(tag);if(at!==undefined&&out.length>=at+4&&out.readUInt32LE(at)===sourceId)out.writeUInt32LE(account.playerId,at);
  if(tag===1466){
    if(out.length!==1356)throw Error('Unsupported battle actor vector');
    for(let at=12;at<out.length;at+=4)if(out.readUInt32LE(at)===sourceId)out.writeUInt32LE(account.playerId,at);
  }
  // In all eight affected remote-hero templates in native match 002 these
  // two fields reference the local viewer, independent of the remote actor
  // and variable name/tail lengths. Preserve all other attached state bytes.
  if([1050,1052].includes(tag)){
    const spawn=require('./battle-protocol').readSpawn(out);
    if(spawn?.kind==='hero')for(const delta of [4580,4588]){
      const at=12+spawn.offset+delta;
      if(at+4<=out.length&&out.readUInt32LE(at)===sourceId)out.writeUInt32LE(account.playerId,at);
    }
  }
  if(record){
    if(account.playerId!==sourceId&&row(out,account.playerId))throw Error('Battle identity collides with an existing participant');
    out.writeUInt32LE(account.playerId,record.offset);
    if(record.uid!==undefined)out.writeUInt32LE(account.uid,record.offset+record.uid);
    if(record.name!==undefined){const start=record.offset+record.name;out.fill(0,start,start+15);bytes.copy(out,start);}
  }
  if(tag===23512&&out.length>=25&&out.readUInt32LE(12)===sourceId){
    // c527 registry 1156c12 and all three captures: fixed 39-byte message,
    // including short names. Preserve the full native 15-byte name field.
    if(out.length!==39||out[38]!==0)throw Error('Unsupported battle identity name layout');
    out.fill(0,24,39);bytes.copy(out,24);out.writeUInt32LE(account.playerId,12);return out;
  }
  if([1050,1052].includes(tag)&&frame.readUInt32LE(4)===sourceId){
    const spawn=require('./battle-protocol').readSpawn(out);
    if(spawn?.kind==='hero'){
      const prefix=Buffer.from(out.subarray(12,16));prefix.writeUInt16LE(bytes.length+1,2);
      return require('./battle-wire').frame(tag,account.playerId,Buffer.concat([prefix,bytes,Buffer.alloc(1),out.subarray(12+spawn.offset)]),out.readUInt16LE(10));
    }
  }
  return out;
}
module.exports={patch,row,nameBytes};
