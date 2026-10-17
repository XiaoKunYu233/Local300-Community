'use strict';

// The client keeps the equipment rules in item_item/item_armour rather than in
// a small server side table.  This module presents that data in a stable shape
// so battle, lobby and crafting code can share it.  Text effects are parsed
// conservatively: a parsed effect is always additive and never replaces the
// exact rules in equipment-passives.js.
const itemRows = new Map(require('../data/current-client/item_item.json').map(row => [Number(row[1]), row]));
const armourRows = new Map(require('../data/current-client/item_armour.json').map(row => [Number(row[1]), row]));
for (const row of require('./logs/cfg/item_item.json')) if (!itemRows.has(Number(row[1]))) itemRows.set(Number(row[1]), row);
for (const row of require('./logs/cfg/item_armour.json')) if (!armourRows.has(Number(row[1]))) armourRows.set(Number(row[1]), row);

const baseColumns = {
  2: [30, 127], 3: [24], 4: [15], 5: [42], 6: [31, 128], 7: [44],
  8: [14], 9: [18], 10: [25], 11: [1, 8], 12: [2, 9], 13: [100],
  14: [17], 15: [12], 16: [13], 17: [97], 18: [98], 19: [99],
  25: [106], 26: [107], 27: [108], 28: [109], 31: [129],
};
const exclusive = /专属|仅限(?:选择|英雄)|只限(?:选择|英雄)|限定：[^\n]*(?:英雄|角色)/i;
const clean = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\\n/g, '\n');
const firstNumber = text => {
  const m = String(text).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
};
const add = (attrs, id, value) => {
  if (!Number.isFinite(value) || !value) return;
  attrs[id] = (attrs[id] || 0) + value;
};

function staticAttributes(desc) {
  const text = clean(desc), attrs = {};
  // Only parse explicit, standalone bonuses.  Formula terms such as 0.5AD
  // belong to an on-hit/active effect and must not become base attributes.
  const rules = [
    [/法术强度\s*[+＋](\d+(?:\.\d+)?)/g, 31],
    [/(?:攻击力|物理攻击)\s*[+＋](\d+(?:\.\d+)?)/g, 30],
    [/生命(?:值|上限)\s*[+＋](\d+(?:\.\d+)?)(?:点|%)?/g, 8],
    [/法力(?:值|上限)\s*[+＋](\d+(?:\.\d+)?)(?:点|%)?/g, 9],
    [/护甲穿透\s*[+＋](\d+(?:\.\d+)?)(?:%?)/g, 106],
    [/法术穿透\s*[+＋](\d+(?:\.\d+)?)(?:%?)/g, 107],
    [/生命偷取\s*[+＋](\d+(?:\.\d+)?)%/g, 97],
    [/(?:法术吸血|技能吸血)\s*[+＋](\d+(?:\.\d+)?)%/g, 98],
    [/(?:冷却缩减|技能冷却)\s*[+＋](\d+(?:\.\d+)?)%/g, 100],
    [/(?:战斗技能|技能)冷却时间\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)%/g, 100],
    [/(?:生命回复|生命恢复)\s*\/\s*(?:每)?5秒\s*[+＋-]?(\d+(?:\.\d+)?)/g, 12],
    [/(?:法力回复|法力恢复)\s*\/\s*(?:每)?5秒\s*[+＋-]?(\d+(?:\.\d+)?)/g, 13],
    [/攻击速度\s*[+＋](\d+(?:\.\d+)?)%/g, 15],
    [/护甲\s*[+＋](\d+(?:\.\d+)?)(?:点|%)?/g, 42],
    [/(?:魔法抗性|魔抗)\s*[+＋](\d+(?:\.\d+)?)(?:点|%)?/g, 44],
    [/移动速度\s*[+＋](\d+(?:\.\d+)?)%/g, 17],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)%\s*护甲穿透/g, 108],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)%\s*法术穿透/g, 109],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)\s*护甲穿透/g, 106],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)\s*法术穿透/g, 107],
    [/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)\s*护甲穿透/g, 106],
    [/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)\s*法术穿透/g, 107],
    [/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)\s*护甲(?!穿透)/g, 42],
    [/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)\s*(?:魔法抗性|魔抗)/g, 44],
    [/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)%[^\n。；;]*(?:法术强度|AP)/g, 37],
    [/(?:提高|增加|提升)\s*(\d+(?:\.\d+)?)%[^\n。；;]*(?:攻击力|AD)/g, 36],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)%?\s*生命偷取/g, 97],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)%?\s*(?:法术吸血|技能吸血)/g, 98],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)%?\s*冷却缩减/g, 100],
    [/(?<![（(\d])[+＋](\d+(?:\.\d+)?)%?\s*攻击速度/g, 15],
    [/(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)%\s*暴击伤害/g, 25],
    [/(?:暴击伤害)\s*[+＋](\d+(?:\.\d+)?)%/g, 25],
    [/(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)%\s*暴击率/g, 24],
    [/(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)\s*(?:点)?命中/g, 14],
    [/(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)%\s*移动速度/g, 17],
    [/(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)%\s*(?:冷却缩减|技能冷却)/g, 100],
    [/(?:暴击率)\s*[+＋](\d+(?:\.\d+)?)%/g, 24],
    [/(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)\s*(?:攻击距离|射程)/g, 16],
    [/(?:增加|提高|提升)\s*(?:攻击距离|射程)\s*(\d+(?:\.\d+)?)/g, 16],
    [/提供\s*(\d+(?:\.\d+)?)%\s*法术强度/g, 37],
    [/提供\s*(\d+(?:\.\d+)?)%\s*攻击力/g, 36],
    [/提供\s*(\d+(?:\.\d+)?)%\s*护甲穿透/g, 108],
    [/提供\s*(\d+(?:\.\d+)?)%\s*法术穿透/g, 109],
  ];
  for (const [re, id] of rules) for (const m of text.matchAll(re)) {
    // The signed HP/MP forms keep the sign in capture #1; all other rules
    // use their numeric value as capture #1.
    const value = m.length > 2 && /^[+＋-]$/.test(m[1]) ? (m[1] === '-' ? -1 : 1) * Number(m[2]) : Number(m[1]);
    add(attrs, id, value);
  }
  for (const [re, id, sign] of [
    [/法力值上限\s*[+＋]\s*(\d+(?:\.\d+)?)/g, 9, 1], [/法力值上限\s*(?:增加|提高)\s*(\d+(?:\.\d+)?)/g, 9, 1], [/法力值上限\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)/g, 9, -1],
    [/生命值上限\s*[+＋]\s*(\d+(?:\.\d+)?)/g, 8, 1], [/生命值上限\s*(?:增加|提高)\s*(\d+(?:\.\d+)?)/g, 8, 1], [/生命值上限\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)/g, 8, -1],
  ]) for (const m of text.matchAll(re)) add(attrs, id, sign * Number(m[1]));
  for (const [re, id, sign] of [
    [/(?:生命回复|生命恢复)\s*\/\s*(?:每)?5秒\s*(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)/g, 12, 1],
    [/(?:生命回复|生命恢复)\s*\/\s*(?:每)?5秒\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)/g, 12, -1],
    [/(?:法力回复|法力恢复)\s*\/\s*(?:每)?5秒\s*(?:增加|提高|提升)\s*(\d+(?:\.\d+)?)/g, 13, 1],
    [/(?:法力回复|法力恢复)\s*\/\s*(?:每)?5秒\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)/g, 13, -1],
  ]) for (const m of text.matchAll(re)) add(attrs, id, sign * Number(m[1]));
  // These two descriptions are conditional combat effects.  Treating their
  // percentage as a permanent field-17 bonus makes the item stronger while
  // standing in the lobby and loses the client-side disable window.
  if (/提高\s*\d+(?:\.\d+)?%\s*移动速度[^\n。；;]*(?:被攻击失效|范围内有(?:可见的)?敌方英雄时)/.test(text)) delete attrs[17];
  if (/\d+(?:\.\d+)?范围内有(?:可见的)?敌方英雄时[^\n。；;]*(?:提高|增加)\s*\d+(?:\.\d+)?%\s*移动速度/.test(text)) delete attrs[17];
  if (/普通攻击时获得[\s\S]*提高\s*\d+(?:\.\d+)?%\s*移动速度/.test(text)) delete attrs[17];
  if (/装备护甲/.test(text)) delete attrs[42];
  if (/装备(?:魔抗|法术抗性)/.test(text)) delete attrs[44];
  return attrs;
}

