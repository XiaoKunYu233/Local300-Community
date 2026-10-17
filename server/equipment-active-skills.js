'use strict';
const catalog = require('./equipment-catalog');

const numberAfter = (text, words) => {
  const re = new RegExp(`(?:${words})[^\\d]{0,30}(\\d+(?:\\.\\d+)?)`, 'i'), m = String(text).match(re);
  return m ? Number(m[1]) : 0;
};
const numberAround = (text, words) => {
  const before = String(text).match(new RegExp('(\\d+(?:\\.\\d+)?)%[^\\n。；;]{0,20}(?:' + words + ')', 'i'));
  return before ? Number(before[1]) : numberAfter(text, words);
};
function cooldown(text) { const match=String(text).match(/冷却(?:时间)?\s*[:：]?\s*(\d+(?:\.\d+)?)\s*秒/); return match ? Number(match[1]) : 60; }
function range(text) { const m = String(text).match(/(\d+(?:\.\d+)?)\s*(?:范围|射程)/); return m ? Number(m[1]) : 400; }
function firstNumber(text) { const m = String(text).match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : 0; }
function generatedArtifact(item) {
  if (!item || item.id < 27800 || item.id > 27899) return 0;
  // The 278xx table mixes clickable commands with passive upgrades.  Only
  // the rows below have a client action button; passive rows must remain in
  // the generic equipment model and must not become empty buff skills.
  const activeIds = new Set([27803,27804,27807,27809,27813,27814,27817,27818,27819,27820,27822,27829,27830,27831,27832,27833,27834,27835,27836,27837,27838,27839,27841,27842,27843,27844,27845,27846,27847,27848,27849,27850,27851,27852,27853,27854,27855,27856,27857,27858,27859,27860,27899]);
  if (!activeIds.has(item.id)) return 0;
  const text = String(item.text || '');
  // Some artifact rows intentionally leave item_armour[29] at zero.  Their
  // descriptions still define a usable command (often an event artifact),
  // so expose a deterministic local skill id for the battle runtime.
  if (!/(?:冷却|使用次数|使用后|主动|施法|释放|指定|交换位置|击退|劈开|照亮|传送|建造|献祭|种植|放置|清除|发动)/.test(text)) return 0;
  if (/(?:冷却缩减|装备主动技能的冷却时间降低)/.test(text) && !/(?:冷却时间\s*[:：]?\s*\d+|使用后|主动)/.test(text)) return 0;
  return 200000 + Number(item.id);
}

