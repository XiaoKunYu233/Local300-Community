'use strict';
// 13590 clears the native global graph vector. Rebuild it immediately from
// this worker's committed account state, through the normal outbound queue.
const P=require('./battle-protobuf'),protocol=require('./progression-protocol'),{mkFrame}=require('./bag');
const canonicalGraphs=new Set(require('./client-magic-config/magicgemmagicaldevice.json').map(row=>Number(row[1])).filter(Number.isInteger));
const branches=new Map([[1,[1]],[2,[1,2]],[3,[1]],[4,[1,2,3]],[5,[1,2,3]],[6,[1,2]],[15,[1,2]],[16,[1,2]]]);
function magicReply(frame){
 try{
  if(!Buffer.isBuffer(frame)||frame.length<14||frame.readUInt32LE()!==frame.length||frame.readUInt16LE(8)!==11888)return false;
  const wrapped=P.decode(frame.subarray(12)).filter(f=>f.number===10&&f.wire===2);
  if(!wrapped.length)return false;for(const field of wrapped)P.decode(field.bytes);return true;
 }catch{return false;}
}
function validRequest(frame){
 try{
  // Complete native sources use both 1 and 7853 at header +4. Keep this
  // undocumented uint32 opaque: account and body ownership authorize requests.
  // The native PB packet constructor also leaves header +10 unset. Observed
  // query flags=0 do not establish a zero-only rule for SetGraph. Keep flags
  // opaque; strict body shape and authenticated ownership still authorize it.
  if(!Buffer.isBuffer(frame)||frame.length<14||frame.length>4096||frame.readUInt32LE()!==frame.length||frame.readUInt16LE(8)!==11888)return false;
  const outer=P.decode(frame.subarray(12));if(outer.length!==1||outer[0].number!==10||outer[0].wire!==2)return false;
  const inner=P.decode(outer[0].bytes);if(inner.length!==1)return false;const branch=inner[0];
  if(branch.number===7)return branch.wire===0&&[0n,1n].includes(branch.value);
  const allowed=branches.get(branch.number);if(!allowed||branch.wire!==2)return false;
  const fields=P.decode(branch.bytes);
   if(branch.number===6){
    // The fixed native SetGraph sender sets both GUID and graph has-bits.
    // An omitted graph must never become an accidental request to clear it.
    if(fields.length!==2||fields.some(f=>f.wire!==0)||fields.filter(f=>f.number===1).length!==1||fields.filter(f=>f.number===2).length!==1)return false;
    const device=fields.find(f=>f.number===1).value,graph=fields.find(f=>f.number===2).value;
    // Preserve explicit clearing (0); native graph ids come from the catalog.
    // Local model aliases such as 1 must not bypass an unopened graph.
    return device>0n&&device<=0xffffffffffffffffn&&graph>=0n&&graph<=0xffffffffn&&(graph===0n||canonicalGraphs.has(Number(graph)));
   }
   return fields.length>0&&fields.every(f=>allowed.includes(f.number)&&(f.wire===0||(branch.number===4&&f.number===2&&f.wire===2)))&&fields.filter(f=>f.number!==2||branch.number!==4).every((f,i,a)=>a.findIndex(x=>x.number===f.number)===i);
 }catch{return false;}
}
function afterNotify(state,frame,{authenticated=false,frozen=true,role=0}={}){
 if(authenticated!==true||frozen!==false||!Number.isSafeInteger(role)||role<=0||role>0xffffffff||!Buffer.isBuffer(frame)||frame.length<16||frame.readUInt32LE()!==frame.length||frame.readUInt16LE(8)!==13590||frame.readUInt32LE(4)!==role||frame.readUInt32LE(12)!==frame.length-16)return null;
 const query=protocol.parseMagicGemProtobuf(P.encode([{number:10,wire:2,bytes:P.encode([{number:7,wire:0,value:1n}])}]));
 return mkFrame(11888,protocol.magicGemResponsePayload(state,query,{ok:true}),{stream:role,flags:0xca});
}
module.exports={validRequest,afterNotify,magicReply};
