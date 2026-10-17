'use strict';
const fs = require('./persistence/state-files').io;
const path = require('path');
const cfg = name => {
  try { return require('./logs/cfg/' + name + '.json'); } catch { return []; }
};
const recipes = new Map(cfg('item_alchemy').map(row => [Number(row[1]), row]));
const forgeAttr = cfg('equipforge_forgeattr');
const forgeWeights = new Map(cfg('equipforge_forgeweight').map(row => [Number(row[1]), Number(row[2]) || 1]));
const cleanGuid = value => {
  const key = Buffer.isBuffer(value) ? value.toString('hex') : String(value || '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(key) || /^0+$/.test(key)) throw new TypeError('invalid-equipment-guid');
  return key;
};
const clone = value => JSON.parse(JSON.stringify(value));

function parseIngredients(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).map(([id, n]) => [String(id), Math.max(0, Math.floor(Number(n) || 0))]).filter(([, n]) => n));
  if (typeof value !== 'string') return {};
  const result = {};
  for (const part of value.split(';')) { const [id, n] = part.split(',').map(Number); if (id > 0 && n > 0) result[id] = n; }
  return result;
}

class EquipmentCrafting {
  constructor({ file = path.join(__dirname, 'equipment-crafting-state.json'), random = Math.random, now = () => Date.now() } = {}) {
    this.file = file; this.random = random; this.now = now; this.state = this.read();
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!value || value.version !== 1 || typeof value.forge !== 'object' || typeof value.receipts !== 'object') throw Error('invalid-crafting-state');
      value.applied ??= {};
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, forge: {}, applied: {}, receipts: {}, updatedAt: this.now() };
    }
  }
  save() {
    this.state.updatedAt = this.now();
    const tmp = `${this.file}.${process.pid}.tmp`; fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.file);
  }
  receipt(requestId, result) {
    if (!requestId) return false;
    const key = String(requestId); if (key.length > 128) throw new TypeError('invalid-request-id');
    if (this.state.receipts[key]) return clone(this.state.receipts[key]);
    this.state.receipts[key] = clone(result); return null;
  }
  alchemy({ recipeId = 0, inputs = null, outputItemId = 0, amount = 1, inventory = null, wallet = null, equipment = null, attrId = null, attrValue = null, requestId = null } = {}) {
    const repeated = this.receipt(requestId); if (repeated) return { ...repeated, repeated: true };
    amount = Math.floor(Number(amount)); if (!Number.isInteger(amount) || amount <= 0 || amount > 9999) return { ok: false, reason: 'invalid-alchemy-amount' };
    const row = recipes.get(Number(recipeId));
    if (!row) return { ok: false, reason: 'unknown-alchemy-recipe' };
    // SItem_Alchemy is an equipment attribute conversion table.  It does not
    // describe item ingredients: nOldAttrId -> nNewAttrId, with a per-type
    // transform rate and gold cost.
    if (inputs == null && outputItemId === 0 && equipment && attrId == null) {
      const oldId = Number(row[2]), newId = Number(row[3]), source = equipment.attributes && typeof equipment.attributes === 'object' ? equipment.attributes : equipment;
      const sourceValue = source[oldId] === undefined ? null : Number(source[oldId]);
      if (sourceValue === null || !Number.isFinite(sourceValue) || sourceValue < 0) return { ok: false, reason: 'alchemy-source-attribute-missing', oldAttrId: oldId };
      const convertedValue = Math.floor(sourceValue * Number(row[6] || 1000) / 1000), attributes = { ...source };
      delete attributes[oldId]; attributes[newId] = (Number(attributes[newId]) || 0) + convertedValue;
      const result = { ok: true, recipeId: Number(recipeId), typeId: Number(row[1]), oldAttrId: oldId, newAttrId: newId, scale: Number(row[4] || 0), transformRate: Number(row[6] || 0), cost: Number(row[7] || 0), attrValue: convertedValue, attributes, equipment: equipment.attributes ? { ...equipment, attributes } : attributes };
      if (requestId) this.state.receipts[String(requestId)] = clone(result); this.save(); return result;
    }
    if (inputs == null && outputItemId === 0 && !equipment && attrId == null) {
      const oldId = Number(row[2]), newId = Number(row[3]);
      const sourceValue = attrValue == null ? null : Number(attrValue);
      const convertedValue = sourceValue == null ? null : Math.floor(sourceValue * Number(row[6] || 1000) / 1000);
      const result = { ok: true, recipeId: Number(recipeId), typeId: Number(row[1]), oldAttrId: oldId, newAttrId: newId, scale: Number(row[4] || 0), transformRate: Number(row[6] || 0), cost: Number(row[7] || 0), attrValue: convertedValue };
      if (requestId) this.state.receipts[String(requestId)] = clone(result); this.save(); return result;
    }
    const costs = parseIngredients(inputs);
    for (const id of Object.keys(costs)) if (!(Number(id) > 0)) delete costs[id];
    if (!Object.keys(costs).length) return { ok: false, reason: 'unknown-alchemy-recipe' };
    const held = inventory && typeof inventory === 'object' ? inventory : {};
    for (const [id, count] of Object.entries(costs)) if (Number(held[id] || 0) < count * amount) return { ok: false, reason: 'materials-insufficient', missing: { [id]: count * amount - Number(held[id] || 0) } };
    const walletCosts = { gold: (Number(row[7]) || 0) * amount, diamond: 0 };
    if (wallet && Number(wallet.gold ?? Infinity) < walletCosts.gold) return { ok: false, reason: 'gold-insufficient', missing: walletCosts.gold - Number(wallet.gold || 0) };
    if (wallet && Number(wallet.diamond ?? Infinity) < walletCosts.diamond) return { ok: false, reason: 'diamond-insufficient', missing: walletCosts.diamond - Number(wallet.diamond || 0) };
    const output = Number(outputItemId); if (!(output > 0)) return { ok: false, reason: 'invalid-alchemy-output' };
    const result = { ok: true, recipeId: Number(recipeId), outputItemId: output, outputCount: amount, costs: Object.fromEntries(Object.entries(costs).map(([id, n]) => [id, n * amount])), walletCosts };
    if (requestId) this.state.receipts[String(requestId)] = clone(result); this.save(); return result;
  }
  inherit({ source, target, mode = 'all', consumeSource = false, requestId = null } = {}) {
    const repeated = this.receipt(requestId); if (repeated) return { ...repeated, repeated: true };
    if (!source || !target) return { ok: false, reason: 'equipment-instance-not-found' };
    let sourceGuid, targetGuid; try { sourceGuid = cleanGuid(source.guid); targetGuid = cleanGuid(target.guid); } catch { return { ok: false, reason: 'invalid-equipment-guid' }; }
    if (sourceGuid === targetGuid || Number(source.itemId) <= 0 || Number(target.itemId) <= 0) return { ok: false, reason: 'invalid-inherit-target' };
    const next = { ...target, guid: targetGuid };
    const copy = mode === 'all' ? ['enhancementLevel', 'enhancementSkillLevel', 'reforgeHex', 'warSoul', 'soul', 'forge'] : mode === 'enhancement' ? ['enhancementLevel', 'enhancementSkillLevel'] : mode === 'forge' ? ['forge'] : mode === 'soul' ? ['soul'] : mode === 'warSoul' ? ['warSoul'] : mode === 'reforge' ? ['reforgeHex'] : String(mode).split(',').flatMap(part => ({ enhancement: ['enhancementLevel', 'enhancementSkillLevel'], forge: ['forge'], soul: ['soul'], warSoul: ['warSoul'], reforge: ['reforgeHex'] }[part] || []));
    if (!copy.length) return { ok: false, reason: 'invalid-inherit-mode' };
    for (const key of copy) if (source[key] !== undefined) next[key] = clone(source[key]);
    // Native inheritance consumes the source's progression state. Keep the
    // source item itself so its GUID remains valid in the bag, but restore the
    // individual systems to their empty/base state instead of deleting the
    // whole object (which would also erase unrelated metadata).
    if (consumeSource) {
      if (copy.includes('enhancementLevel')) { source.enhancementLevel = 0; source.enhancementSkillLevel = 0; }
      if (copy.includes('reforgeHex')) source.reforgeHex = Buffer.alloc(42).toString('hex');
      if (copy.includes('soul')) source.soul = { current: 0, maximum: 0 };
      if (copy.includes('warSoul')) source.warSoul = { attrs: [], current: 0, maximum: 0 };
      if (copy.includes('forge')) delete source.forge;
      source.inherited = true;
    }
    if (copy.includes('forge')) {
      if (next.forge) this.state.applied[targetGuid] = clone(next.forge);
      else delete this.state.applied[targetGuid];
      if (consumeSource) delete this.state.applied[sourceGuid];
    }
    const result = { ok: true, sourceGuid, targetGuid, mode, target: next, source: clone(source), consumed: !!consumeSource };
    if (requestId) this.state.receipts[String(requestId)] = clone(result); this.save(); return result;
  }
  forgeBegin({ guid, itemId = 0, level = 0, attributes = {}, requestId = null } = {}) {
    const key = cleanGuid(guid), repeated = this.receipt(requestId); if (repeated) return { ...repeated, repeated: true };
    if (!Number.isInteger(Number(itemId)) || Number(itemId) <= 0 || !Number.isInteger(Number(level)) || Number(level) < 0) return { ok: false, reason: 'invalid-forge-instance' };
    const old = this.state.forge[key]; if (old?.pending) return { ok: false, reason: 'forge-pending' };
    const candidates = forgeAttr.length ? forgeAttr : [{ 1: 1, 2: '物攻', 3: 15, 5: 0, 6: 15 }];
    const totalWeight = candidates.reduce((sum, row) => sum + (forgeWeights.get(Number(row[1])) || 1), 0);
    let draw = Number(this.random()); if (!Number.isFinite(draw) || draw < 0 || draw >= 1) draw = 0;
    let cursor = draw * totalWeight, chosen = candidates[0]; for (const row of candidates) { cursor -= forgeWeights.get(Number(row[1])) || 1; if (cursor <= 0) { chosen = row; break; } }
    // equipforge_forgeattr stores the display row at [1] and the native
    // attribute code at [6]. Earlier code used the row index as the code and
    // consequently applied a different stat when the client confirmed it.
    const attrId = Number(chosen[6] ?? chosen[1]);
    const percentage = Number(chosen[5]) === 1;
    const defaults = { 3: 10, 4: 10, 89: 10, 90: 10, 2: 10, 83: 5, 84: 5, 85: 5, 86: 5 };
    const value = Math.max(1, Number(chosen[3]) || defaults[attrId] || 1);
    const pending = { guid: key, itemId: Number(itemId), level: Number(level), baseline: clone(attributes), candidate: { id: attrId, name: String(chosen[2] || ''), value, percentage }, createdAt: this.now(), locks: [] };
    this.state.forge[key] = { pending }; const result = { ok: true, pending: clone(pending) }; if (requestId) this.state.receipts[String(requestId)] = clone(result); this.save(); return result;
  }
  forgeLock({ guid, index, locked = true } = {}) {
    const key = cleanGuid(guid), record = this.state.forge[key]; if (!record?.pending) return { ok: false, reason: 'no-pending-forge' };
    index = Number(index); if (!Number.isInteger(index) || index < 0 || index >= 6) return { ok: false, reason: 'invalid-forge-slot' };
    const set = new Set(record.pending.locks || []); locked ? set.add(index) : set.delete(index); record.pending.locks = [...set].sort((a, b) => a - b); this.save(); return { ok: true, guid: key, locks: record.pending.locks };
  }
  forgeWash({ guid, requestId = null } = {}) {
    const key = cleanGuid(guid), record = this.state.forge[key]; if (!record?.pending) return { ok: false, reason: 'no-pending-forge' };
    const repeated = this.receipt(requestId); if (repeated) return { ...repeated, repeated: true };
    const current = record.pending, locks = [...(record.pending.locks || [])]; delete this.state.forge[key];
    const result = this.forgeBegin({ guid: key, itemId: record.pending.itemId, level: record.pending.level, attributes: record.pending.baseline });
    if (!result.ok) return result; result.pending.locks = locks; this.state.forge[key].pending = result.pending;
    const response = { ok: true, pending: clone(result.pending) }; if (requestId) this.state.receipts[String(requestId)] = clone(response); this.save(); return response;
  }
  forgeConfirm({ guid, choice = 'apply', requestId = null } = {}) {
    const key = cleanGuid(guid), record = this.state.forge[key]; if (!record?.pending) return { ok: false, reason: 'no-pending-forge' };
    const repeated = this.receipt(requestId); if (repeated) return { ...repeated, repeated: true };
    if (!['apply', 'cancel'].includes(choice)) return { ok: false, reason: 'invalid-forge-choice' };
    const pending = record.pending; delete this.state.forge[key];
    if (choice === 'apply') this.state.applied[key] = clone(pending.candidate);
    const result = choice === 'apply' ? { ok: true, guid: key, forge: pending.candidate } : { ok: true, guid: key, cancelled: true };
    if (requestId) this.state.receipts[String(requestId)] = clone(result); this.save(); return result;
  }
  determination({ guid, attrId, value } = {}) {
    const key = cleanGuid(guid), record = this.state.forge[key]; if (!record?.pending) return { ok: false, reason: 'no-pending-forge' };
    const candidate = record.pending.candidate; if (attrId !== undefined && Number(attrId) !== candidate.id) return { ok: false, reason: 'forge-attribute-mismatch' };
    if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0)) return { ok: false, reason: 'invalid-forge-value' };
    if (value !== undefined) candidate.value = Math.floor(Number(value)); this.save(); return { ok: true, guid: key, candidate: clone(candidate) };
  }
  getApplied(guid) { try { return clone(this.state.applied?.[cleanGuid(guid)] || null); } catch { return null; } }
  setApplied(guid, forge) { const key = cleanGuid(guid); if (forge) this.state.applied[key] = clone(forge); else delete this.state.applied[key]; this.save(); return this.getApplied(key); }
  forge(args) { return this.forgeBegin(args); }
  confirmForge(args) { return this.forgeConfirm(args); }
  lockForge(args) { return this.forgeLock(args); }
  washForge(args) { return this.forgeWash(args); }
}

module.exports = { EquipmentCrafting, cleanGuid, parseIngredients, recipes, forgeAttr };
