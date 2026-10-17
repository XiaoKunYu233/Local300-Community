'use strict';
const {mkFrame}=require('./bag');
const rules=require('./enhancement-rules');

const RESOURCE_ORDER=[40001,40002,40003];
function queryPreview(instance,held){
  const status=rules.eligibility(instance?.itemId);
  if(!status.supported)throw new RangeError(status.reason);
  const level=instance.level;
  if(!Number.isInteger(level)||level<0||level>17)throw new RangeError('unknown enhancement level');
  if(!Number.isInteger(instance.blessing)||instance.blessing<0||instance.blessing>65535)
    throw new RangeError('unknown blessing count');
  const required=level===17 ? {40001:0,40002:0,40003:0}
    : rules.materialsFor(instance.itemId,level).resources;
  return {status,required,quote:rules.purchaseQuote(required,held||{}),
    levels:Array.from({length:18},(_,n)=>rules.attributesFor(instance.itemId,n)),
    skillCalculationLevel:Math.min(level,15)};
}
function buildQueryPayload({instance,queryType,balances}){
  if(![1,2].includes(queryType))throw new RangeError('unknown enhancement query type');
  const preview=queryPreview(instance,balances?.resources);
  const p=Buffer.alloc(1286);
  p[0]=queryType;
  const skillId=preview.status.row[29],skillLevel=preview.status.row[30];
  // Type 01 is the skill view. Official captures have requirements and this
  // 4-byte skill pair only for items with a configured skill; all 18 rows are
  // empty. Type 02 is the attribute view and always carries all 18 rows.
  const skillView=queryType===1&&Number.isInteger(skillId)&&skillId>0;
  if(queryType===2||skillView)
    RESOURCE_ORDER.forEach((id,index)=>p.writeUInt32LE(preview.required[id],1+index*4));
  if(skillView){
    if(skillId>65535||!Number.isInteger(skillLevel)||skillLevel<0||skillLevel>=65535)
      throw new RangeError('skill pair out of wire range');
    p.writeUInt16LE(skillId,13);
    p.writeUInt16LE(skillLevel+1,15);
  }
  if(queryType===2){
    for(let level=0;level<18;level++){
      const values=preview.levels[level];
      for(let id=1;id<=20;id++)p.writeUInt16LE(values[id],14+level*70+id*2);
    }
  }
  p.writeUInt16LE(instance.blessing,1276);
  return p;
}
function enhancementQuery(args){return [mkFrame(13511,buildQueryPayload(args),{flags:0xca})];}
module.exports={queryPreview,buildQueryPayload,enhancementQuery};
