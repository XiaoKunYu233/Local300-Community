'use strict';
const P=require('./battle-protobuf');
// bda813 dispatch: 11888 -> bdc1cd -> bc81f0. 1073480 serializes
// outer field 11, 10747e0 its field 1, 108d900 score=1, experience=3.
// This payload does not establish an account identity by itself.
function nested(fields,number){
  const rows=fields.filter(f=>f.number===number);
  if(!rows.length)return null;
  if(rows.length!==1||rows[0].wire!==2)throw Error('Invalid credit message branch');
  return P.decode(rows[0].bytes);
}
function decode(frame){
  if(!Buffer.isBuffer(frame)||frame.length<12||frame.readUInt32LE(0)!==frame.length||frame.readUInt16LE(8)!==11888)throw Error('Invalid credit frame');
  const envelope=nested(P.decode(frame.subarray(12)),11);if(!envelope)return null;
  const fields=nested(envelope,1);if(!fields)return null;
  const result={};
  for(const [number,key]of [[1,'score'],[3,'experience']]){
    const rows=fields.filter(f=>f.number===number);
    // Native generated protobuf defaults absent scalar members to zero.
    if(!rows.length){result[key]=0;continue;}
    if(rows.length!==1||rows[0].wire!==0||rows[0].value<0n||rows[0].value>0x7fffffffn)throw Error('Invalid credit value');
    result[key]=Number(rows[0].value);
  }
  return result;
}
function replaceObservation(frame,savedFrame){
  if(!decode(frame))return frame;
  const fields=P.decode(frame.subarray(12)),envelope=nested(fields,11);
  let saved=null;
  if(savedFrame){
    if(!decode(savedFrame))throw Error('Missing saved credit branch');
    saved=nested(P.decode(savedFrame.subarray(12)),11).find(f=>f.number===1);
  }
  const inner=envelope.flatMap(f=>f.number===1?(saved?[saved]:[]):[f]);
  const outer=fields.flatMap(f=>f.number===11?(inner.length?[{...f,bytes:P.encode(inner)}]:[]):[f]);
  if(!outer.length)return null;
  const header=Buffer.from(frame.subarray(0,12)),payload=P.encode(outer);header.writeUInt32LE(12+payload.length);
  return Buffer.concat([header,payload]);
}
module.exports={decode,replaceObservation};
