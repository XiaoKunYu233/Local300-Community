'use strict';
const path = require('path');
const { RuneState } = require('./rune-system');
const { MagicGemState } = require('./magic-gem-system');
const { WarSoulState } = require('./war-soul');
const { EquipmentCrafting } = require('./equipment-crafting');

// One account-scoped façade for the four progression systems.  The individual
// modules remain usable in isolation for lobby tests, while battle/session code
// can ask for one immutable attribute map when a loadout is assembled.
class ProgressionSystems {
  constructor({ directory = __dirname, random = Math.random } = {}) {
    this.rune = new RuneState({ file: path.join(directory, 'rune-state.json'), random });
    this.magicGem = new MagicGemState({ file: path.join(directory, 'magic-gem-state.json'), random });
    this.warSoul = new WarSoulState({ file: path.join(directory, 'war-soul-state.json'), random });
    this.crafting = new EquipmentCrafting({ file: path.join(directory, 'equipment-crafting-state.json'), random });
  }
  activeWarSoulUnits(page = this.warSoul.state.currentPage) {
    const target = this.warSoul.state.pages[Number(page) || 0];
    return Object.entries(this.warSoul.state.units || {})
      .map(([key, unit]) => ({ key, unit, unitId: Number(unit.unitId), category: Number(unit.category || 1) }))
      .filter(row => Number(target?.levels?.[row.key] || 0) > 0);
  }

  bonusSources({ runePage = this.rune.state.currentPage, deviceGuid = null, deviceGuids = null, warSoulUnitId = 0, warSoulSetId = 1, warSoulPage = this.warSoul.state.currentPage } = {}) {
    const sources = { rune: {}, magicDevice: {}, warSoul: {} }; let out = sources.rune;
    const merge = value => { for (const [id, amount] of Object.entries(value || {})) out[id] = (out[id] || 0) + Number(amount || 0); };
    merge(this.rune.combatBonus(runePage));
    out = sources.magicDevice;
    for (const id of [...new Set([...(deviceGuids || []), ...(deviceGuid ? [deviceGuid] : [])])]) merge(this.magicGem.combatBonus(id));
    out = sources.warSoul;
    if (warSoulUnitId) merge(this.warSoul.combatBonus(warSoulUnitId, warSoulSetId, warSoulPage));
    else for (const { unitId, category, unit } of this.activeWarSoulUnits(warSoulPage)) {
      const active = Object.entries(unit?.entries || {}).find(([, entry]) => entry?.active);
      merge(this.warSoul.combatBonus(unitId, active ? Number(active[0]) : 1, warSoulPage, category));
    }
    return sources;
  }
  bonuses(options = {}) { return require('./attribute-math').addSources(...Object.values(this.bonusSources(options))); }
  magicGemEffects({ deviceGuid = null, deviceGuids = null } = {}) { const effects = []; for (const id of [...new Set([...(deviceGuids || []), ...(deviceGuid ? [deviceGuid] : [])])]) effects.push(...this.magicGem.setEffects(id)); return effects.map(require('./battle-magic-gem-rules').normalize); }
  warSoulEffects({ warSoulUnitId = 0, warSoulSetId = 1, warSoulPage = this.warSoul.state.currentPage } = {}) {
    if (warSoulUnitId) return this.warSoul.effects(warSoulUnitId, warSoulSetId, warSoulPage);
    const out = require('./war-soul-entry').effects(this.warSoul.state.entryPanel);
    for (const { unitId, category, unit } of this.activeWarSoulUnits(warSoulPage)) {
      const active = Object.entries(unit?.entries || {}).find(([, entry]) => entry?.active);
      if (active) out.push(...this.warSoul.effects(unitId, Number(active[0]), warSoulPage, category));
    }
    return out;
  }
  warSoulProfile({ warSoulUnitId = 0, warSoulSetId = 1, warSoulPage = this.warSoul.state.currentPage } = {}) {
    const units = warSoulUnitId ? [{ unitId: Number(warSoulUnitId), category: 1 }] : this.activeWarSoulUnits(warSoulPage);
    const restraint = {}, resistance = {};
    for (const { unitId, category } of units) {
      const unit = this.warSoul.resolveUnit(unitId, category);
      const active = warSoulUnitId ? Number(warSoulSetId) : Number(Object.entries(unit?.entries || {}).find(([, entry]) => entry?.active)?.[0] || 1);
      const profile = this.warSoul.soulProfile(unitId, active, warSoulPage, category);
      for (const [channel, value] of Object.entries(profile.restraint || {})) restraint[channel] = (restraint[channel] || 0) + Number(value || 0);
      for (const [channel, value] of Object.entries(profile.resistance || {})) resistance[channel] = (resistance[channel] || 0) + Number(value || 0);
    }
    const average = group => Object.values(group).reduce((sum, value) => sum + value, 0) / 4;
    return { restraint, resistance, averageRestraint: average(restraint), averageResistance: average(resistance) };
  }
  applyToLoadout(loadout, options = {}) {
    const bonus = this.bonuses(options);
    // gemBonus is reserved for the ordinary socket board. Progression stats
    // are merged by equipment-attributes/battle-equipment through
    // progressionBonus; putting them in both maps doubled every rune, magic
    // device and war-soul value in combat.
    const magicGemEffects = [...(loadout.magicGemEffects || []), ...this.magicGemEffects(options)];
    const warSoulEffects = [...(loadout.warSoulEffects || []), ...this.warSoulEffects(options)];
    return { ...loadout, progressionBonus: bonus, progressionSources: this.bonusSources(options),
      runeGodsendEffects: require('./battle-progression-effects').runeDescriptors(this.rune.state,options.runePage??this.rune.state.currentPage), magicGemEffects, warSoulEffects };
  }
}

module.exports = { ProgressionSystems };
