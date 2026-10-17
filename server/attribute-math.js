'use strict';

// Native HP/MP/attack percent fields hold bonus points (0 means no bonus).
// Attack speed and movement fields instead hold total percentages (100 is base).
const percentTargets={10:[1,8],11:[2,9],36:[30,127],37:[31,128],43:[42]};
const RAW=Symbol('rawAttributes');
function aggregate(base,...sources){
  const out={...base};
  for(const source of sources)for(const [id,value] of Object.entries(source||{})){
    if(out[id]!==undefined&&Number.isFinite(value))out[id]+=value;
  }
  // Each input is one source class. Members of a class were already added;
  // penetration from independent classes combines through remaining armor.
  for(const id of [108,109])if(out[id]!==undefined)
    out[id]=combinePenetration([base,...sources].map(source=>source?.[id]||0));
  const raw={...out};
  for(const [percent,targets] of Object.entries(percentTargets)){
    const factor=Math.max(0,1+(out[percent]||0)/100);
    for(const id of targets)if(out[id]!==undefined)out[id]=Math.round(out[id]*factor);
  }
  Object.defineProperty(out,RAW,{value:raw});
  return out;
}
function combinePenetration(groups){
  return 100*(1-groups.reduce((remaining,value)=>remaining*(1-Math.max(0,Math.min(100,Number(value)||0))/100),1));
}
function addSources(...sources){
  const out={};for(const source of sources)for(const [id,value] of Object.entries(source||{}))
    if(Number.isFinite(Number(value)))out[id]=(out[id]||0)+Number(value);
  return out;
}
function moveSpeed(flat,totalPercent=100){
  const ideal=Math.max(0,flat*totalPercent/100);
  return ideal<415?ideal:ideal<=490?.8*ideal+83:.5*ideal+230;
}
function movePercentForSpeed(flat,speed){
  if(!(flat>0))return 0;
  const desired=Math.max(0,speed),ideal=desired<415?desired:desired<=475?(desired-83)/.8:(desired-230)/.5;
  return Math.max(0,ideal/flat*100);
}
const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
function resistanceMultiplier(resistance,flatPen=0,percentPen=0,unpenetrable=0){
  // Negative-resistance behavior was not supplied; the local policy floors it
  // at zero, and clamps penetration to 0..100 to avoid singular denominators.
  const protectedPart=Math.max(0,Math.min(resistance,unpenetrable));
  const effective=protectedPart+Math.max(0,(resistance-protectedPart-flatPen)*(1-clamp(percentPen,0,100)/100));
  return 100/(effective+100);
}
function hitChance(hit=100,dodge=100){
  return clamp((hit+100)/Math.max(1,dodge+100),0,1);
}
function warSoulMultiplier(averageRestraint=0,averageResistance=0){
  const a=Number.isFinite(averageRestraint)?Math.max(0,averageRestraint):0;
  const b=Number.isFinite(averageResistance)?Math.max(0,averageResistance):0;
  // Native war-soul combat uses net restraint after resistance. Every 100
  // points changes the matching elemental damage by 10 percentage points.
  return Math.max(0,1+(a-b)/1000);
}
// War-soul stage rows use four restraint channels (32..35) and four matching
// resistance channels (45..48). Keep the element mapping explicit so a fire
// bonus cannot accidentally amplify frost/light/dark damage.
const warSoulElementChannels=Object.freeze({
  fire:{restraint:32,resistance:45},
  frost:{restraint:33,resistance:46},
  light:{restraint:34,resistance:47},
  dark:{restraint:35,resistance:48},
});
function warSoulElementMultiplier(attacker={},target={},element){
  const channel=warSoulElementChannels[String(element||'').toLowerCase()];
  if(!channel)return warSoulMultiplier(attacker.averageRestraint,target.averageResistance);
  const a=Math.max(0,Number(attacker.restraint?.[channel.restraint]||0));
  const b=Math.max(0,Number(target.resistance?.[channel.resistance]||0));
  return Math.max(0,1+(a-b)/1000);
}
module.exports={aggregate,combinePenetration,addSources,moveSpeed,movePercentForSpeed,resistanceMultiplier,hitChance,warSoulMultiplier,clamp,
 warSoulElementMultiplier,warSoulElementChannels,rawAttributes:value=>value[RAW]||value};
