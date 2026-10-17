'use strict';

// Artificial rules and wire frames for isolated TCP tests only. The lobby
// loads this module solely with the temporary-write guard and random port.
const {mkFrame} = require('./bag');
const itemId=27062;
const candidate=Buffer.alloc(42);
candidate[0]=18;candidate.writeUInt32LE(8,1);candidate.writeUInt16LE(1,5);
const frame=(id,payload)=>mkFrame(id,payload,{flags:0xd3});
const rules={
  baselineFor:()=>Buffer.alloc(42).toString('hex'),
  enhancementRuleFor:({itemId:id,currentLevel,targetLevel})=>id===itemId?{
    executionReady:true,itemId:id,currentLevel,targetLevel,
    resources:{40001:5,40003:2},walletCost:{gold:0,diamond:0},
    purchasePrice:{gold:missing=>Object.values(missing).reduce((a,b)=>a+b,0)*10,
      diamond:missing=>Object.values(missing).reduce((a,b)=>a+b,0)*100},
    successNumerator:1,successDenominator:2,failureLevel:currentLevel,
  }:null,
  attributesFor:(id,level)=>id===itemId?{101:level*3}:null,
  blessingFor:({previous,plan,result})=>result.success?0:(previous??0)+plan.targetLevel,
  reforgeRuleFor:(instance,luckyItemId)=>instance.itemId===itemId && luckyItemId===0?{
    executionReady:true,resources:{7516:1,1121:1},walletCost:{gold:0,diamond:200},
  }:null,
  generateCandidate:()=>Buffer.from(candidate),
};
const wire={
  enhancementQuery:({rule})=>{const p=Buffer.alloc(1286);p[0]=2;
    p.writeUInt32LE(rule.resources[40001]||0,1);p.writeUInt32LE(0,5);
    p.writeUInt32LE(rule.resources[40003]||0,9);return [frame(13511,p)];},
  enhancementOutcome:({result})=>{const p=Buffer.alloc(16);p[0]=result.success?1:0;
    return [frame(13513,p)];},
  reforgeOutcome:({kind,pending})=>kind==='begin'
    ? [frame(13519,Buffer.from(pending.candidateHex,'hex'))]
    : [frame(17004,Buffer.alloc(499))],
};
module.exports={rules,wire};
