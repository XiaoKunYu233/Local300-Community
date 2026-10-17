'use strict';
const number=(value,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
// Native descriptions display distances in centi-world units, like range600
// for a6-unit aura. Preserve that UI value outside actual combat geometry.
function normalize(effect){
 if(!effect||typeof effect!=='object')return effect;
 const out={...effect};
 if(Number(out.setId)===113&&out.type==='magicGemWalkTrap'){
  const clientDistance=number(out.clientDistance,out.distanceUnit==='world'?number(out.distance)*100:number(out.distance));
  out.clientDistance=clientDistance;out.distance=clientDistance/100;out.distanceUnit='world';
 }
 return out;
}
function adaptive(owner,effect){
 const ad=Math.max(0,number(owner.attributes?.[30],owner.attackDamage)),ap=Math.max(0,number(owner.attributes?.[31]));
 const adRatio=Math.max(0,number(effect.adRatio)),apRatio=Math.max(0,number(effect.apRatio));
 // Both terms are explicit in set112/113 tooltip. Choosing damage school
 // keeps the existing declared engine policy; it must not discard a term.
 return {amount:Math.floor(ad*adRatio+ap*apRatio),damageType:ad>=ap?'physical':'magic',adRatio,apRatio};
}
function bonusAD(owner){return Math.max(0,number(owner.attributes?.[127],owner.bonusAttackDamage));}
module.exports={normalize,adaptive,bonusAD};
