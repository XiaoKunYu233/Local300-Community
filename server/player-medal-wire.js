'use strict';
const P=require('./battle-protobuf');
// Pure structural codec. It neither establishes identity/ownership nor grants
// medals. Record field 3 is timeout in embedded Share.proto; a zero/absent
// timeout does not prove permanent entitlement. Other fields remain opaque.
function fieldsOf(bytes){
  const fields=P.decode(bytes);let offset=0;
  const read=()=>{let value=0n;for(let i=0;i<10;i++){const byte=bytes[offset++];value|=BigInt(byte&127)<<BigInt(i*7);if(!(byte&128))return value;}throw Error('Invalid protobuf varint');};
  for(const field of fields){
    const start=offset;read();
    if(field.wire===0)read();
    else {const length=field.wire===1?8:field.wire===5?4:Number(read());offset+=length;}
    field.raw=Buffer.from(bytes.subarray(start,offset));
  }
  return fields;
}
function scalar(fields,number,{required=false,nonzero=false,max=0xffffffff}={}){
  const matches=fields.filter(field=>field.number===number);
  if(!matches.length){if(required)throw Error('Missing medal scalar');return undefined;}
  if(matches.length!==1||matches[0].wire!==0||matches[0].value<0n||matches[0].value>BigInt(max)||(nonzero&&matches[0].value===0n))throw Error('Invalid medal scalar');
  return Number(matches[0].value);
}
function repeatedIds(fields,number){
  const matches=fields.filter(field=>field.number===number);
  if(matches.length>4||matches.some(field=>field.wire!==0||field.value<1n||field.value>0xffffffffn))throw Error('Invalid medal equipment list');
  return matches.map(field=>Number(field.value));
}
function nested(fields,number){
  const matches=fields.filter(field=>field.number===number);
  if(!matches.length)return null;
  if(matches.length!==1||matches[0].wire!==2)throw Error('Invalid medal message branch');
  const children=fieldsOf(matches[0].bytes);matches[0].children=children;return children;
}
function ownedRecord(field){
  if(field.wire!==2)throw Error('Invalid medal ownership record');
  const fields=fieldsOf(field.bytes);field.children=fields;
  const id=scalar(fields,1,{required:true,nonzero:true}),fresh=scalar(fields,2,{max:1}),timeout=scalar(fields,3);
  return {id,...(fresh===undefined?{}:{new:fresh===1}),...(timeout===undefined?{}:{timeout}),unknownFields:fields.filter(item=>![1,2,3].includes(item.number)),fields};
}
function infoOf(fields){
  // Embedded Share.proto descriptor: SysXunZhang field 2 is repeated equips.
  const ownedRecords=fields.filter(field=>field.number===1).map(ownedRecord),equippedIds=repeatedIds(fields,2);
  return {ownedRecords,equippedIds,hasDuplicateOwnedIds:new Set(ownedRecords.map(record=>record.id)).size!==ownedRecords.length,
    hasDuplicateEquippedIds:new Set(equippedIds).size!==equippedIds.length,unknownFields:fields.filter(field=>![1,2].includes(field.number)),fields};
}
function branchOf(fields){
  const operation=scalar(fields,1,{required:true,max:3});if(operation<1)throw Error('Invalid medal operation');
  const viewMedalId=scalar(fields,3),equippedIds=repeatedIds(fields,4),infoFields=nested(fields,2);
  return {operation,...(viewMedalId===undefined?{}:{viewMedalId}),equippedIds,hasDuplicateEquippedIds:new Set(equippedIds).size!==equippedIds.length,
    info:infoFields?infoOf(infoFields):null,unknownFields:fields.filter(field=>![1,2,3,4].includes(field.number)),fields};
}
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==11888)throw Error('Invalid medal frame');
  const fields=fieldsOf(frame.subarray(12)),branch=nested(fields,14);
  return {header:Buffer.from(frame.subarray(0,12)),fields,medal:branch?branchOf(branch):null};
}
function request(frame){
  const model=decode(frame),branch=model.medal;
  if(!branch)throw Error('Missing medal request branch');
  if(branch.info||(branch.operation!==2&&branch.viewMedalId!==undefined)||(branch.operation!==3&&branch.equippedIds.length)||(branch.operation===2&&branch.viewMedalId===undefined))throw Error('Invalid medal request fields');
  // Duplicate IDs are reported, not adjudicated: the authoritative business
  // rule is still pending. Lua passes SetData_XunZhangInfo's medal config ID
  // to XReqViewXunZhang; viewMedalId must not be treated as an account key.
  return branch;
}
function encodeFields(fields){
  if(!Array.isArray(fields))throw Error('Invalid medal field tree');
  return Buffer.concat(fields.map(field=>{
    const current={...field,...(field.children?{bytes:encodeFields(field.children)}:{})};
    const canonical=P.encode([current]);
    if(Buffer.isBuffer(field.raw)){
      const original=P.decode(field.raw);
      if(original.length===1&&original[0].number===current.number&&original[0].wire===current.wire&&
        (current.wire===0?original[0].value===current.value:Buffer.isBuffer(current.bytes)&&original[0].bytes.equals(current.bytes)))return Buffer.from(field.raw);
    }
    return canonical;
  }));
}
// Edit the field tree when exercising a structural variant. The derived
// medal/record values are read views; field-tree children retain raw unknown
// bytes and field order, including valid noncanonical varint spellings.
function encode(model){
  if(!Buffer.isBuffer(model?.header)||model.header.length!==12||model.header.readUInt16LE(8)!==11888)throw Error('Invalid medal frame header');
  const header=Buffer.from(model.header),payload=encodeFields(model.fields);header.writeUInt32LE(12+payload.length);
  const frame=Buffer.concat([header,payload]);decode(frame);return frame;
}
module.exports={decode,encode,request};
