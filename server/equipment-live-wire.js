'use strict';

const {mkFrame}=require('./bag');
const {enhancementQuery}=require('./enhancement-query-wire');

function enhancementOutcome({result,blessing}){
  const payload=Buffer.alloc(16);
  payload[0]=result.success?1:0;
  if(!result.success){payload[1]=9;payload.writeUInt16LE(blessing,2);}
  return [mkFrame(13513,payload,{flags:0xd3})];
}
function reforgeOutcome({kind,pending}){
  if(kind==='begin')return [mkFrame(13519,Buffer.from(pending.candidateHex,'hex'),{flags:0xd3})];
  // The lobby builds the exact GUID's 17004 from its current instance record.
  return [];
}
module.exports={enhancementQuery,enhancementOutcome,reforgeOutcome};
