'use strict';
const {aggregate,clamp,addSources}=require('./attribute-math');
const catalog=require('./equipment-catalog');
const {shieldCap}=require('./equipment-passive-shields');
// Source: item_item field 24, item_armour field 29 (active skill 6146).
const names={26030:'dagger',27011:'sword',26033:'blood',29028:'omen',27351:'tian',27316:'shoes',27068:'shoes',
  27018:'terask',26041:'dragon',26045:'zeal',26054:'martial',27021:'adapt',28069:'unitG',
  28064:'hermes',28065:'soulArmor',28070:'soulShield',27012:'gauss',26034:'qing',29049:'genesis',29050:'drowned',
  30172:'rainbow',30176:'genesis'};
const pangu=new Set([21070,26043,30106]);
// Cosmetic versions do not consistently carry the inheritance field (66).
// Identify the supported passive families from the normal client's full text;
// inheritance is only a fallback when that text is absent.
const clientItems=new Map(require('../data/current-client/item_item.json').map(row=>[row[1],row]));
const clientArmour=new Map(require('../data/current-client/item_armour.json').map(row=>[row[1],row]));
function ruleFor(itemId,seen=new Set()){
  if(seen.has(itemId))return null;seen.add(itemId);
  const row=clientItems.get(itemId),desc=String(row?.[24]||'');
  if(catalog.isHeroExclusive(desc))return null;
  let name=names[itemId];
  if(desc.includes('暴击伤害提升为275%'))name='sword';
  else if(desc.includes('受到高于自身5%最大生命值')&&desc.includes('3秒后结算等额的真实伤害'))name='blood';
  else if(desc.includes('将转换为可吸收所有伤害的护盾'))name='omen';
  else if(desc.includes('保持移动时')&&desc.includes('最高附加800移动速度'))name='shoes';
  else if(desc.includes('三层护盾')&&clientArmour.get(itemId)?.[29]===6146)name='dagger';
  else if(!pangu.has(itemId)&&desc.includes('自身最大生命值的（1+强化等级*0.1）%转化为攻击力'))name='tian';
  if(name)return {name,swordMarks:name==='sword'&&desc.includes('圣剑印记'),healingReceived:name==='zeal'&&desc.includes('受到的治疗效果35%')?35:0,
    omenCapBase:name==='omen'&&desc.includes('（30+强化等级）%最大生命值')?30:12.5,
    omenCapPerLevel:name==='omen'&&desc.includes('（30+强化等级）%最大生命值')?1:.5,
    omenFullLifeShield:name==='omen'&&desc.includes('额外按照生命偷取比例获得护盾')};
  if(!desc&&row?.[66])return ruleFor(row[66],seen);
  return null;
}
function compile(equipment,levelFor=e=>e.enhancementLevel){
  const out={},seen=new Set(),generic=[];
  for(const [slot,e] of equipment){
    if(slot<0||slot>=6||!e)continue;
    const guid=Buffer.isBuffer(e.guid)?e.guid.toString('hex'):e.guid;
    if(guid&&seen.has(guid))continue;if(guid)seen.add(guid);
    if(pangu.has(e.itemId))out.pangu=true;
    const rule=ruleFor(e.itemId),name=rule?.name;
    if(!name&&!pangu.has(e.itemId)){
      const item=catalog.get(e.itemId);
      if(item&&!item.exclusive&&(Object.keys(item.attributes).length||item.effects.length))
        generic.push({itemId:e.itemId,guid,slot,level:clamp(Math.floor(levelFor?.(e,slot)||0),0,17),attributes:item.attributes,effects:item.effects.map(effect=>({...effect})),name:item.name});
      if(!item?.effects?.length&&!Object.keys(item?.attributes||{}).length)continue;
    }
    if(!name)continue;
    const level=clamp(Math.floor(levelFor?.(e,slot)||0),0,17);
    if(!out[name]||level>out[name].level)out[name]={...rule,level,guid,itemId:e.itemId};
  }
  // Shared native passive families explicitly marked by the client are
  // single-source effects. Keep only the highest enhancement level; ties are
  // deterministic by equipment slot order. Other effects remain additive.
  const winners=new Map();
  for(let i=0;i<generic.length;i++)for(let j=0;j<generic[i].effects.length;j++){
    const effect=generic[i].effects[j],group=effect.stackGroup;if(!group)continue;
    const prior=winners.get(group),candidate={i,j,level:generic[i].level,slot:generic[i].slot};
    if(!prior||candidate.level>prior.level||(candidate.level===prior.level&&candidate.slot<prior.slot))winners.set(group,candidate);
  }
  for(let i=0;i<generic.length;i++)generic[i].effects=generic[i].effects.filter((effect,j)=>{
    const prior=effect.stackGroup?winners.get(effect.stackGroup):null;
    return !prior||prior.i===i&&prior.j===j;
  });
  // Keep the compatibility surface of the original named passive map (the
  // property is deliberately non-enumerable), while exposing all other
  // battlefield item effects to the generic battle hooks.
  Object.defineProperty(out,'generic',{value:generic,writable:true,configurable:true,enumerable:false});
  return out;
}
function calculate(base,bonus,gems,passives,progressionSources={}){
  const extras=Object.values(progressionSources);
  const progression=addSources(...extras);
  const b={...base,25:base[25]>0?base[25]:200};
  // Additive passive percentages join gem percentages; HP conversion is a
  // fixed attack source, calculated after max HP and before attack percentages.
  for(const id of [24,36,97,30,127])b[id]??=0;
  const p={},s=passives.sword,v=passives.blood,o=passives.omen,t=passives.tian;
  const add=(id,value)=>{b[id]??=0;p[id]=(p[id]||0)+value;};
  for(const item of passives.generic||[]){
    for(const [id,value] of Object.entries(item.attributes||{}))add(+id,Number(value)||0);
    for(const effect of item.effects||[]){
      if(effect.type==='levelAttribute')add(effect.attr,(effect.amount||0)+(item.level||0)*(effect.perLevel||0));
      if(effect.type==='selfDamageReduction')add(95,-(effect.amount||0));
    }
  }
  if(passives.terask){
    add(10,20+passives.terask.level);
    if(passives.terask.level>=15){add(99,20);add(96,10);add(18,15);}
  }
  if(passives.dragon?.level>=15)add(10,10);
  // Adaptive gear defaults to HP/physical mode until switched by its active.
  if(passives.drowned)add(10,10);
  // Genesis explicitly provides an unconditional 150 flat penetration source.
  // Its separate "150無相之力 above half HP" clause remains unmapped; the
  // active switches only this verified flat source between armor/magic modes.
  if(passives.genesis){add(36,5);add(1,300+passives.genesis.level*40);add(8,300+passives.genesis.level*40);add(106,150);}
  if(passives.zeal)add(100,15);
  let mrPercent=0;
  if(passives.martial){add(43,5);mrPercent+=5;}
  if(passives.adapt?.level>=15){add(43,10);mrPercent+=10;add(17,2);}
  const preliminary=aggregate(b,addSources(bonus,p),gems,...extras),maxHP=preliminary[8]||0;
  for(const item of passives.generic||[])for(const effect of item.effects||[])if(effect.type==='resistToStats'){
    add(30,Math.round((preliminary[44]||0)*Number(effect.attackRatio||0)));
    add(31,Math.round((preliminary[44]||0)*Number(effect.abilityPowerRatio||0)));
  }
  if(passives.unitG&&!passives.pangu){
    const lv=passives.unitG.level,converted=Math.floor(maxHP*(.55+lv*.03)/100);
    add(42,converted);add(44,converted);
  }
  if(mrPercent)add(44,Math.round(((b[44]||0)+((bonus[44]||0)+(progression[44]||0))+(gems?.[44]||0)+(p[44]||0))*mrPercent/100));
  if(passives.terask)add(12,Math.floor(maxHP*.006));
  if(passives.zeal)add(12,Math.round(((b[12]||0)+((bonus[12]||0)+(progression[12]||0))+(gems?.[12]||0)+(p[12]||0))*.35));
  if(passives.soulArmor||passives.soulShield)add(107,30);
  if(passives.gauss){add(15,100);add(106,120);add(14,80);}
  if(passives.qing)add(106,Math.round(((b[106]||0)+((bonus[106]||0)+(progression[106]||0))+(gems?.[106]||0)+(p[106]||0))*.3));
  if(passives.hermes){
    const lv=passives.hermes.level,flat=((b[106]||0)+((bonus[106]||0)+(progression[106]||0))+(gems?.[106]||0)+(p[106]||0))*(20+lv*2)/100;
    add(30,Math.round(flat));add(127,Math.round(flat));
    const magic=((b[107]||0)+((bonus[107]||0)+(progression[107]||0))+(gems?.[107]||0)+(p[107]||0))*(55+lv*3)/100;
    add(31,Math.round(magic));add(128,Math.round(magic));
  }
  if(s){p[36]=(p[36]||0)+15+s.level;if(s.level>=15)p[24]=(p[24]||0)+15;}
  if(v){p[36]=(p[36]||0)+5*Math.floor(v.level/5);p[24]=(p[24]||0)+3*Math.floor(v.level/5);}
  if(o){p[24]=(p[24]||0)+15;p[97]=10;}
  if(t&&!passives.pangu){
    const hp=aggregate(b,addSources(bonus,p),gems,...extras)[8]||0;
    const converted=Math.floor(hp*(1+t.level*.1)/100);
    add(30,converted);add(127,converted);
  }
  if(s){
    const crit=(b[24]||0)+((bonus[24]||0)+(progression[24]||0))+(gems?.[24]||0)+(p[24]||0);
    // Normal client's current description: 275%, +1% per 2% crit chance.
    // Preserve a half point for odd crit chance instead of truncating it.
    p[25]=275-b[25]+Math.max(0,crit)/2;
  }
  return aggregate(b,addSources(bonus,p),gems,...extras);
}
function install(sim,hero,passives){
  hero.passives=passives;
  if(!passives.sword)hero.buffs=hero.buffs.filter(b=>b.slot!=='equipment:sword-crit');
  else for(const b of hero.buffs)if(b.slot==='equipment:sword-crit')b.attackSpeed=10+passives.sword.level;
  if(!passives.shoes)hero.lastMovedAt=-Infinity;
  const magicShield=(hero.buffs||[]).filter(buff=>buff.magicGemShieldHeal&&buff.until>sim.time).reduce((sum,buff)=>sum+Math.max(0,Number(buff.magicGemShieldHealRemaining)||0),0);
  const cap=shieldCap(hero)+(hero.soulShield?.remaining||0)+(hero.summonerState?.shield?.remaining||0)+magicShield;
  sim.setShield(hero,Math.min(hero.shield||0,cap));
  for(const [key,skill] of Object.entries(hero.skills))if(skill.equipment)delete hero.skills[key];
  if(passives.dagger){
    // One cooldown key per skill prevents unequip/re-equip from resetting it.
    hero.skills['equipment:6146']={id:6146,type:'guard',equipment:true,level:2,
      mana:0,cooldown:100-passives.dagger.level*4};
  }else hero.guard=null;
  require('./equipment-active-skills').install(hero);
  require('./equipment-dynamic-passives').install(sim,hero);
}
module.exports={compile,calculate,install,ruleFor,shieldCap};
