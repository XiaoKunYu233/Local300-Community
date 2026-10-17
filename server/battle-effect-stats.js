'use strict';
const {rawAttributes}=require('./attribute-math');
// Keep temporary skill statistics separate from the saved equipment baseline.
function install(e,a=e.attributes||{}){
  e.effectBase={attributes:{...a},raw:{...rawAttributes(a)},hpMax:e.hpMax,mpMax:e.mpMax||0,
    armor:e.armor||0,magicResistance:e.magicResistance||0};
  e.effectStatsApplied=false;
}
function apply(sim,e,m={}){
  if(!e.attributes)return;
  const hasModifiers=['abilityPower','abilityPowerPercent','armor','armorReduction','magicResistance','healthRegen','tenacity','flatPen','health','mana','manaRegen','manaRegenPercent','gluttonyHealthOverride','gluttonyHealthFactor','gluttonyManaOverride','gluttonyManaFactor'].some(key=>m[key]) ||
    (e.passives?.genesis && e.genesisPenMode);
  if(!hasModifiers&&!e.effectStatsApplied)return;
  e.effectStatsApplied=hasModifiers;
  if(!e.effectBase)install(e);
  const {attributes:b,raw:r}=e.effectBase;
  const final=(id,add,percent)=>Math.round(((r[id]??b[id]??0)+(add||0))*Math.max(0,1+((r[percent]||0)+(percent===37?(m.abilityPowerPercent||0):0))/100));
  const baseHPMax=r[8]!==undefined?final(8,m.health,10):Math.round(e.effectBase.hpMax+(m.health||0));
  const baseMPMax=r[9]!==undefined?final(9,m.mana,11):Math.round(e.effectBase.mpMax+(m.mana||0));
  const hpMax=Number.isFinite(m.gluttonyHealthOverride)?Math.round(m.gluttonyHealthOverride):Math.round(baseHPMax*(m.gluttonyHealthFactor||1));
  const mpMax=Number.isFinite(m.gluttonyManaOverride)?Math.round(m.gluttonyManaOverride):Math.round(baseMPMax*(m.gluttonyManaFactor||1));
  const unit=e.passives?.unitG;
  const unitValue=hp=>unit&&!e.passives.pangu?Math.floor(hp*(.55+unit.level*.03)/100):0;
  const unitDelta=unitValue(hpMax)-unitValue(e.effectBase.hpMax);
  const mrPercent=(e.passives?.martial?5:0)+(e.passives?.adapt?.level>=15?10:0);
  const regenDelta=e.passives?.terask?Math.floor(hpMax*.006)-Math.floor(e.effectBase.hpMax*.006):0;
  const next={31:final(31,m.abilityPower,37),128:final(128,m.abilityPower,37),
    42:Math.max(0,(r[42]!==undefined?final(42,(m.armor||0)+unitDelta,43):e.effectBase.armor+(m.armor||0)+unitDelta)-(m.armorReduction||0)),
    44:Math.max(0,(b[44]??e.effectBase.magicResistance)+Math.round(((m.magicResistance||0)+unitDelta)*(1+mrPercent/100))),
    12:(b[12]||0)+(m.healthRegen||0)+regenDelta,
    13:Math.max(0,Math.round(((b[13]||0)+(m.manaRegen||0))*Math.max(0,1+(m.manaRegenPercent||0)/100))),99:(b[99]||0)+(m.tenacity||0),
    106:(b[106]||0)+(m.flatPen||0)};
  if(e.passives?.genesis){
    const baseArmorPen=Math.max(0,e.effectBase.attributes[106]||0);
    const baseMagicPen=Math.max(0,e.effectBase.attributes[107]||0);
    // The current item's fourth passive grants 150 penetration at any HP.
    // Its active moves that static allocation between the two damage types.
    // The separate "formless power" passive has no verified attribute mapping.
    next[106]=Math.max(0,baseArmorPen-(e.genesisPenMode==='magic'?150:0))+(m.flatPen||0);
    next[107]=baseMagicPen+(e.genesisPenMode==='magic'?150:0);
  }
  next[8]=Math.max(1,hpMax);e.hpMax=next[8];
  next[9]=Math.max(0,mpMax);next[2]=next[9];e.mpMax=next[9];
  if(!e.progressionUpdateContext?.deferResourceClamp){e.hp=Math.min(e.hp,e.hpMax);e.mp=Math.min(e.mp,e.mpMax);}
  e.armor=next[42];e.magicResistance=next[44];
  const changed=Object.entries(next).some(([id,value])=>e.attributes[id]!==value);
  Object.assign(e.attributes,next);
  if(changed)sim.event('equipment-passive-attributes',{id:e.id});
}
function combine(...values){
  const out={damageMultiplier:1,movementMultiplier:1,cooldownRate:0};
  for(const v of values)for(const [key,value]of Object.entries(v||{})){
    if(key==='damageMultiplier'||key==='movementMultiplier')out[key]*=value;
    else if(typeof value==='boolean')out[key]=out[key]||value;
    else if(Number.isFinite(value))out[key]=(out[key]||0)+value;
  }
  return out;
}
module.exports={install,apply,combine};