function passiveEffects(desc) {
  const text = clean(desc), effects = [];
  // A few ordinary item rules use a combat stat which has no standalone
  // attribute column in the wire schema.  Keep them as explicit effects so
  // the battle runtime can apply them without pretending they are base stats.
  const crit = text.match(/(\d+(?:\.\d+)?)%\s*概率[^\n。；;]*(?:法术|魔法)暴击[^\n。；;]*(?:暴击伤害为|伤害为)\s*(\d+(?:\.\d+)?)%/);
  if (crit) effects.push({ type: 'magicCrit', chance: Number(crit[1]), damage: Number(crit[2]), text: crit[0] });
  const armorReduction = text.match(/减少目标\s*(\d+(?:\.\d+)?)\s*点?护甲/);
  if (armorReduction) effects.push({ type: 'onDamageArmorReduction', amount: Number(armorReduction[1]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), text: armorReduction[0] });
  const revive = text.match(/(?:死亡|阵亡)[^\n。；;]*?(\d+(?:\.\d+)?)秒后[^\n。；;]*复活/);
  if (revive) effects.push({ type: 'revive', delay: Number(revive[1] || 0), cooldown: Number((text.match(/冷却时间\s*(\d+(?:\.\d+)?)/) || [])[1] || 0), heal: Number((text.match(/恢复\s*(\d+(?:\.\d+)?)\s*生命/) || [])[1] || 0), text: revive[0] });
  const reviveFormula = text.match(/死亡后原地复活，并恢复\s*(\d+(?:\.\d+)?)%\s*\+\s*[（(](\d+(?:\.\d+)?)%\s*\*\s*装备等级[）)]\s*生命值和法力值/);
  if (reviveFormula) {
    const cd=text.match(/冷却时间\s*[（(]\s*(\d+(?:\.\d+)?)\s*-\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)[）)]\s*秒/);
    effects.push({ type: 'revive', delay: 0, cooldown: cd ? Number(cd[1]) : 300, cooldownPerLevel: cd ? Number(cd[2]) : 0, healRatioBase: Number(reviveFormula[1]), healRatioPerLevel: Number(reviveFormula[2]), manaRatioBase: Number(reviveFormula[1]), manaRatioPerLevel: Number(reviveFormula[2]), text: reviveFormula[0] });
  }
  const auraSlow = text.match(/周围\s*(\d+(?:\.\d+)?)\s*范围[^\n。；;]*(?:减少|降低)\s*(\d+(?:\.\d+)?)%?\s*移动速度/);
  if (auraSlow) effects.push({ type: 'auraSlow', radius: Number(auraSlow[1]), slow: Number(auraSlow[2]), text: auraSlow[0] });
  const rootProc = text.match(/造成伤害有\s*(\d+(?:\.\d+)?)%[^\n。；;]*(?:束缚|禁锢|定身)\s*(\d+(?:\.\d+)?)秒/);
  if (rootProc) effects.push({ type: 'onDamageRoot', chance: Number(rootProc[1]), duration: Number(rootProc[2]), text: rootProc[0] });
  // “每秒” effects are scheduled in the dynamic passive tick.  The
  // percentage is intentionally kept separate from the damage aura parser.
  const periodicHeal = text.match(/每(\d+(?:\.\d+)?)秒[^\n。；;]*(?:恢复|回复)\s*(\d+(?:\.\d+)?)%?[^\d\n。；;]{0,12}(生命|生命值|法力值|法力|魔力)/);
  if (periodicHeal) {
    const row = { interval: Number(periodicHeal[1]), ratio: Number(periodicHeal[2]) / 100, text: periodicHeal[0] };
    const hasLife=/生命/.test(text),hasMana=/法力|魔力/.test(text);
    if (hasLife) effects.push({ type: 'periodicHeal', ...row });
    if (hasMana) effects.push({ type: 'periodicMana', ...row, text: hasLife ? `${periodicHeal[0]}法力值` : periodicHeal[0] });
  }
  const regen = text.match(/每秒[^\n。；;]*(?:恢复|回复)\s*(\d+(?:\.\d+)?)%[^\d\n。；;]{0,12}(生命|生命值|法力值|法力|魔力)/);
  if (regen && !effects.some(e => e.type === 'periodicHeal' || e.type === 'periodicMana')) effects.push({ type: /法力|魔力/.test(regen[2]) ? 'periodicMana' : 'periodicHeal', interval: 1, ratio: Number(regen[1]) / 100, text: regen[0] });
  const regenFormula = text.match(/每秒恢复最大生命值的[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)\s*[）)]\s*%/);
  if (regenFormula) effects.push({ type: 'periodicHealFormula', interval: 1, ratioBase: Number(regenFormula[1]), ratioPerLevel: Number(regenFormula[2]), text: regenFormula[0] });
  const nearbyRegen = text.match(/(\d+(?:\.\d+)?)(?:码)?范围内每多一名敌方英雄，额外回复\s*(\d+(?:\.\d+)?)%/);
  if (nearbyRegen) for (const effect of effects) if (effect.type === 'periodicHeal') {
    effect.nearbyRadius = Number(nearbyRegen[1]);
    effect.nearbyRatio = Number(nearbyRegen[2]) / 100;
  }
  const hitSlow = /被攻击时/.test(text) ? null : text.match(/(?:普通攻击|攻击时)[^\n。；;]*?(\d+(?:\.\d+)?)%[^\n。；;]*?(?:降低|减少)[^\d]{0,10}(\d+(?:\.\d+)?)%\s*(?:移动速度|攻速|攻击速度)/);
  if (hitSlow) effects.push({ type: 'onBasicSlow', chance: Number(hitSlow[1]) || 100, slow: Number(hitSlow[2]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 2), attackSpeed: /攻速|攻击速度/.test(hitSlow[0]), text: hitSlow[0] });
  const takenSlow = text.match(/被攻击时有\s*(\d+(?:\.\d+)?)%[^\n。；;]*(?:降低|减少)[^\d]{0,10}(\d+(?:\.\d+)?)%\s*(移动速度|攻击速度|攻速)/);
  if (takenSlow) effects.push({ type: 'onDamagedSlow', chance: Number(takenSlow[1]), slow: Number(takenSlow[2]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), attackSpeed: /攻击速度|攻速/.test(takenSlow[3]), text: takenSlow[0] });
  const appliedSlow = text.match(/普通攻击[^\n。；;]*?(\d+(?:\.\d+)?)%[^\n。；;]*?施加[^\n。；;]*?(\d+(?:\.\d+)?)秒/);
  if (appliedSlow) {
    const slow = text.match(/降低\s*(\d+(?:\.\d+)?)%\s*(移动速度|攻击速度|攻速)/);
    if (slow) effects.push({ type: 'onBasicSlow', chance: Number(appliedSlow[1]), slow: Number(slow[1]), duration: Number(appliedSlow[2]), attackSpeed: /攻击速度|攻速/.test(slow[2]), text: appliedSlow[0] });
  }
  const skillSlow = text.match(/伤害技能[^\n。；;]*(?:施加|造成)[^\n。；;]*(\d+(?:\.\d+)?)秒/);
  if (skillSlow) {
    const slow = text.match(/降低\s*(\d+(?:\.\d+)?)%\s*(移动速度|攻击速度|攻速)/);
    if (slow) effects.push({ type: 'onSkillSlow', chance: 100, slow: Number(slow[1]), duration: Number(skillSlow[1]), attackSpeed: /攻击速度|攻速/.test(slow[2]), text: skillSlow[0] });
  }
  const damageSlow = text.match(/(?:物理|魔法|技能)?伤害[^\n。；;]*(?:对敌人)?[^\n。；;]*(?:施加|造成)[^\n。；;]*(\d+(?:\.\d+)?)秒/);
  if (damageSlow) {
    const slow = text.match(/降低\s*(\d+(?:\.\d+)?)%\s*(移动速度|攻击速度|攻速)/);
    if (slow && !effects.some(e => e.type === 'onSkillSlow' && e.text === damageSlow[0])) effects.push({ type: 'onDamageSlow', chance: 100, slow: Number(slow[1]), duration: Number(damageSlow[1]), attackSpeed: /攻击速度|攻速/.test(slow[2]), text: damageSlow[0] });
  }
  if (/未进入战斗状态\s*\d+(?:\.\d+)?秒后进入隐身/.test(text)) effects.push({ type: 'stealth', delay: Number((text.match(/未进入战斗状态\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 5), text });
  const killGold = text.match(/(?:每次)?击杀(?:非英雄单位|敌方英雄|英雄|玩家)?(?:后)?[^\d\n。；;]{0,12}(\d+)\s*(?:额外)?(?:金钱|金币)/);
  if (killGold) effects.push({ type: 'onKillGold', amount: Number(killGold[1]), heroOnly: /英雄|玩家/.test(killGold[0]) && !/非英雄/.test(killGold[0]), nonHeroOnly: /非英雄/.test(killGold[0]), maxKills: Number((text.match(/击杀\s*(\d+)个(?:非英雄单位|敌方英雄)/) || [])[1] || 0), text: killGold[0] });
  const assistGold = text.match(/每次助攻获得\s*(\d+)\s*(?:额外)?(?:金钱|金币)/);
  if (assistGold) effects.push({ type: 'onAssistGold', amount: Number(assistGold[1]), text: assistGold[0] });
  // Battlefield equipment such as 凤凰羽衣 has separate kill and assist
  // recovery formulas.  Preserve both the lost-HP ratio and the flat amount
  // so the combat hook can evaluate the current enhancement level.
  const killHeal = text.match(/每次击杀敌方英雄[^\n。；;]*?[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*[）)]\s*%已损失生命值\s*[+＋]\s*(\d+)/);
  if (killHeal) effects.push({ type: 'onKillHeal', amount: Number(killHeal[3]), heroOnly: true, lostRatio: Number(killHeal[1]), lostRatioPerLevel: 1 / Number(killHeal[2] || 1), text: killHeal[0] });
  const assistHeal = text.match(/每次获得助攻[^\n。；;]*?[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*[）)]\s*%已损失生命值\s*[+＋]\s*(\d+)/);
  if (assistHeal) effects.push({ type: 'onAssistHeal', amount: Number(assistHeal[3]), heroOnly: true, lostRatio: Number(assistHeal[1]), lostRatioPerLevel: 1 / Number(assistHeal[2] || 1), text: assistHeal[0] });
  const levelGold = text.match(/每次升级获得[^\d]*(?:当前等级\s*\*\s*)?(\d+)\s*的?金钱/);
  if (levelGold) effects.push({ type: 'onLevelGold', amount: Number(levelGold[1]), text: levelGold[0] });
  const periodicGold = text.match(/每\s*(\d+(?:\.\d+)?)秒获得\s*(\d+)\s*金钱/);
  if (periodicGold) effects.push({ type: 'periodicGold', interval: Number(periodicGold[1]), amount: Number(periodicGold[2]), text: periodicGold[0] });
  const outOfCombatSpeed = text.match(/(?:未受到和造成伤害|未(?:造成|受到)伤害)[^\n。；;]{0,20}(?:可|会|则)?[^\n。；;]*(?:增加|提高)\s*(\d+(?:\.\d+)?)%\s*移动速度/);
  if (outOfCombatSpeed) effects.push({ type: 'outOfCombatSpeed', delay: Number((text.match(/(\d+(?:\.\d+)?)秒内未|未[^\n。；;]{0,8}(\d+(?:\.\d+)?)秒/) || [])[1] || 5), speed: Number(outOfCombatSpeed[1]), text: outOfCombatSpeed[0] });
  const outOfCombatSpeedReversed = text.match(/(\d+(?:\.\d+)?)秒内未受到和造成伤害[^\n。；;]*移动速度提高\s*(\d+(?:\.\d+)?)%/);
  if (outOfCombatSpeedReversed) effects.push({ type: 'outOfCombatSpeed', delay: Number(outOfCombatSpeedReversed[1]), speed: Number(outOfCombatSpeedReversed[2]), text: outOfCombatSpeedReversed[0] });
  const nearbyEnemySpeed = text.match(/(\d+(?:\.\d+)?)范围内有(?:可见的)?敌方英雄时[^\n。；;]*(?:增加|提高)\s*(\d+(?:\.\d+)?)%\s*移动速度/);
  if (nearbyEnemySpeed) effects.push({ type: 'nearbyEnemySpeed', radius: Number(nearbyEnemySpeed[1]), speed: Number(nearbyEnemySpeed[2]), text: nearbyEnemySpeed[0] });
  const combatMoveSpeed = text.match(/(?:提高|增加)\s*(\d+(?:\.\d+)?)%\s*移动速度[^\n。；;]*被攻击失效\s*(\d+(?:\.\d+)?)秒/);
  if (combatMoveSpeed) effects.push({ type: 'combatMoveSpeed', speed: Number(combatMoveSpeed[1]), disableAfter: Number(combatMoveSpeed[2]), text: combatMoveSpeed[0] });
  const iteration = text.match(/普通攻击时获得\s*1层[\s\S]*?普通攻击暴击会获得\s*2层[\s\S]*?最多\s*(\d+)层/);
  const iterationStats = text.match(/每(\d+)层提高\s*(\d+)%攻击速度/), formationStats = text.match(/提高\s*(\d+)%移动速度和(\d+)点命中/);
  if (iteration && iterationStats && formationStats) effects.push({ type: 'basicStack', max: Number(iteration[1]), critLayers: 2, perStacks: Number(iterationStats[1]), attackSpeed: Number(iterationStats[2]), maxMoveSpeed: Number(formationStats[1]), maxHit: Number(formationStats[2]), text: `${iteration[0]}；${iterationStats[0]}；${formationStats[0]}` });
  const auraAttackReduction = text.match(/降低周围敌方英雄\s*(\d+(?:\.\d+)?)%攻击力/);
  if (auraAttackReduction) effects.push({ type: 'auraAttackReduction', radius: Number((text.match(/周围(?:\s*)(\d+(?:\.\d+)?)范围/) || [])[1] || 300), amount: Number(auraAttackReduction[1]), heroOnly: true, text: auraAttackReduction[0] });
  const directBasicSlow = text.match(/普通攻击降低目标\s*(\d+(?:\.\d+)?)%(?:（远程(\d+(?:\.\d+)?)%）)?移动速度，持续\s*(\d+(?:\.\d+)?)秒/);
  if (directBasicSlow) effects.push({ type: 'onBasicSlow', chance: 100, slow: Number(directBasicSlow[1]), rangedSlow: directBasicSlow[2]===undefined?null:Number(directBasicSlow[2]), duration: Number(directBasicSlow[3]), text: directBasicSlow[0] });
  const stackBasicSlow = text.match(/普通攻击降低目标（(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)）%移动速度与（(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)）%攻击速度，持续(\d+(?:\.\d+)?)秒，最多可叠加(\d+)层/);
  if (stackBasicSlow) effects.push({ type: 'onBasicStackSlow', slowBase: Number(stackBasicSlow[1]), slowPerLevel: Number(stackBasicSlow[2]), attackSpeedBase: Number(stackBasicSlow[3]), attackSpeedPerLevel: Number(stackBasicSlow[4]), duration: Number(stackBasicSlow[5]), max: Number(stackBasicSlow[6]), meleeLayers: Number((text.match(/近战英雄每次攻击叠加(\d+)层/) || [])[1] || 1), text: stackBasicSlow[0] });
  const weakenAttack = text.match(/对目标造成物理伤害会降低其(\d+(?:\.\d+)?)%（\+([\d.]+)%\*装备等级）攻击力和法术强度，最多叠加(\d+)层，持续(\d+(?:\.\d+)?)秒/);
  if (weakenAttack) effects.push({ type: 'onPhysicalStackDebuff', attackPercentBase: Number(weakenAttack[1]), attackPercentPerLevel: Number(weakenAttack[2]), abilityPowerPercentBase: Number(weakenAttack[1]), abilityPowerPercentPerLevel: Number(weakenAttack[2]), max: Number(weakenAttack[3]), duration: Number(weakenAttack[4]), text: weakenAttack[0] });
  const weakenHit = text.match(/对目标造成物理伤害的同时会降低其(\d+)（\+([\d.]+)\*装备等级）的命中，持续(\d+(?:\.\d+)?)秒/);
  if (weakenHit) effects.push({ type: 'onPhysicalStackDebuff', hitBase: Number(weakenHit[1]), hitPerLevel: Number(weakenHit[2]), max: Number((text.match(/最多叠加(\d+)层/) || [])[1] || 3), duration: Number(weakenHit[3]), text: weakenHit[0] });
  const weakenArmor = text.match(/对目标造成物理伤害会降低其(\d+)\+（装备等级\*(\d+)）护甲，最多叠加(\d+)层，持续(\d+(?:\.\d+)?)秒/);
  if (weakenArmor) effects.push({ type: 'onPhysicalStackDebuff', armorBase: Number(weakenArmor[1]), armorPerLevel: Number(weakenArmor[2]), max: Number(weakenArmor[3]), duration: Number(weakenArmor[4]), text: weakenArmor[0] });
  const weakenDodge = text.match(/对目标造成物理伤害的同时会降低其(\d+)（\+([\d.]+)\*装备等级）的闪避，持续(\d+(?:\.\d+)?)秒/);
  if (weakenDodge) effects.push({ type: 'onPhysicalStackDebuff', dodgeBase: Number(weakenDodge[1]), dodgePerLevel: Number(weakenDodge[2]), max: Number((text.match(/最多叠加(\d+)层/) || [])[1] || 3), duration: Number(weakenDodge[3]), text: weakenDodge[0] });
  const auraFlat = text.match(/(?:战斗状态下，)?每秒对周围敌人造成[（(]\s*(\d+)\s*\+\s*(\d+)%装备护甲\s*\+\s*(\d+)%装备魔抗\s*[）)]\s*(?:点)?(?:法术|魔法)伤害/);
  if (auraFlat) effects.push({ type: 'auraDamage', radius: Number((text.match(/(\d+)范围/) || [])[1] || 300), amount: Number(auraFlat[1]), armorRatio: Number(auraFlat[2])/100, magicResistanceRatio: Number(auraFlat[3])/100, damageType: 'magic', text: auraFlat[0] });
  const auraSimple = text.match(/(?:战斗状态下，)?每秒对周围敌人造成\s*(\d+)(?:点)?(?:法术|魔法)伤害/);
  if (auraSimple && !auraFlat) effects.push({ type: 'auraDamage', radius: Number((text.match(/(\d+)范围/) || [])[1] || 300), amount: Number(auraSimple[1]), damageType: 'magic', text: auraSimple[0] });
  const auraEnhancement = text.match(/每秒对周围敌人造成[\s\S]*?并\s*(\d+(?:\.\d+)?)秒\s*(\d+(?:\.\d+)?)%易伤，最多\s*(\d+)层[\s\S]*?并回复\s*(\d+(?:\.\d+)?)%[（(]非英雄为\s*(\d+(?:\.\d+)?)%[）)]该伤害值/);
  if (auraEnhancement) {
    const aura = effects.find(effect => effect.type === 'auraDamage' && effect.text && /每秒对周围敌人/.test(effect.text));
    if (aura) Object.assign(aura, { vulnerabilityDuration: Number(auraEnhancement[1]), vulnerabilityPerStack: Number(auraEnhancement[2]), vulnerabilityMax: Number(auraEnhancement[3]), healRatio: Number(auraEnhancement[4]) / 100, nonHeroHealRatio: Number(auraEnhancement[5]) / 100, nonHeroBonus: 50 });
  }
  const manaRestore = text.match(/(?:伤害敌人|对英雄造成伤害|被英雄造成伤害)[^\n。；;]*(?:回复|恢复)伤害值\s*(\d+(?:\.\d+)?)%[^\n。；;]*法力/);
  if (manaRestore) effects.push({ type: 'damageMana', ratio: Number(manaRestore[1]) / 100, text: manaRestore[0] });
  const grievous = text.match(/伤害敌人时[^\n。；;]*(?:施加|造成)\s*(\d+(?:\.\d+)?)秒\s*(\d+(?:\.\d+)?)%?\s*重伤/);
  if (grievous) effects.push({ type: 'grievous', duration: Number(grievous[1]), amount: Number(grievous[2]), text: grievous[0] });
  const mrHit = text.match(/普通攻击[^\n。；;]*(?:降低|减少)敌人\s*(\d+(?:\.\d+)?)\s*魔抗/);
  if (mrHit) effects.push({ type: 'onBasicMRReduction', amount: Number(mrHit[1]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), text: mrHit[0] });
  const mrSkill = text.match(/技能伤害[^\n。；;]*(?:降低|减少)敌人\s*(\d+(?:\.\d+)?)%?\s*魔抗/);
  if (mrSkill) effects.push({ type: 'onSkillMRReduction', amount: Number(mrSkill[1]), percent: /%/.test(mrSkill[0]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 4), text: mrSkill[0] });
  const auraRegen = text.match(/周围友军[^\n。；;]*?\+\s*(\d+)\s*生命恢复\s*\/\s*(\d+)秒/);
  if (auraRegen) effects.push({ type: 'auraRegen', radius: Number((text.match(/周围(?:友军|友方)[^\d]*(\d+)范围/) || [])[1] || 800), amount: Number(auraRegen[1]), interval: Number(auraRegen[2]), text: auraRegen[0] });
  const auraArmor = text.match(/(?:提高|增加)?周围友方英雄\+?\s*(\d+)\s*护甲[^\n。；;]*?(?:、|和)\s*(\d+)\s*魔抗/);
  if (auraArmor) effects.push({ type: 'auraStats', radius: Number((text.match(/周围(?:友方|友军)[^\d]*(\d+)范围/) || [])[1] || 800), armor: Number(auraArmor[1]), magicResistance: Number(auraArmor[2]), text: auraArmor[0] });
  const auraMove = text.match(/(?:增加|提高)自身周围友方英雄\s*(\d+(?:\.\d+)?)%\s*(?:的)?\s*移动速度/);
  if (auraMove) effects.push({ type: 'auraMoveSpeed', radius: Number((text.match(/周围友方英雄[^\d]*(\d+)范围/) || [])[1] || 800), speed: Number(auraMove[1]), text: auraMove[0] });
  const facingAura = text.match(/周围所有面对自己的敌方英雄降低\s*(\d+(?:\.\d+)?)%\s*攻击力和法术强度[^\n。；;]*?背对自己的敌人减少\s*(\d+(?:\.\d+)?)%\s*护甲和法术抗性/);
  if (facingAura) effects.push({ type: 'auraFacingDebuff', heroOnly: true, radius: 900, facingAttack: Number(facingAura[1]), facingPower: Number(facingAura[1]), backArmor: Number(facingAura[2]), backMagicResistance: Number(facingAura[2]), text: facingAura[0] });
  const auraEnemy = text.match(/降低附近敌方英雄魔法抗性,?护甲各\s*(\d+)\s*点[^\n。；;]*?(?:以及|和)\s*(\d+)%\s*移动速度/);
  if (auraEnemy) effects.push({ type: 'auraEnemyDebuff', heroOnly: true, radius: Number((text.match(/附近敌方英雄[^\d]*(\d+)范围/) || [])[1] || 800), armor: Number(auraEnemy[1]), magicResistance: Number(auraEnemy[1]), slow: Number(auraEnemy[2]), text: auraEnemy[0] });
  const resistToStats = text.match(/法术抗性的\s*(\d+(?:\.\d+)?)%\s*转化为攻击力，\s*(\d+(?:\.\d+)?)%\s*转化为法术强度/);
  if (resistToStats) effects.push({ type: 'resistToStats', attackRatio: Number(resistToStats[1]) / 100, abilityPowerRatio: Number(resistToStats[2]) / 100, text: resistToStats[0] });
  const healingReceived = text.match(/(?:受到的治疗效果|所受治疗效果)(?:(?:增加|提高)\s*)?(\d+(?:\.\d+)?)%/);
  if (healingReceived) effects.push({ type: 'healingReceived', amount: Number(healingReceived[1]), text: healingReceived[0] });
  const skillTrueBurn = text.match(/伤害技能会使敌人在(\d+(?:\.\d+)?)秒内持续受到真实伤害，总伤害值为你对其所造成技能伤害结算抗性前(\d+(?:\.\d+)?)%/);
  if (skillTrueBurn) effects.push({ type: 'onSkillTrueBurn', duration: Number(skillTrueBurn[1]), ratio: Number(skillTrueBurn[2]) / 100, text: skillTrueBurn[0] });
  const basicReduction = text.match(/(?:所受非建筑的普通攻击伤害降低|降低受到非建筑普通攻击的伤害)\s*(\d+)%/);
  if (basicReduction) effects.push({ type: 'basicDamageReduction', amount: Number(basicReduction[1]), text: basicReduction[0] });
  const percentResist = text.match(/(?:护甲和法术抗性|护甲、魔抗|双抗)提高\s*(\d+(?:\.\d+)?)%/);
  if (percentResist) effects.push({ type: 'percentResist', amount: Number(percentResist[1]), text: percentResist[0] });
  // Incoming conditional damage rules must never become an output penalty.
  // In particular, 疾行靴 Plus says "移动过程中受到伤害降低10%".
  const movingReduction = text.match(/移动(?:过程)?(?:中|时)\s*受到(?:的)?伤害\s*(?:减少|降低|减免)\s*(\d+(?:\.\d+)?)%/);
  if (movingReduction) effects.push({ type: 'movingDamageReduction', amount: Number(movingReduction[1]), text: movingReduction[0] });
  const selfReduction = text.match(/造成(?:的)?(?:所有)?伤害\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)%/);
  if (selfReduction) effects.push({ type: 'selfDamageReduction', amount: Number(selfReduction[1]), text: selfReduction[0] });
  const combatStack = text.match(/与英雄战斗时[\s\S]*?每(\d+(?:\.\d+)?)秒提高(\d+(?:\.\d+)?)%造成伤害[\s\S]*?最多(\d+)层/);
  if (combatStack) effects.push({ type: 'combatDamageStack', interval: Number(combatStack[1]), amount: Number(combatStack[2]), max: Number(combatStack[3]), text: combatStack[0] });
  if (/普通攻击不会被闪避/.test(text)) effects.push({ type: 'alwaysHit', text: '普通攻击不会被闪避' });
  const highDamageMitigation = text.match(/受到高于(\d+(?:\.\d+)?)的伤害时[\s\S]*?(?:减免|减少)(\d+(?:\.\d+)?)%伤害[\s\S]*?(\d+(?:\.\d+)?)秒后受到减免值的真实伤害/);
  if (highDamageMitigation) effects.push({ type: 'delayedDamageReduction', threshold: Number(highDamageMitigation[1]), amount: Number(highDamageMitigation[2]), delay: Number(highDamageMitigation[3]), text: highDamageMitigation[0] });
  const trauma = text.match(/普通攻击可以让目标获得创伤状态[\s\S]*?受到的治疗效果减少(\d+(?:\.\d+)?)%[\s\S]*?生命恢复减少(\d+(?:\.\d+)?)%[\s\S]*?减少其(\d+(?:\.\d+)?)%法术强度/);
  if (trauma) effects.push({ type: 'onBasicTrauma', healingReduction: Number(trauma[1]), lifeStealReduction: Number(trauma[2]), abilityPowerReduction: Number(trauma[3]), duration: Number((text.match(/持续(\d+(?:\.\d+)?)秒/) || [])[1] || 5), text: trauma[0] });
  const rangedDamage = text.match(/对(\d+)范围外的敌人造成的魔法伤害提高(\d+(?:\.\d+)?)%/);
  if (rangedDamage) effects.push({ type: 'rangeDamageBonus', radius: Number(rangedDamage[1]), amount: Number(rangedDamage[2]), damageType: 'magic', text: rangedDamage[0] });
  const equipmentCooldown = text.match(/所有装备主动技能的冷却时间\s*(?:减少|降低)\s*(\d+(?:\.\d+)?)%/);
  if (equipmentCooldown) effects.push({ type: 'equipmentCooldownRate', amount: Number(equipmentCooldown[1]), text: equipmentCooldown[0] });
  const manaGrowth = text.match(/每分钟(?:额外)?增加\s*(\d+)点最大法力值[^\n。；;]*最多增加\s*(\d+)/);
  if (manaGrowth) effects.push({ type: 'maxManaGrowth', amount: Number(manaGrowth[1]), cap: Number(manaGrowth[2]), interval: 60, text: manaGrowth[0] });
  const critDamage = text.match(/提高（?\s*1\s*\*\s*暴击率\s*）?暴击伤害[^\n。；;]*(?:上限\s*(\d+)%)/);
  if (critDamage) effects.push({ type: 'critDamagePerCrit', ratio: 1, cap: Number(critDamage[1]), text: critDamage[0] });
  if (/每损失1%法力值[^\n。；;]*(?:增加|提高)1%法力回复/.test(text)) effects.push({ type: 'manaMissingRegen', text });
  const cooldownCap = text.match(/(?:冷却缩减|冷却时间)上限增加\s*(\d+(?:\.\d+)?)%?/);
  if (cooldownCap) effects.push({ type: 'cooldownCapBonus', amount: Number(cooldownCap[1]), text: cooldownCap[0] });
  const allyHealBuff = text.match(/对其他友方目标释放治疗后[^\n。；;]*增加其\s*(\d+)%\+?(\d+)\s*(攻击力|法术强度)/);
  if (allyHealBuff) effects.push({ type: 'onAllyHealBuff', percent: Number(allyHealBuff[1]), flat: Number(allyHealBuff[2]), attr: /法术强度/.test(allyHealBuff[3]) ? 31 : 30, duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), text: allyHealBuff[0] });
  if (/被时停、压制、眩晕、击飞时/.test(text)) {
    const defense = text.match(/每0\.2秒增加\s*(\d+)点双抗[^\n。；;]*最多提高\s*(\d+)点/);
    effects.push({ type: 'onControlDefense', amount: Number(defense?.[1] || 5), max: Number(defense?.[2] || 30), duration: 1, text });
  }
  const towerAura = text.match(/中塔的效果为\s*(\d+)双抗，内塔为\s*(\d+)双抗，本阵塔为\s*(\d+)双抗/);
  if (towerAura) effects.push({ type: 'towerAuraDefense', middle: Number(towerAura[1]), inner: Number(towerAura[2]), base: Number(towerAura[3]), text: towerAura[0] });
  const penStack = text.match(/每次普通攻击获得\s*(\d+)\s*护甲穿透[^\n。；;]*最多(\d+)层/);
  if (penStack) effects.push({ type: 'onBasicPenStack', amount: Number(penStack[1]), max: Number(penStack[2]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), text: penStack[0] });
  const combatRegen = text.match(/(?:攻击或受到敌方英雄伤害时)[^\n。；;]*?(\d+)生命回复\s*\/\s*(\d+)秒[^\n。；;]*?(\d+)法力恢复\s*\/\s*(\d+)秒/);
  if (combatRegen) effects.push({ type: 'combatRegen', hp: Number(combatRegen[1]), hpInterval: Number(combatRegen[2]), mp: Number(combatRegen[3]), mpInterval: Number(combatRegen[4]), duration: Number((text.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), text: combatRegen[0] });
  const killStack = text.match(/击杀或助攻获得叠加状态[^\n。；;]*击杀\s*(\d+)层助攻\s*(\d+)层[^\n。；;]*每层状态增加\s*(\d+)点\s*(法术强度|生命值)[^\n。；;]*最多叠加\s*(\d+)层/);
  if (killStack) effects.push({ type: 'onKillStack', killLayers: Number(killStack[1]), assistLayers: Number(killStack[2]), amount: Number(killStack[3]), attr: /法术强度/.test(killStack[4]) ? 31 : 8, max: Number(killStack[5]), text: killStack[0] });
  const levelPen = text.match(/增加（?\s*(\d+)\s*\+\s*强化等级\s*）?%固定法术穿透/);
  if (levelPen) effects.push({ type: 'levelAttribute', attr: 107, amount: Number(levelPen[1]), perLevel: 1, text: levelPen[0] });
  const onBasic = /普通攻击[^\n。；;]*(?:附带|附加|造成)[^\n。；;]*/g;
  for (const sentence of text.match(onBasic) || []) {
    const m = sentence.match(/(?:附带|附加|造成)[^\d]*(\d+(?:\.\d+)?)[^\n。；;]*?(物理|魔法|真实)?伤害/);
    if (!m) continue;
    const percent = /目标当前生命值|生命上限/.test(sentence) ? (sentence.match(/(\d+(?:\.\d+)?)%/) || [])[1] : null;
    const placeholders = [...sentence.matchAll(/\{~(\d+)\*0*(\d+(?:\.\d+))\}/g)].map(match => ({ attr: Number(match[1]), ratio: Number(match[2]) }));
    const placeholderScale = placeholders[0];
    const scale = sentence.match(/(\d+(?:\.\d+)?)%[^\n。；;]*(?:装备魔抗|魔抗)/) || sentence.match(/(\d+(?:\.\d+)?)%[^\n。；;]*(?:法术强度|AP)/) || sentence.match(/(\d+(?:\.\d+)?)%[^\n。；;]*(?:攻击力|AD)/);
    const attr = placeholderScale ? placeholderScale.attr : scale && /魔抗/.test(scale[0]) ? 44 : scale && /(?:法术强度|AP)/.test(scale[0]) ? 31 : scale ? 30 : 0;
    const scaling = placeholderScale || (scale ? { attr, ratio: Number(scale[1]) / 100 } : null);
    const targetLevel = sentence.match(/目标最大生命值[^\n。；;]*强化等级\s*\*\s*(\d+(?:\.\d+)?)%/);
    const fixedPen = sentence.match(/[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*强化等级\s*\*\s*(\d+(?:\.\d+)?)\s*[）)]\s*%固定护甲穿透值/);
    const procCooldown = sentence.match(/冷却时间\s*(\d+(?:\.\d+)?)秒/) || sentence.match(/(\d+(?:\.\d+)?)秒内(?:只)?(?:会)?触发/);
    const flatAfterScale = sentence.match(/(?:法术强度|AP)\s*[+＋]\s*(\d+(?:\.\d+)?)/);
    effects.push({ type: 'onBasic', amount: fixedPen ? 0 : Number(flatAfterScale?.[1] || m[1]), damageType: /真实伤害/.test(sentence) ? 'true' : /(?:法术|魔法)伤害/.test(sentence) || m[2] === '魔法' ? 'magic' : m[2] === '真实' ? 'true' : 'physical', targetHealthPercent: percent ? Number(percent) : 0,
      targetHealthPercentPerLevel: targetLevel ? Number(targetLevel[1]) : 0,
      fixedPenRatio: fixedPen ? Number(fixedPen[1]) / 100 : 0,
      fixedPenRatioPerLevel: fixedPen ? Number(fixedPen[2]) / 100 : 0,
      cooldown: Number(procCooldown?.[1] || 0),
      scaling, scalings: placeholders.length > 1 ? placeholders : undefined, chance: ((sentence.match(/(\d+(?:\.\d+)?)%概率/) || [])[1] || 100) * 1, text: sentence });
  }
  for (const sentence of text.split(/[\n。；;]/)) {
    const auraFlat = sentence.match(/每秒对周围(?:的)?单位造成[（(]\s*(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)\s*\*\s*装备等级\s*\+\s*(\d+(?:\.\d+)?)%\s*法抗物抗总和[）)]\s*点?法术伤害/);
    if (auraFlat) effects.push({ type: 'auraDamage', radius: Number((sentence.match(/(\d+(?:\.\d+)?)\s*范围/) || [])[1] || 5), amount: Number(auraFlat[1]), levelAmount: Number(auraFlat[2]), resistanceRatio: Number(auraFlat[3]) / 100, damageType: 'magic', text: sentence });
    const periodic = sentence.match(/每秒[^\n。；;]*(?:造成|附带)[^\d]*(\d+(?:\.\d+)?)%[^\n。；;]*(?:最大生命|生命上限)[^\n。；;]*(?:伤害)/);
    if (periodic) effects.push({ type: 'auraDamage', radius: Number((sentence.match(/(\d+(?:\.\d+)?)\s*(?:范围|距离)/) || [])[1] || 5), ratio: Number(periodic[1]) / 100, damageType: /魔法/.test(sentence) ? 'magic' : 'physical', text: sentence });
    const dot = sentence.match(/(?:普通攻击|近战(?:攻击)?|攻击)[^\n。；;]*每秒[^\n。；;]*(?:造成|附带)[^\d]*(\d+(?:\.\d+)?)%?[^\n。；;]*(?:攻击力|AD|法术强度|AP|最大生命值)[^\n。；;]*(?:伤害)/);
    if (dot) {
      const scale = sentence.match(/(\d+(?:\.\d+)?)%?[^\n。；;]*(攻击力|AD|法术强度|AP|最大生命值)/);
      const attr = scale && /(?:法术强度|AP)/.test(scale[2]) ? 31 : scale && /最大生命值/.test(scale[2]) ? 8 : 30;
      effects.push({ type: 'onBasicDot', amount: 0, duration: Number((sentence.match(/持续\s*(\d+(?:\.\d+)?)秒/) || [])[1] || 3), interval: 1, damageType: /魔法/.test(sentence) ? 'magic' : /真实/.test(sentence) ? 'true' : 'physical', scaling: scale ? { attr, ratio: Number(scale[1]) / 100 } : null, chance: Number((sentence.match(/(\d+(?:\.\d+)?)%概率/) || [])[1] || 100), text: sentence });
    }
    // Do not treat “攻击速度/攻击者” in an active description as a basic
    // attack trigger.  The old broad match turned active-only damage into a
    // permanent passive onSkill/onBasic proc.
    const hasAttack = /普通攻击|近战攻击|攻击(?:时|造成|附带|可以|会)/.test(sentence);
    const chance = Number((sentence.match(/(\d+(?:\.\d+)?)%概率/) || [])[1] || 0);
    const damage = sentence.match(/(?:造成|附带|附加)[^\d]*(\d+(?:\.\d+)?)[^\n。；;]*(?:物理|魔法|真实)?伤害/);
    if ((chance || hasAttack) && damage && !effects.some(effect => (effect.type === 'onBasic' || effect.type === 'onBasicDot') && (effect.text === sentence || effect.text.includes(sentence) || sentence.includes(effect.text)))) {
      const scale = sentence.match(/(\d+(?:\.\d+)?)%?\s*(?:装备)?(攻击力|AD|法术强度|AP|最大生命值)/);
      const attr = scale && /(?:法术强度|AP)/.test(scale[2]) ? 31 : scale && /最大生命值/.test(scale[2]) ? 8 : 30;
      const procCooldown = sentence.match(/冷却时间\s*(\d+(?:\.\d+)?)秒/) || sentence.match(/(\d+(?:\.\d+)?)秒内(?:只)?(?:会)?触发/);
      effects.push({ type: /技能|法术/.test(sentence) ? 'onSkill' : 'onBasic', amount: Number(damage[1]) || 0,
        damageType: /(?:法术|魔法)伤害/.test(sentence) ? 'magic' : /真实伤害/.test(sentence) ? 'true' : 'physical',
        cooldown: Number(procCooldown?.[1] || 0),
        scaling: scale ? { attr, ratio: Number(scale[1]) / 100 } : null, chance: chance || 100, text: sentence });
    }
    if (/造成伤害/.test(sentence) && /束缚|禁锢|定身/.test(sentence)) {
      const m = sentence.match(/(\d+(?:\.\d+)?)%[^\n。；;]*(?:束缚|禁锢|定身)\s*(\d+(?:\.\d+)?)秒/);
      if (m && !effects.some(e => (e.type === 'onDamageRoot' || e.type === 'onSkillRoot') && e.chance === Number(m[1]) && e.duration === Number(m[2]))) effects.push({ type: /技能|法术/.test(sentence) ? 'onSkillRoot' : 'onDamageRoot', chance: Number(m[1]), duration: Number(m[2]), text: sentence });
    }
    if (/受到普通攻击/.test(sentence) && /反击|反弹/.test(sentence)) {
      const armorScale = Number((sentence.match(/[+＋](\d+(?:\.\d+)?)%[^\n。；;]*护甲/) || [])[1] || 0);
      effects.push({ type: 'onDamagedBasic', amount: firstNumber(sentence), ratio: Number((sentence.match(/(\d+(?:\.\d+)?)%[^\d]*(?:结算|伤害)/) || [])[1] || 0), scaling: armorScale ? { attr: 42, ratio: armorScale / 100 } : null });
    }
    if (/低于\s*(\d+(?:\.\d+)?)%[^\n。；;]*获得/.test(sentence) && /护盾/.test(sentence)) {
      const threshold = Number(sentence.match(/低于\s*(\d+(?:\.\d+)?)%/)[1]);
      const after = sentence.split(/获得/).slice(1).join('获得');
      const first = after.match(/^[^\d]*(\d+(?:\.\d+)?)(%?)/);
      effects.push({ type: 'lowHealthShield', threshold, amount: first && first[2] !== '%' ? Number(first[1]) : 0, ratio: Number((after.match(/(\d+(?:\.\d+)?)%[^\n。；;]*护盾/) || [])[1] || 0) });
    }
    if (/击杀|杀死/.test(sentence) && /回复|恢复/.test(sentence)) {
      const amount = firstNumber(sentence);
      if (/法力|魔法值|MP/.test(sentence)) effects.push({ type: 'onKillMana', amount, text: sentence });
      else if (/生命|HP/.test(sentence) && !effects.some(effect => effect.type === 'onKillHeal' && effect.lostRatio !== undefined)) effects.push({ type: 'onKillHeal', amount, text: sentence });
    }
  }
  return effects;
}

