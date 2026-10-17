'use strict';
const catalog=require('./equipment-active-geometry-catalog'),bindings=new Map(catalog.entries.map(([itemId,id,level,range,targetRange])=>[itemId,Object.freeze({id,level,range,targetRange})]));
// These four local-only IDs are confirmed to throw UInt16 writes. No native
// skill is substituted; their item attributes and passive hooks remain intact.
const unbound=new Set([27052,27060,27807,27899]);
function apply(item,skill,{rangeFormula=false}={}){
 if(!skill)return null;const native=bindings.get(item.id);
 if(unbound.has(item.id)){
  skill.unsupportedNative={reason:'equipment-native-skill-unbound',itemId:item.id,localSkillId:skill.id};
  skill.nativeSkillId=null;return skill;
 }
 const notes=[];skill.geometryEvidence={source:catalog.source,range:'legacy-unverified',radius:'legacy-unverified'};
 if(native&&native.id===skill.id&&native.level===(skill.level||1)){
  skill.nativeSkillId=native.id;
  if(skill.range>0){
   if(rangeFormula){skill.range/=100;skill.geometryEvidence.range='tooltip-enhancement-centimetres';}
   else if(native.range>0){skill.range=native.range;skill.geometryEvidence.range='native-skill-fRange-world';}
   else notes.push('Native self-range/target semantics require a separate cast-shape audit');
  }
  // Target range can describe a cast shape rather than an area radius. Only
  // these four artifact descriptions independently confirm this area size.
  if(skill.radius!==undefined&&[27854,27855,27856,27858].includes(item.id)&&native.targetRange>0){skill.radius=native.targetRange;skill.geometryEvidence.radius='native-targetRange-and-area-tooltip';}
  else if(skill.radius!==undefined)notes.push('Area radius semantics are not verified; existing behavior retained');
 }else notes.push('No current exact native item/skill/level binding; geometry retained');
 if(item.id===27809&&native?.id===skill.id){skill.knockback=4;skill.geometryEvidence.knockback='current-tooltip-400-centimetres';notes.push('Self recoil magnitude and cooldown remain unverified legacy behavior; no 0.75 rule is established');}
 // Width 1/3 and teleport anchor radius 15 were authored in world units;
 // they are not text distances and must not be divided merely by magnitude.
 if(notes.length)skill.geometryNotes=notes;
 return skill;
}
module.exports={apply,bindings,unbound,source:catalog.source};