function parsedSkillFor(item) {
  if (!item || item.exclusive) return null;
  const special = item.id === 30176
    ? { id: 20197, type: 'buff', range: 0, duration: Infinity, switchPenetration: true }
    : item.id === 27052
    ? { id: 270520, type: 'line', range: 1200, width: 1, equipmentDispel: true }
    : item.id === 27060
      ? { id: 270600, type: 'target', range: 900, allowAlly: true, guardShare: true }
      : null;
  const generated = generatedArtifact(item);
  if (!item.activeSkill && !special && !generated) return null;
  const text = item.text;
  // A number of passive effects reuse a skill/effect ID in item_armour[29]
  // (for example the charge attack family).  They must not become clickable
  // equipment buttons unless the description actually advertises an action.
  const beforePassive = text.split(/唯一被动/)[0];
  if (!special && /唯一被动/.test(text) && !/(?:唯一)?主动(?:效果)?[：:\-]/.test(text) && !/(?:对目标|对一名|发射|放置|使用后|施法|释放|召唤)/.test(beforePassive)) return null;
  if (!/(?:主动|消耗品|使用后|施法|释放|对目标|对一名|向指定|对自身|放置|引爆|发射|召唤|对区域|对单一|指定|交换位置|击退|劈开|照亮|传送|建造|献祭|种植|清除|发动|使用次数)/.test(text) && !generated) return null;
  const duration = numberAfter(text, '持续') || numberAfter(text, '维持') || 3;
  const cd = cooldown(text);
  const skill = { id: special?.id || item.activeSkill || generated, equipment: true, level: item.activeLevel || 1, mana: 0, cooldown: cd, range: special?.range || range(text), sourceItemId: item.id, sourceName: item.name, ...(special || {}) };
  if (special) return skill;
  // Artifact commands whose item rows share a generic skill id still carry
  // useful combat semantics in their descriptions.  Keep these overrides at
  // the edge so ordinary equipment continues to use the text parser below.
  if (item.id === 27807) return Object.assign(skill, { type: 'area', range: 500, radius: 300, friendlyArea: true, heal: 50, manaRestore: 25, duration: 10, interval: 5 });
  if (item.id === 27803) return Object.assign(skill, { type: 'line', range: 800, width: 1, damage: 10, damageType: 'true', control: .1 });
  if (item.id === 27804) return Object.assign(skill, { type: 'dash', range: 650, clampRange: true, randomLanding: true, oneUse: true });
  if (item.id === 27809) return Object.assign(skill, { type: 'target', range: 400, knockback: 400, selfKnockback: 75 });
  if (item.id === 27813) return Object.assign(skill, { type: 'buff', range: 0, duration: 5, hitBonus: 7000 });
  if (item.id === 27814) return Object.assign(skill, { type: 'target', range: 500, swap: true });
  if (item.id === 27817) return Object.assign(skill, { type: 'dash', range: 250, clampRange: true, requiresControlHit: true });
  if (item.id === 27818) return Object.assign(skill, { type: 'line', range: 500, width: 3, terrainBreak: true });
  if (item.id === 27819) return Object.assign(skill, { type: 'dash', range: 800, clampRange: true, hook: true });
  if (item.id === 27820) return Object.assign(skill, { type: 'area', range: 800, radius: 300, vision: true, duration: 5 });
  if (item.id === 27822) return Object.assign(skill, { type: 'target', range: 900, allowAlly: true, buildingOnly: true, guardBuilding: true, guardDuration: 3.5, buildingDamageBonus: 100 });
  if (item.id === 27830) return Object.assign(skill, { type: 'target', range: 900, allowAlly: true, buildingOnly: true, guardBuilding: true, guardDuration: 3.5, buildingAttackSpeedBonus: 100 });
  if (item.id === 27850) return Object.assign(skill, { type: 'buff', range: 0, duration: 30, speedMultiplier: 1.35, oneUse: true, cancelOnHeroDamage: true });
  if (item.id === 27851) return Object.assign(skill, { type: 'buff', range: 0, duration: 5, meditation: true, healRatio: .1, manaRatio: .1, immobilized: true });
  if (item.id === 27853) return Object.assign(skill, { type: 'buff', range: 0, duration: 3, speedMultiplier: .7, damageReductionPhysical: 95, damageReductionMagic: 95 });
  if (item.id === 27854) return Object.assign(skill, { type: 'area', range: 500, radius: 500, field: 'frost', fieldDuration: 5, slow: 5, attackSpeedSlow: 5, maxStacks: 8 });
  if (item.id === 27855) return Object.assign(skill, { type: 'area', range: 500, radius: 500, field: 'poison', fieldDuration: 5, healingReduction: 50 });
  if (item.id === 27856) return Object.assign(skill, { type: 'area', range: 500, radius: 500, field: 'lava', fieldDuration: 5, adaptiveDamageRatio: .05, damageType: 'true', interval: .5 });
  if (item.id === 27857) return Object.assign(skill, { type: 'area', range: 900, radius: 900, friendlyArea: true, cleanse: true, controlImmune: 3 });
  if (item.id === 27858) return Object.assign(skill, { type: 'area', range: 800, radius: 800, delayed: 1.5, adaptiveDamageRatio: .1, damageType: 'true', control: 1 });
  if (item.id === 27859) return Object.assign(skill, { type: 'target', range: 400, adaptiveDamageRatio: .07, damageType: 'true', duration: 7, interval: 1 });
  if (item.id === 27860) return Object.assign(skill, { type: 'target', range: 400, adaptiveDamageRatio: .25, damageType: 'true', slow: 99, healingReduction: 99, duration: 3 });
  if (item.id === 27829) return Object.assign(skill, { type: 'channel-teleport', range: 4500, channel: 4, anchorRadius: 15 });
  if (item.id === 27831) return Object.assign(skill, { type: 'buff', range: 0, duration: 10, trueSight: true });
  if (item.id === 27832) return Object.assign(skill, { type: 'area', range: 800, radius: 300, vision: true, duration: 5 });
  if (item.id === 27833) return Object.assign(skill, { type: 'target', range: 800, summon: 'tower', duration: 125 });
  if (item.id === 27834) return Object.assign(skill, { type: 'target', range: 800, summon: 'lane-monster', duration: 100 });
  if (item.id === 27835) return Object.assign(skill, { type: 'buff', range: 0, duration: 5, speedMultiplier: 1.3 });
  if (item.id === 27836) return Object.assign(skill, { type: 'target', range: 500, allowAlly: true, field: 'stealth', friendlyField: true, fieldDuration: 60, radius: 250 });
  if (item.id === 27837) return Object.assign(skill, { type: 'area', range: 800, radius: 500, clearObjects: true });
  if (item.id === 27841) return Object.assign(skill, { type: 'area', range: 500, radius: 300, summon: 'sunflower', duration: 180 });
  if (item.id === 27842) return Object.assign(skill, { type: 'target', range: 500, damage: 30, damageType: 'magic', control: 1, delayed: 3 });
  if (item.id === 27843) return Object.assign(skill, { type: 'area', range: 500, radius: 300, friendlyArea: true, healRatio: .05, shieldRatio: .05, duration: 90 });
  if (item.id === 27844) return Object.assign(skill, { type: 'area', range: 500, radius: 250, control: .5, trap: true, duration: 40 });
  if (item.id === 27845) return Object.assign(skill, { type: 'area', range: 800, radius: 1, summon: 'treasure', duration: 120 });
  if (item.id === 27846) return Object.assign(skill, { type: 'target', range: 500, damage: 10, damageScaling: { 30: 1, 31: .65 }, damageType: 'magic', debuffDamage: .05, duration: 4 });
  if (item.id === 27847) return Object.assign(skill, { type: 'area', range: 800, radius: 400, vision: true, clearObjects: true, duration: 5 });
  if (item.id === 27848) return Object.assign(skill, { type: 'area', range: 800, radius: 1, vision: true, trueSight: true, duration: 90 });
  if (item.id === 27849) return Object.assign(skill, { type: 'area', range: 800, radius: 1, vision: true, duration: 120 });
  if (item.id === 27852) return Object.assign(skill, { type: 'target', range: 800, control: 3, field: 'containment', fieldDuration: 3 });
  if (/冲锋|位移|瞬移至|朝目标点|移动至.*位置|冲刺/.test(text)) {
    skill.type = 'dash'; skill.range = numberAfter(text, '距离') || numberAfter(text, '范围') || 500; skill.clampRange = true; return skill;
  }
  if (/无敌|免疫伤害|伤害免疫|免疫绝大部分|无法被敌人攻击|进入SOS状态|虚灵状态|屏障/.test(text)) {
    skill.type = 'guard'; skill.guardDuration = duration; return skill;
  }
  const heal = text.match(/(?:恢复|回复|治疗)[^\d]{0,20}(\d+(?:\.\d+)?)%?\s*(?:生命|生命值|生命上限)/);
  const fixedHeal = text.match(/(?:恢复|回复|治疗)[^\d]{0,20}(\d+(?:\.\d+)?)\s*(?:点)?\s*(?:生命|生命值)/);
  if ((heal || fixedHeal) && !/造成.*伤害/.test(text.slice(Math.max(0, text.indexOf('主动'))))) {
    skill.type = 'heal';
    if (heal && /%/.test(heal[0])) skill.healRatio = Number(heal[1]) / 100;
    skill.heal = fixedHeal ? Number(fixedHeal[1]) : 0;
    return skill;
  }
  const damageMatch = text.match(/造成[^\d]{0,20}(\d+(?:\.\d+)?)/) || text.match(/伤害[^\d]{0,20}(\d+(?:\.\d+)?)/);
  skill.damage = damageMatch ? Number(damageMatch[1]) : 0;
  // Active equipment descriptions carry the authoritative damage school.  If
  // this is omitted, BattleSim defaults to physical damage, which incorrectly
  // makes battlefield artefacts such as 地火之心 and 海啸飓风 physical.
  if (/真实伤害/.test(text)) skill.damageType = 'true';
  else if (/(?:法术|魔法)伤害/.test(text)) skill.damageType = 'magic';
  else if (/物理伤害/.test(text)) skill.damageType = 'physical';
  const minimum = text.match(/最低\s*(\d+(?:\.\d+)?)/); if (minimum) skill.minDamage = Number(minimum[1]);
  if (/首次伤害|第一次伤害/.test(text)) { skill.firstHitDamage = skill.damage; skill.firstHitDamageScaling = skill.damageScaling; }
  const hpScale = text.match(/(\d+(?:\.\d+)?)%[^\n。；;)]*生命上限/);
  if (hpScale && /伤害/.test(text)) skill.damageScaling = { 8: Number(hpScale[1]) / 100 };
  if (/获得伤害值等额的治疗|造成伤害.*治疗/.test(text)) skill.healOnDamage = true;
  const apScale=text.match(/(\d+(?:\.\d+)?)%[^\n。；;)]*(?:法术强度|AP)/);
  if (apScale) skill.damageScaling = { ...(skill.damageScaling || {}), 31: Number(apScale[1]) / 100 };
  const adScale=text.match(/(\d+(?:\.\d+)?)%[^\n。；;)]*(?:攻击力|AD)/);
  if (adScale) skill.damageScaling = { ...(skill.damageScaling || {}), 30: Number(adScale[1]) / 100 };
  if (/生命上限/.test(text) && !skill.damage && !skill.damageScaling) skill.damageScaling = { 8: Number((text.match(/(\d+(?:\.\d+)?)%[^\n。；;)]*生命上限/) || [])[1] || 0) / 100 };
  if (/周围|范围内|附近|目标位置|目标地点|区域内|一定范围/.test(text)) { skill.type = 'area'; skill.radius = numberAfter(text, '范围|半径') || 300; }
  else skill.type = /目标|敌方英雄|一名敌人/.test(text) ? 'target' : 'buff';
  const activeSlow=text.match(/降低[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]%的攻击速度和移动速度/)
    || text.match(/降低\s*(\d+(?:\.\d+)?)%的攻击速度和移动速度/);
  if(activeSlow){skill.slowBase=Number(activeSlow[1]);skill.slowPerLevel=activeSlow[2]?Number(activeSlow[2]):0;skill.slow=skill.slowBase;skill.attackSpeedSlow=skill.slow;}
  if (skill.type === 'buff') {
    skill.duration = duration;
    if (/加速|移动速度/.test(text)) skill.speedMultiplier = 1 + (numberAround(text, '移动速度|加速') || 0) / 100;
    if (/攻击速度/.test(text)) skill.attackSpeedBonus = numberAround(text, '攻击速度');
    if (/生命偷取/.test(text)) { const values = [...text.matchAll(/(\d+(?:\.\d+)?)%[^\n。；;]{0,20}生命偷取/g)].map(m => Number(m[1])); skill.lifeStealBonus = values.at(-1) || numberAfter(text, '生命偷取'); }
    if (skill.firstHitDamage) skill.firstHitDamageScaling = skill.damageScaling || null;
  }
  return skill;
}