function entry(itemId) {
  const id = Number(itemId), row = itemRows.get(id), armour = armourRows.get(id);
  if (!row) return null;
  const desc = String(row[24] || ''), text = clean(desc), activeSkill = Number(armour?.[29] || 0);
  const effects=passiveEffects(desc);
  const battlefieldOnly=/永恒战场专用/.test(text);
  for(const effect of effects){effect.source='catalog';effect.battlefieldOnly=battlefieldOnly;}
  // A shared native passive/skill ID is the client's canonical family key.
  // Several item rows repeat the same passive with different numbers and
  // explicitly say that it cannot stack with another equipment effect.
  // Preserve that family on the parsed effect so battle aggregation can pick
  // one implementation instead of executing the same hook multiple times.
  for(const effect of effects){
    if(/不与(?:其他)?装备(?:效果)?叠加|多件装备.*(?:取最高|只触发最高)|唯一限制.*(?:多件|最高)/.test(effect.text||''))
      effect.stackGroup=`native:${activeSkill||effect.type}`;
    else if(activeSkill&&/蓄力一击/.test(text)&&['onBasic','onBasicDot'].includes(effect.type))
      effect.stackGroup=`native:${activeSkill}`;
  }
  return {
    id, name: String(row[23] || `装备${id}`), type: String(row[10] || ''), quality: Number(row[55] || 0),
    desc, text, exclusive: exclusive.test(text), activeSkill: Number.isInteger(activeSkill) ? activeSkill : 0,
    activeLevel: Number(armour?.[30] || 0), base: Object.fromEntries(Object.entries(baseColumns).map(([column, ids]) => ids.map(attr => [attr, Number(armour?.[column] ?? row[column]) || 0])).flat()),
    attributes: staticAttributes(desc), effects, row, armour,
  };
}

const cache = new Map();
function get(itemId) { const id = Number(itemId); if (!cache.has(id)) cache.set(id, entry(id)); return cache.get(id); }
function all({includeExclusive = false} = {}) {
  return [...itemRows.keys()].map(get).filter(Boolean).filter(e => includeExclusive || !e.exclusive);
}
function battlefield({includeExclusive = false} = {}) {
  return all({includeExclusive}).filter(e => ['armour', 'weapon', 'treasure', 'magicgemequip', 'equip'].includes(e.type) || e.activeSkill > 0);
}

module.exports = { get, all, battlefield, clean, staticAttributes, passiveEffects, itemRows, armourRows, isHeroExclusive: value => exclusive.test(clean(value)) };
