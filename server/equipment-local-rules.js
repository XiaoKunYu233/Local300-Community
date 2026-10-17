'use strict';

// Playable private-server policy. Costs, growth and displayed odds come from
// the ordinary client table; server RNG, no downgrade and reforge rolls are
// local choices requested by the user, not claims about the original server.
const crypto=require('crypto');
const ordinary=require('./enhancement-rules');
const CLIENT_REFORGE_BOUNDS=require('./runtime/catalogs').loadConfig('reforge-thresholds').data.boundsByCode;

const REFORGE_CARDS=Object.freeze([7516,7517,7518,7519]);
// The client has eight ordinary reforge codes and grade boundaries for each
// of the three slots. The simulator video confirms their displayed stat pool
// and shows that a stat can repeat. The server pool and its weights are absent;
// until recovered, choose each supported ordinary code with equal weight.
const REFORGE_POOL=Object.freeze([3,15,18,31,38,50,87,88]);
const EMPTY_BLESSING=Buffer.alloc(42).toString('hex');

function initialStateFor({legacy}={}){
  return {level:Number.isInteger(legacy?.level)&&legacy.level>=0&&legacy.level<=17
    ? legacy.level : 0,
  blessing:Number.isInteger(legacy?.blessing)&&legacy.blessing>=0&&legacy.blessing<=65535
    ? legacy.blessing : 0};
}
function enhancementRuleFor({itemId,currentLevel,targetLevel,blessing=0,luckyItemId=0}){
  const base=ordinary.ruleFor({itemId,currentLevel,targetLevel});
  if(!Number.isInteger(blessing)||blessing<0||blessing>65535)
    throw new RangeError('invalid blessing count');
  const cardIndex=ordinary.DISPLAY_CARDS.indexOf(luckyItemId);
  if(luckyItemId && cardIndex<currentLevel)
    throw new RangeError('lucky card does not cover target level');
  const cap=ordinary.DISPLAY_FAILURE_CAPS[currentLevel];
  const guaranteed=blessing>=cap || luckyItemId!==0;
  return {...base,executionReady:true,blockers:[],
    resources:{...base.resources,...(luckyItemId?{[luckyItemId]:1}:{})},
    walletCost:{gold:0,diamond:0},failureLevel:currentLevel,
    successNumerator:guaranteed?10000:ordinary.DISPLAY_RATE_BPS[currentLevel],
    successDenominator:10000,policy:'local-client-v1'};
}
function blessingFor({previous,plan,result}){
  if(result.success)return 0;
  const cap=ordinary.DISPLAY_FAILURE_CAPS[plan.currentLevel];
  const count=Number.isInteger(previous)&&previous>=0?previous:0;
  return Math.min(cap,count+1);
}
function baselineFor({record}){
  return Buffer.isBuffer(record)&&record.length>=118
    ? record.subarray(76,118).toString('hex') : EMPTY_BLESSING;
}
function activeSlots(level){return level>=15?3:level>=9?2:level>=4?1:0;}
function drawBelow(max,draw=crypto.randomInt){
  const value=draw(max);
  if(!Number.isInteger(value)||value<0||value>=max)throw new RangeError('invalid reforge draw');
  return value;
}
function gradeFor(code,value,slot){
  const bounds=CLIENT_REFORGE_BOUNDS[code]?.[slot];
  if(!bounds||!Number.isInteger(value)||value<=0)return 0;
  return value<bounds[0]?1:value<=bounds[1]?2:3;
}
function valueFor(entry,slot,grade,draw){
  const [lower,upper]=CLIENT_REFORGE_BOUNDS[entry]?.[slot]||[];
  if(!Number.isInteger(lower)||!Number.isInteger(upper))
    throw new RangeError('missing client reforge grade bounds');
  if(grade===1){
    // User-approved local estimate (2026-10-13), not a recovered native minimum.
    // Keep every integer through the client's green upper edge equally likely.
    const minimum=Math.max(1,Math.ceil(lower*0.25));
    return minimum+drawBelow(lower-minimum,draw);
  }
  if(grade===2)return lower+drawBelow(upper-lower+1,draw);
  if(grade===3){
    // The client only specifies the lower edge of this grade. A provisional
    // 30% extension covers the purple examples in the supplied partial table
    // (including 640 HP on the third line) without claiming the original cap.
    const span=Math.max(1,Math.ceil(upper*0.3));
    return upper+1+drawBelow(span,draw);
  }
  throw new RangeError('invalid reforge grade');
}
function writeRoll(buffer,slot,grade=1,draw){
  if(slot<0||slot>2)throw new RangeError('invalid reforge slot');
  const code=REFORGE_POOL[drawBelow(REFORGE_POOL.length,draw)];
  const offset=slot*7;
  buffer[offset]=code;
  buffer.writeUInt32LE(valueFor(code,slot,grade,draw),offset+1);
  buffer.writeUInt16LE(1,offset+5);
}
function reforgeRuleFor(instance,luckyItemId=0){
  if(!ordinary.eligibility(instance?.itemId).supported ||
     !Number.isInteger(instance?.level) || instance.level<4 || instance.level>17)return null;
  if(luckyItemId && !REFORGE_CARDS.includes(luckyItemId))return null;
  if(luckyItemId){
    if(instance.level<15)return null;
    if(luckyItemId>=7518){
      const baseline=Buffer.from(instance.baselineHex||'', 'hex');
      if(baseline.length!==42)return null;
      const grades=Array.from({length:3},(_,slot)=>
        gradeFor(baseline[slot*7],baseline.readUInt32LE(slot*7+1),slot));
      if(grades.filter(grade=>grade>=2).length<3 && !grades.some(grade=>grade>=3))
        return null;
    }
  }
  return {executionReady:true,resources:luckyItemId?{[luckyItemId]:1}:{},
    walletCost:{gold:0,diamond:activeSlots(instance.level)*100},
    slots:activeSlots(instance.level),quality:REFORGE_CARDS.indexOf(luckyItemId)+1,
    policy:'local-client-v1'};
}
function generateCandidate({instance,rule},draw=crypto.randomInt){
  if(!rule||!Number.isInteger(rule.slots)||rule.slots<1||rule.slots>3)
    throw new RangeError('invalid reforge slots');
  const candidate=Buffer.alloc(42);
  const grades=Array(rule.slots).fill(1);
  if(rule.quality===0){
    for(let slot=0;slot<rule.slots;slot++)
      grades[slot]=drawBelow(100,draw)<80?1:2;
  }
  if(rule.quality===1){
    const guaranteed=drawBelow(rule.slots,draw);
    grades[guaranteed]=2;
    for(let slot=0;slot<rule.slots;slot++)if(slot!==guaranteed)
      grades[slot]=drawBelow(100,draw)<75?1:2;
  } else if(rule.quality===2)grades.fill(2);
  else if(rule.quality===3){
    const guaranteed=drawBelow(rule.slots,draw);
    grades.fill(2);grades[guaranteed]=3;
    for(let slot=0;slot<rule.slots;slot++)if(slot!==guaranteed)
      grades[slot]=drawBelow(100,draw)<75?2:3;
  }
  else if(rule.quality===4)grades.fill(3);
  else if(rule.quality!==0)throw new RangeError('invalid reforge card quality');
  for(let slot=0;slot<rule.slots;slot++)writeRoll(candidate,slot,grades[slot],draw);
  return candidate;
}
function milestoneCandidate({instance,targetLevel},draw=crypto.randomInt){
  if(![4,9,15].includes(targetLevel))return null;
  const candidate=Buffer.from(instance.baselineHex||EMPTY_BLESSING,'hex');
  if(candidate.length!==42)throw new RangeError('invalid blessing baseline');
  const slot=activeSlots(targetLevel)-1;
  if(candidate[slot*7]===0)writeRoll(candidate,slot,1,draw);
  return candidate;
}

module.exports={initialStateFor,enhancementRuleFor,attributesFor:ordinary.attributesFor,
  blessingFor,baselineFor,reforgeRuleFor,generateCandidate,milestoneCandidate,
  activeSlots,REFORGE_CARDS,REFORGE_POOL,gradeFor};