// The catalogue stores the formula in the description while the owned item
// stores its current enhancement level.  Keep parsing pure for callers that
// inspect catalogue skills, then apply the instance-specific terms here.
function skillFor(item, instance = null) {
  const skill = parsedSkillFor(item);
  if (!skill) return null;
  // Current c1cd50/48cfd0 stores cooldown by UInt16 skill ID; level selects
  // the effect row but is not part of the native cooldown map key.
  skill.cooldownKey=`equipment:${skill.id}`;
  const text = String(item.text || ''), level = Math.max(0, Math.min(17, Math.floor(Number(instance?.enhancementLevel || 0))));
  skill.enhancementLevel = level;
  if(skill.slowBase!==undefined){skill.slow=skill.slowBase+level*skill.slowPerLevel;skill.attackSpeedSlow=skill.slow;}
  const cooldown = text.match(/冷却时间\s*[（(]\s*(\d+(?:\.\d+)?)\s*-\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]\s*秒/);
  if (cooldown) {
    skill.baseCooldown = Number(cooldown[1]);
    skill.cooldown = Math.max(0, skill.baseCooldown - level * Number(cooldown[2]));
  }
  if (skill.switchPenetration) { skill.baseCooldown = 0; skill.cooldown = 0; }
  const damage = text.match(/(?:造成|附带|附加)[^\n。；;]*?[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]\s*(?:点)?[^\n。；;]*(?:伤害)/);
  if (damage) {
    skill.baseDamage = Number(damage[1]);
    skill.damage = skill.baseDamage + level * Number(damage[2]);
  }
  const rangeFormula = text.match(/(?:施法距离|施法范围|攻击距离|射程)\s*[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]/);
  if (rangeFormula) skill.range = Number(rangeFormula[1]) + level * Number(rangeFormula[2]);
  const durationFormula = text.match(/(?:持续时间|持续|自然持续时间)\s*[为是]?\s*[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]\s*秒/);
  if (durationFormula) skill.duration = Number(durationFormula[1]) + level * Number(durationFormula[2]);
  const controlFormula = text.match(/(?:眩晕|禁锢|定身)[^\n。；;]*?[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]\s*秒/);
  if (controlFormula) skill.control = Number(controlFormula[1]) + level * Number(controlFormula[2]);
  if (skill.control===undefined) {
    const fixedControl=text.match(/(?:眩晕|禁锢|定身|击飞)[^\n。；;]{0,20}?(\d+(?:\.\d+)?)\s*秒/);
    if(fixedControl)skill.control=Number(fixedControl[1]);
  }
  const delayed=text.match(/(\d+(?:\.\d+)?)秒后[^\n。；;]*(?:爆发|喷发|落下|触发|造成伤害)/);
  if(delayed)skill.delayed=Number(delayed[1]);
  const placeholderScales=[...text.matchAll(/\{~(\d+)\*0*(\d+(?:\.\d+))\}/g)].map(match=>({attr:Number(match[1]),ratio:Number(match[2])}));
  if(placeholderScales.length)skill.damageScaling=Object.fromEntries(placeholderScales.map(scale=>[scale.attr,scale.ratio]));
  const targetHealthFormula = text.match(/\+\s*[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级(?:\s*\*\s*(\d+(?:\.\d+)?))?\s*[）)]\s*%\s*目标(?:当前|最大)生命(?:值|上限)/);
  const levelHealthFormula = text.match(/[（(]\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)\s*[）)]\s*%\s*目标(?:当前|最大)生命(?:值|上限)/);
  const trailingLevelHealth = text.match(/目标(?:当前|最大)生命(?:值|上限)[^\n。；;]{0,12}[（(]\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)\s*[）)]\s*%/);
  if (targetHealthFormula || levelHealthFormula || trailingLevelHealth) {
    const match = targetHealthFormula || levelHealthFormula || trailingLevelHealth;
    skill.targetHealthCurrent = /目标当前生命/.test(match[0]);
    skill.targetHealthRatio = ((targetHealthFormula ? Number(targetHealthFormula[1]) : 0) + level * Number(targetHealthFormula?.[2] || levelHealthFormula?.[1] || trailingLevelHealth?.[1] || 1)) / 100;
  }
  const nonHeroCap = text.match(/对非英雄单位最多造成\s*(\d+(?:\.\d+)?)点/);
  if (nonHeroCap) skill.nonHeroDamageCap = Number(nonHeroCap[1]);
  return require('./equipment-active-geometry').apply(item,skill,{rangeFormula:!!rangeFormula});
}

function install(hero) {
  for (const key of Object.keys(hero.skills || {})) if (hero.skills[key]?.equipment && hero.skills[key].id !== 6146) delete hero.skills[key];
  const byId = new Map();
  for (const e of hero.loadout?.slots || []) {
    const item = catalog.get(e?.itemId); if (!item || item.exclusive || (!item.activeSkill && ![27052, 27060].includes(item.id) && !generatedArtifact(item)) || item.activeSkill === 6146) continue;
    const parsed=skillFor(item,e); if(!parsed||parsed.unsupportedNative||!Number.isInteger(parsed.id)||parsed.id<=0||parsed.id>65535)continue;
    // 64322 levels 1..4 are distinct artifact effects, with shared native CD. Keep
    // level-one keys stable for existing passive hooks such as Genesis.
    const skillKey=parsed.level===1?parsed.id:`${parsed.id}:level:${parsed.level}`;
    const skill = byId.get(skillKey) || parsed;
    const equipmentRate = (hero.passives?.generic || []).flatMap(x => x.effects || [])
      .filter(effect => effect.type === 'equipmentCooldownRate')
      .reduce((sum, effect) => sum + Number(effect.amount || 0), 0);
    skill.baseCooldown = skill.baseCooldown ?? skill.cooldown;
    // Keep the instance enhancement formula before the equipment-wide rate.
    // Duplicate sources reuse this value, so the rate is applied only once.
    skill.enhancedCooldown ??= skill.cooldown;
    skill.cooldown = Math.max(0, skill.enhancedCooldown * (1 - Math.min(100, equipmentRate) / 100));
    byId.set(skillKey, skill); skill.sourceItemIds = [...new Set([...(skill.sourceItemIds || []), item.id])];
  }
  for (const [id, skill] of byId) {
    const slot=`equipment:${id}`;hero.skills[slot]=skill;
    if(hero.cooldowns&&hero.cooldowns[skill.cooldownKey]!==undefined)hero.cooldowns[slot]=hero.cooldowns[skill.cooldownKey];
  }
  return byId;
}

module.exports = { skillFor, install, cooldown };
