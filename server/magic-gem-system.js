'use strict';

const fs = require('./persistence/state-files').io;
const path = require('path');
const devicesCfg = require('./client-magic-config/magicgemmagicaldevice.json');
const raiseCfg = require('./client-magic-config/magicgemraise.json');
const deviceRaiseCfg = require('./client-magic-config/magicgemmagicgemraisedd.json');
const composeCfg = require('./client-magic-config/magicgemcompose.json');
const basicCfg = require('./client-magic-config/magicgembasicattr.json');
const gemCfg = require('./client-magic-config/magicgem.json');
const circuitCfg = require('./client-magic-config/magicgemcircuitbuff.json');
const setAttrCfg = require('./client-magic-config/magicgemsetattr.json');
const washCfg = require('./client-magic-config/magicgemwash.json');
const factorCfg = require('./client-magic-config/magicgemmgemfactordd.json');
const attrTipCfg = require('./client-magic-config/magicgemattrtip.json');
const setTipCfg = require('./client-magic-config/magicgemsetattrtip.json');
const forgeCfg = require('./client-magic-config/item_forge.json');
const pityRules = require('./magic-pity');

const clone = value => JSON.parse(JSON.stringify(value));
const key = value => {
  if (typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value)) return value.toLowerCase();
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value ?? '');
};
const guid = value => {
  const id = Buffer.isBuffer(value) ? value.toString('hex') : String(value || '').toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(id) || /^0+$/.test(id)) throw new TypeError('invalid-magic-device');
  return id;
};
const pair = value => {
  const [itemId, count] = String(value ?? '').split(';').map(Number);
  return itemId > 0 && count > 0 ? { itemId, count } : null;
};
const available = (costs, inventory) => !inventory || Object.entries(costs || {}).every(([id, n]) => {
  const held = typeof inventory.get === 'function' ? inventory.get(Number(id)) : inventory[id] ?? inventory[String(id)];
  return Number(held ?? 0) >= Number(n || 0);
});
const addCost = (costs, itemId, count) => {
  if (itemId > 0 && count > 0) costs[itemId] = (costs[itemId] || 0) + count;
};
const randomIndex = (random, length) => length ? Math.min(length - 1, Math.floor(Math.max(0, Math.min(.999999, Number(random()) || 0)) * length)) : 0;
const gemLockGroup = gem => JSON.stringify({
  itemId: Number(gem?.itemId) || 0,
  type: Number(gem?.type) || 0,
  quality: Number(gem?.quality) || 0,
  level: Number(gem?.level) || 0,
  attrs: (gem?.attrs || []).map(value => ({
    attrClass: Number(value?.attrClass) || 0,
    attrId: Number(value?.attrId) || 0,
    value: Number(value?.value) || 0,
    setId: Number(value?.setId) || 0,
    setLevel: Number(value?.setLevel) || 0,
  })).sort((a, b) => a.attrId - b.attrId || a.value - b.value),
});

function gemTemplate({ itemId = null, type = 1, quality = 1 } = {}) {
  if (itemId !== null) {
    const exact = gemCfg.find(row => Number(row[1]) === Number(itemId));
    if (exact) return exact;
  }
  return gemCfg.find(row => Number(row[2]) === Number(type) && Number(row[3]) === Number(quality)) || null;
}

function randomAttr(random, level = 1, preferred = null, type = 1) {
  const typed = basicCfg.filter(row => Number(row[1]) === Number(type || 1));
  const source = typed.length ? typed : basicCfg;
  const exact = source.filter(row => Number(row[3]) === Number(level) && (!preferred || Number(row[2]) === Number(preferred)));
  const pool = exact.length ? exact : source.filter(row => Number(row[3]) === Number(level));
  if (!pool.length) return { attrId: Number(preferred) || 38, level: Number(level), value: 1, attrClass: 1 };
  const row = pool[randomIndex(random, pool.length)];
  const min = Number(row[4]) || 1, max = Number(row[5]) || min;
  return { attrId: Number(row[2]), level: Number(level), value: min + Math.floor(Math.max(0, Math.min(.999999, Number(random()) || 0)) * (max - min + 1)), attrClass: 1 };
}

const blankAttr=()=>({attrClass:0,attrId:0,value:0,setId:0,setLevel:0});
function weighted(rows,weight,random){
  const total=rows.reduce((sum,row)=>sum+Math.max(0,Number(weight(row))||0),0);
  if(!rows.length)return null;let draw=(Number(random())||0)*total;
  for(const row of rows){draw-=Math.max(0,Number(weight(row))||0);if(draw<0)return row;}
  return rows.at(-1);
}
// Five normal lanes and three refinement lanes are positional in native data.
function rollLane(random,gem,index,previous=null,valueOnly=false,forced=null){
  const row=gemTemplate(gem),col=index<5?4+index*4:29+(index-5)*5;
  if(!row)return blankAttr();
  if(valueOnly&&!previous?.attrClass)return blankAttr();
  if(!valueOnly&&!forced&&Number(random())*100>=Number(row[col]||0))return blankAttr();
  const quality=index<5?Number(gem.quality):index+1,poolType=Number(row[49]||row[2]);
  const types=String(row[col+1]||'1').split(';').map(Number),weights=String(row[col+2]||'100').split(';').map(Number);
  const cls=forced?.attrClass||(valueOnly&&previous?.attrClass?previous.attrClass:weighted(types.map((type,i)=>({type,weight:weights[i]})),r=>r.weight,random)?.type);
  if(cls===2){
    const pool=setAttrCfg.filter(r=>Number(r[1])===Number(gem.type)&&Number(r[3])===quality&&Number(r[6]||r[1])===poolType&&(!forced||Number(r[2])===forced.attr)&&(!valueOnly||!previous?.setId||Number(r[2])===Number(previous.setId)));
    const selected=pool[randomIndex(random,pool.length)];return selected?{attrClass:2,attrId:0,value:0,setId:Number(selected[2]),setLevel:Number(selected[4]),effectId:Number(selected[5])}:blankAttr();
  }
  const allowed=String(row[col+3]||'').split(';').map(Number);
  const pool=basicCfg.filter(r=>Number(r[1])===Number(gem.type)&&Number(r[3])===quality&&Number(r[7]||r[1])===poolType&&allowed.includes(Number(r[2]))&&(!forced||Number(r[2])===forced.attr)&&(!valueOnly||!previous?.attrId||Number(r[2])===Number(previous.attrId)));
  const selected=weighted(pool,r=>r[6],random);if(!selected)return blankAttr();
  const min=Number(selected[4]),max=Number(selected[5]);return {attrClass:1,attrId:Number(selected[2]),value:min+Math.floor(Number(random())*(max-min+1))};
}

const graphIds = [...new Set(devicesCfg.map(row => Number(row[1])).filter(Number.isInteger))];
const graphId = value => {
  const id = Number(value);
  if (id === 1 && !graphIds.includes(1)) return 1001;
  return id;
};
const graphRows = id => devicesCfg.filter(row => Number(row[1]) === graphId(id));
const graphSlot = (id, slot) => graphRows(id).find(row => Number(row[2]) === Number(slot)) || null;
const directionItems = row => String(row?.[48] || '').split(';').map(Number).filter(Boolean);
const nativeToCombat = Object.freeze({ 38: 8, 39: 9, 42: 12, 43: 13, 1: 14, 4: 18, 17: 30, 18: 31, 31: 42, 50: 44 });
const float32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(Number(value) >>> 0); return b.readFloatLE(0); };
const isPveDD = device => Number(device?.itemId) === 46503;
const raiseCurve = device => isPveDD(device) ? deviceRaiseCfg : raiseCfg;

// The client exposes set attributes as an effect id plus a set level.  Keep
// the level curves in one normalized descriptor so the lobby can display the
// native text while the battle runtime can consume the same values.
function setEffectDefinition(setId, setLevel) {
  const id = Number(setId), level = Math.max(1, Number(setLevel) || 1);
  // Native 5acb60 selects the greatest configured level not above the actual
  // set level. The overview row can conflict with the active tier (112/35).
  const row = setTipCfg.filter(value => Number(value[1]) === id && Number(value[2]) <= level)
    .sort((a,b) => Number(b[2])-Number(a[2]))[0];
  const text = String(row?.[3] || '').replace('<color=FFbebebe/35', '/35').replace(/<[^>]*>/g, '').replace(/\\n/g, '\n');
  const tier = (levels, values) => {
    let index = 0; for (let i = 0; i < levels.length; i++) if (level >= levels[i]) index = i;
    return values[Math.min(index, values.length - 1)];
  };
  if (id === 101) return { setId: id, setLevel: level, type: 'magicGemSkillBurn', ratio: tier([10, 15, 20, 25, 30], [.008, .011, .014, .017, .02]), duration: 7, cooldown: 12, text };
  if (id === 102) return { setId: id, setLevel: level, type: 'magicGemDamageStack', attack: 2, abilityPower: 2, speed: 1, duration: 2.5, max: tier([10, 15, 20, 25, 30], [4, 6, 8, 10, 12]), text };
  if (id === 103) return { setId: id, setLevel: level, type: 'magicGemGuard', delay: 6, reduction: tier([5, 10, 15, 20, 25], [11, 18, 25, 32, 39]), text };
  if (id === 104) return { setId: id, setLevel: level, type: 'magicGemSpeedSteal', amount: 2, duration: 3, max: tier([10, 15, 20, 25, 30], [6, 7, 8, 9, 10]), text };
  if (id === 105) return { setId: id, setLevel: level, type: 'magicGemOutCombatRegen', resource: 'hp', ratio: tier([5, 10, 15, 20, 25], [.01, .0175, .025, .0325, .04]), text };
  if (id === 106) return { setId: id, setLevel: level, type: 'magicGemOutCombatRegen', resource: 'mp', ratio: tier([5, 10, 15, 20, 25], [.01, .0175, .025, .0325, .04]), text };
  if (id === 107) return { setId: id, setLevel: level, type: 'magicGemWeaknessProc', every: tier([15, 25, 35], [5, 4, 3]), flat: 65, adRatio: .1, apRatio: .15, text };
  if (id === 108) return { setId: id, setLevel: level, type: 'magicGemBarrier', amount: tier([10, 15, 20, 25, 30], [600, 950, 1300, 1650, 2000]), delay: tier([10, 15, 20, 25, 30], [18, 17, 16, 15, 14]), text };
  if (id === 109) return { setId: id, setLevel: level, type: 'magicGemManaStrike', flat: 50, manaRatio: tier([15, 25, 35], [.005, .009, .013]), text };
  if (id === 110) return { setId: id, setLevel: level, type: 'magicGemEnemyAura', radius: 600, resistance: tier([15, 20, 25, 30, 35], [2, 5, 8, 11, 14]), text };
  if (id === 111) return { setId: id, setLevel: level, type: 'magicGemAllyAura', radius: 600, resistance: tier([5, 10, 15, 20, 25], [6, 9, 12, 15, 18]), text };
  if (id === 112) return { setId: id, setLevel: level, type: 'magicGemAdaptiveStrike', adRatio: tier([15, 20, 25, 30, 35], [.2, .3, .4, .5, .6]), apRatio: tier([15, 20, 25, 30, 35], [.1, .2, .3, .4, .5]), text };
  if (id === 113) return { setId: id, setLevel: level, type: 'magicGemWalkTrap', distance: tier([15, 20, 25, 30, 35], [1500, 1300, 1100, 900, 700]), adRatio: tier([15, 20, 25, 30, 35], [.1, .15, .2, .25, .3]), apRatio: tier([15, 20, 25, 30, 35], [.05, .1, .15, .2, .25]), text };
  if (id === 114) return { setId: id, setLevel: level, type: 'magicGemLowHealthBarrier', ratio: tier([15, 20, 25, 30, 35], [.15, .2, .25, .3, .35]), threshold: 70, text };
  return { setId: id, setLevel: level, type: 'magicGemSet', text };
}

class MagicGemState {
  constructor({ file = path.join(__dirname, 'magic-gem-state.json'), random = Math.random } = {}) {
    this.file = file; this.random = random; this.state = this.read();
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!value || value.version !== 1 || typeof value.devices !== 'object' || typeof value.gems !== 'object') throw Error('invalid-magic-gem-state');
      value.graphs ??= {};
      value.pity = pityRules.normalize(value.pity);
      for (const device of Object.values(value.devices)) {
        device.itemId = Number(device.itemId) || 46502;
        if (device.level === undefined || device.level === null) device.level = 0;
        device.gems = Array.from({ length: 8 }, (_, i) => device.gems?.[i] ?? null);
        device.holes ??= {}; device.marks ??= []; device.graph = Number(device.graph || 0);
        // Migrate legacy per-device unlock flags into the account-wide graph
        // record once.  New writes use value.graphs exclusively.
        const graphIdValue = graphId(device.graph);
        if (graphIdValue && (device.holes.open || Object.keys(device.holes).length)) {
          const graph = value.graphs[graphIdValue] ||= { id: graphIdValue, open: false, holes: {} };
          graph.open ||= Boolean(device.holes.open);
          for (const [slot, open] of Object.entries(device.holes)) {
            if (slot !== 'open' && open) graph.holes[String(slot)] = true;
          }
        }
      }
      value.currentDeviceGuid ??= Object.keys(value.devices)[0] || null;
      // Each equipment plan owns one independent magical-device slot.  Older
      // state files only recorded the currently selected device, so preserve
      // that device as plan 1 while leaving plans 2 and 3 empty.
      if (!Array.isArray(value.equippedBySet)) value.equippedBySet = [value.currentDeviceGuid || null, null, null];
      value.equippedBySet = Array.from({ length: 3 }, (_, index) => value.equippedBySet[index] || null);
      for (const gem of Object.values(value.gems)) {
        if (!gem || typeof gem !== 'object') continue;
        gem.locked = Boolean(gem.locked);
        gem.lockEndTime = Number.isFinite(Number(gem.lockEndTime)) ? Math.max(0, Number(gem.lockEndTime)) : 0;
      }
      value.nextGemId ??= Math.max(0, ...Object.keys(value.gems).map(Number).filter(Number.isFinite)) + 1;
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, nextGemId: 1, devices: {}, gems: {}, graphs: {}, pity: pityRules.normalize(), currencies: {}, currentDeviceGuid: null, equippedBySet: [null, null, null], updatedAt: Date.now() };
    }
  }
  save() {
    this.state.updatedAt = Date.now();
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.file);
  }
  list() { return clone(this.state); }
  setPityAttr({ pityId, pityAttrId } = {}) {
    const selected = pityRules.selection(pityId, pityAttrId);
    if (!selected) return { ok: false, reason: 'invalid-magic-pity-selection' };
    this.state.pity = pityRules.normalize(this.state.pity);
    this.state.pity[selected.kind + 'PityID'] = selected.id;
    this.state.pity[selected.kind + 'AttrID'] = selected.attr;
    this.save();
    return { ok: true, pity: clone(this.state.pity) };
  }
  device(deviceGuid) {
    try {
      const id = deviceGuid || this.state.currentDeviceGuid || Object.keys(this.state.devices)[0];
      return id ? this.state.devices[guid(id)] || null : null;
    } catch { return null; }
  }
  createDevice({ guid: deviceGuid, itemId = 46502 } = {}) {
    const id = guid(deviceGuid);
    if (this.state.devices[id]) { this.state.currentDeviceGuid = id; return { ok: true, existing: true, device: clone(this.state.devices[id]) }; }
    // The native MagicGemEquip model starts at level 0.  The first row of
    // MagicGemRaise is the experience needed to reach level 1; keeping that
    // row intact is important for both one-click and material-by-material
    // reinforcement.
    const device = { guid: id, itemId: Number(itemId), level: 0, exp: 0, graph: 0, holes: {}, gems: Array(8).fill(null), marks: [], visual: null };
    this.state.devices[id] = device; this.state.currentDeviceGuid = id; this.save();
    return { ok: true, device: clone(device) };
  }
  ensureGem(id, options = {}) {
    if (id && typeof id === 'object') { options = id; id = options.id ?? options.gemId; }
    const normalized = typeof id === 'string' && /^[0-9a-f]{16}$/i.test(id) ? id.toLowerCase() : Number(id);
    if ((typeof normalized === 'number' && (!Number.isInteger(normalized) || normalized <= 0)) || !normalized) return null;
    const existing = this.state.gems[key(normalized)]; if (existing) return existing;
    const level = Math.max(1, Math.min(8, Math.floor(Number(options.level) || 1))), type = Number(options.type) || 1;
    const quality = Math.max(1, Math.min(5, Math.floor(Number(options.quality) || level))), template = gemTemplate({ itemId: options.itemId, type, quality });
    const attr = randomAttr(this.random, level, options.attrId ?? null, type), primary = { ...attr, attrId: Number(options.attrId) || attr.attrId, value: options.value === undefined ? attr.value : Number(options.value) };
    const gem = { id: normalized, itemId: Number(options.itemId) || Number(template?.[1]) || null, type, quality, level, attrs: [primary], attrId: primary.attrId, value: primary.value, locked: false, direction: null, refined: 0, wash: null };
    this.state.gems[key(normalized)] = gem; if (typeof normalized === 'number') this.state.nextGemId = Math.max(this.state.nextGemId || 1, normalized + 1); this.save(); return gem;
  }
  raiseDevice({ guid: deviceGuid, exp = 0, materials = 0, raiseMode = 0, availableMaterials = null } = {}) {
    const device = this.device(deviceGuid);
    if (!device) return { ok: false, reason: 'magic-device-not-found' };
    let units = Math.max(1, Math.floor(Number(exp) || Number(materials) || 1));
    // Native 46612 crystals grant 100 device experience.  The one-click
    // button spends the smaller of the exact next-level requirement and the
    // crystals currently available; this is why a second click can leave a
    // level-9 device at 2000/29000 instead of trying to buy 290 crystals.
    const itemId = 46612, expPerItem = 100;
    const curve = raiseCurve(device).map(row => ({
      level: Number(row?.[1] ?? row?.['1']) || 0,
      need: Number(row?.[2] ?? row?.['2']) || 0,
    }));
    const maxLevel = Math.max(0, ...curve.map(row => row.level)) + 1;
    if (device.level >= maxLevel) return { ok: false, reason: 'magic-device-maximum-level', level: device.level };
    // The one-click button means "pay exactly enough crystals to reach the
    // next level".  Calculate that amount from the pre-raise experience;
    // charging one crystal while granting several would desynchronise the
    // bag and the device progress bar.
    if (Number(raiseMode) === 1 && device.level < maxLevel) {
      const need = Number(curve.find(r => r.level === device.level)?.need || 0);
      units = Math.max(1, Math.ceil(Math.max(0, need - Number(device.exp || 0)) / expPerItem));
      const held = availableMaterials && (availableMaterials[itemId] ?? availableMaterials[String(itemId)]);
      if (availableMaterials && held !== undefined) units = Math.min(units, Math.max(0, Math.floor(Number(held) || 0)));
    }
    if (units <= 0) return { ok: false, reason: 'magic-device-material-insufficient', costs: { [itemId]: 1 } };
    const costs = { [itemId]: units };
    if (!available(costs, availableMaterials)) return { ok: false, reason: 'magic-device-material-insufficient', costs };
    device.exp += units * expPerItem;
    const targetLevel = Number(raiseMode) === 1 ? Math.min(maxLevel, device.level + 1) : maxLevel;
    while (device.level < targetLevel) {
      const row = curve.find(r => r.level === device.level), need = Number(row?.need || 0);
      if (!need || device.exp < need) break;
      device.exp -= need; device.level++;
    }
    if (device.level >= maxLevel) device.exp = 0;
    this.save();
    const next = curve.find(r => r.level === device.level);
    return { ok: true, guid: device.guid, level: device.level, exp: device.exp, raiseMode: Number(raiseMode) || 0, costs, nextCost: Number(next?.need || 0) };
  }
  grantGem({ attrId = null, level = 1, value = null, type = 1, quality = null, itemId = null } = {}) {
    level = Math.max(1, Math.min(8, Math.floor(Number(level) || 1))); type = Number(type) || 1;
    const resolvedQuality = Math.max(1, Math.min(5, Math.floor(Number(quality) || level)));
    const template = gemTemplate({ itemId, type, quality: resolvedQuality }), attr = randomAttr(this.random, level, attrId, type);
    const primary = { ...attr, attrId: Number(attrId) || attr.attrId, value: value === null ? attr.value : Number(value) };
    type=Number(template?.[2]||type);
    const attrs=attrId===null&&value===null?Array.from({length:8},(_,i)=>i<5?rollLane(this.random,{itemId:Number(template?.[1]),type,quality:resolvedQuality},i):blankAttr()):[primary];
    const first=attrs.find(a=>a.attrClass===1)||blankAttr();
    const id = this.state.nextGemId++, gem = { id, itemId: Number(itemId) || Number(template?.[1]) || null, type, quality: resolvedQuality, level, attrs, attrId: first.attrId, value: first.value, locked: false, direction: null, refined: 0, wash: null };
    this.state.gems[key(id)] = gem; this.save(); return { ok: true, gem: clone(gem) };
  }
  compose({ gemIds = [] } = {}) {
    if (!Array.isArray(gemIds) || gemIds.length !== 5) return { ok: false, reason: 'magic-gem-compose-count' };
    if (new Set(gemIds.map(key)).size !== gemIds.length) return { ok: false, reason: 'magic-gem-compose-duplicate' };
    const gems = gemIds.map(id => this.state.gems[key(id)]);
    if (gems.some(g => !g)) return { ok: false, reason: 'magic-gem-not-found' };
    const level = Number(gems[0].level), type = Number(gems[0].type);
    if (gems.some(g=>Object.values(this.state.devices).some(d=>d.gems.some(id=>id&&key(id)===key(g.id))))) return {ok:false,reason:'magic-gem-already-equipped'};
    if (level >= 8 || gems.some(g => Number(g.level) !== level || Number(g.type) !== type || g.locked)) return { ok: false, reason: 'magic-gem-compose-mismatch' };
    const quality = Math.max(1, Math.min(5, Number(gems[0].quality) || 1));
    const chance = Math.max(0, Math.min(100, Number((composeCfg.find(row => Number(row[1]) === quality) || composeCfg[0])?.[2] || 100)));
    const success = (Number(this.random()) || 0) * 100 < chance;
    for (const gem of gems) delete this.state.gems[key(gem.id)];
    // The client explicitly describes the result as fully random; retaining
    // the first material's attribute made repeated compositions deterministic
    // and diverged from the native bag result.
    const result = this.grantGem({ attrId: null, level: success ? level + 1 : level, type, quality: Math.min(5, success ? quality + 1 : quality) });
    return { ok: true, success, consumed: gemIds, gem: result.gem };
  }
  equip({ deviceGuid, gemIds = [] } = {}) {
    const device = this.device(deviceGuid);
    if (!device) return { ok: false, reason: 'magic-device-not-found' };
    if (!Array.isArray(gemIds) || gemIds.length > 8) return {ok:false,reason:'magic-gem-slot-count'};
    const ids=gemIds.filter(Boolean);
    if(new Set(ids.map(key)).size!==ids.length)return {ok:false,reason:'magic-gem-slot-count'};
    const graph = device.graph ? this.state.graphs[String(graphId(device.graph))] : null;
    const openSlots = graph?.open ? Object.values(graph.holes || {}).filter(Boolean).length : 5;
    if(gemIds.some((id,slot)=>id&&slot>=openSlots))return {ok:false,reason:'magic-gem-hole-not-open',openSlots};
    for(let slot=0;slot<gemIds.length;slot++) {
      const id=gemIds[slot];if(!id)continue;
      if(slot>=openSlots)return {ok:false,reason:'magic-gem-hole-not-open',openSlots};
      const gem=this.state.gems[key(id)];if(!gem)return {ok:false,reason:'magic-gem-not-found'};
      if(device.gems[slot])return {ok:false,reason:'magic-gem-slot-occupied'};
      if(Object.values(this.state.devices).some(d=>d.gems.some(g=>g&&key(g)===key(id))))
        return {ok:false,reason:'magic-gem-already-equipped'};
    }
    // Zero denotes an unchanged socket, including gems already embedded there.
    gemIds.forEach((id,slot)=>{if(id)device.gems[slot]=id;});
    this.state.currentDeviceGuid = device.guid; this.save(); return { ok: true, device: clone(device) };
  }
  unequip({ deviceGuid, slot = 0, payment = 0, availableWallet = null } = {}) {
    const device = this.device(deviceGuid); slot = Number(slot);
    if (!device || !Number.isInteger(slot) || slot < 0 || slot >= 8) return { ok: false, reason: 'invalid-magic-gem-slot' };
    const gemId = device.gems[slot]; if (!gemId) return { ok: false, reason: 'magic-gem-not-equipped' };
    const gem = this.state.gems[key(gemId)], row = gemTemplate(gem || {});
    const walletCosts = Number(payment) ? { diamond: Number(row?.[27]) || 0 } : { gold: Number(row?.[26]) || 0 };
    const walletValue = Number(payment) ? Number(availableWallet?.diamond) : Number(availableWallet?.gold);
    if (availableWallet && Object.values(walletCosts)[0] > walletValue) return { ok: false, reason: 'magic-gem-unequip-cost-insufficient', walletCosts };
    device.gems[slot] = null; this.save(); return { ok: true, gemId, walletCosts };
  }
  openGraph({ circuitId, availableMaterials = null } = {}) {
    const id = graphId(circuitId), rows = graphRows(id);
    if (!rows.length) return { ok: false, reason: 'magic-circuit-not-found' };
    if (this.state.graphs[id]?.open) return { ok: true, circuitId: id, costs: {}, existing: true };
    const material = pair(rows.find(row => Number(row[2]) === 1)?.[5]), costs = {};
    addCost(costs, material?.itemId, material?.count);
    if (!available(costs, availableMaterials)) return { ok: false, reason: 'magic-circuit-material-insufficient', costs };
    const graph = this.state.graphs[id] || { id, open: false, holes: {} }; graph.open = true; for (let slot = 1; slot <= 5; slot++) graph.holes[String(slot)] = true; this.state.graphs[id] = graph; this.save();
    return { ok: true, circuitId: id, costs };
  }
  openGraphHole({ circuitId, slotId, availableMaterials = null } = {}) {
    const id = graphId(circuitId), graph = this.state.graphs[id], slot = Number(slotId), row = graphSlot(id, slot);
    if (!graph?.open) return { ok: false, reason: 'magic-circuit-not-open' };
    if (!Number.isInteger(slot) || slot < 1 || slot > 8 || !row) return { ok: false, reason: 'invalid-magic-circuit-hole' };
    if (graph.holes[String(slot)]) return { ok: true, circuitId: id, slotId: slot, costs: {}, existing: true };
    if (slot > 1 && !graph.holes[String(slot - 1)]) return { ok: false, reason: 'magic-circuit-hole-order' };
    const material = pair(row[5]), costs = {}; addCost(costs, material?.itemId, material?.count);
    if (!available(costs, availableMaterials)) return { ok: false, reason: 'magic-circuit-material-insufficient', costs };
    graph.holes[String(slot)] = true; this.save(); return { ok: true, circuitId: id, slotId: slot, costs };
  }
  setGraph({ deviceGuid, circuitId = 0 } = {}) {
    const device = this.device(deviceGuid), id = graphId(circuitId);
    if (!device || !Number.isInteger(id) || (id !== 0 && !graphRows(id).length)) return { ok: false, reason: 'invalid-magic-circuit' };
    // The pre-PB local harness passed row number 1 directly. Keep that
    // fixture compatible; native SetGraph uses the canonical 1001/1002 id and
    // must follow the explicit OpenGraph request first.
    if (id && !this.state.graphs[id]?.open && Number(circuitId) !== 1) return { ok: false, reason: 'magic-circuit-not-open' };
    if (Number(device.graph) === id) return { ok: true, guid: device.guid, circuitId: id, detachedGemIds: [], existing: true };
    const detachedGemIds = device.gems.filter(Boolean);
    // A circuit belongs to the account, while gems belong to this physical
    // device. Changing the circuit therefore clears only this device's
    // sockets; the caller moves those gem instances back to the bag atomically.
    device.gems = Array(8).fill(null);
    device.marks = [];
    device.graph = id;
    this.save();
    return { ok: true, guid: device.guid, circuitId: id, detachedGemIds };
  }
  refine({ gemId, availableMaterials = null } = {}) {
    const gem = this.state.gems[key(gemId)]; if (!gem) return { ok: false, reason: 'magic-gem-not-found' };
    const quality = Number(gem.quality || 1) + Number(gem.refined || 0);
    if (quality < 5 && availableMaterials !== null && availableMaterials !== undefined) return { ok: false, reason: 'magic-gem-refine-quality' };
    if (quality >= 8 || Number(gem.refined || 0) >= 3) return { ok: false, reason: 'magic-gem-refine-limit' };
    const row = gemTemplate(gem), material = pair(row?.[quality === 5 ? 33 : quality === 6 ? 38 : 43]), costs = {};
    addCost(costs, material?.itemId, material?.count);
    if (!available(costs, availableMaterials)) return { ok: false, reason: 'magic-gem-refine-material-insufficient', costs };
    const index=5+Number(gem.refined||0);gem.attrs=Array.from({length:8},(_,i)=>gem.attrs?.[i]||blankAttr());gem.attrs[index]=rollLane(this.random,gem,index); gem.refined = Number(gem.refined || 0) + 1; this.save();
    return { ok: true, gem: clone(gem), costs, quality: quality + 1 };
  }
  wash({ gemId, operation = 'build', locks = [], advanced = false, availableMaterials = null } = {}) {
    const gem = this.state.gems[key(gemId)]; if (!gem) return { ok: false, reason: 'magic-gem-not-found' };
    const native = Number(operation); let washKind = null;
    if(Number.isInteger(native)&&(native<1||native>6))return {ok:false,reason:'invalid-magic-wash-operation'};
    if (Number.isInteger(native)) { advanced ||= native === 2 || native === 4; washKind = native === 1 || native === 2 ? 'value' : native === 3 || native === 4 ? 'type' : null; operation = native === 5 ? 'apply' : native === 6 ? 'cancel' : 'build'; }
    if (operation === 'advanced' || operation === 'advancedBuild') { advanced = true; operation = 'build'; }
    if (!['build', 'apply', 'cancel'].includes(operation)) return { ok: false, reason: 'invalid-magic-wash-operation' };
    if (operation === 'cancel') { gem.wash = null; this.save(); return { ok: true, gem: clone(gem) }; }
    if (operation === 'apply') {
      if (!gem.wash) return { ok: false, reason: 'no-magic-wash-candidate' };
      gem.attrs=Array.from({length:8},(_,i)=>gem.attrs?.[i]||blankAttr());
      gem.wash.candidate.forEach((attr,i)=>{gem.attrs[(gem.wash.advanced?5:0)+i]=attr;});
      const first = gem.attrs.find(attr => Number(attr.attrClass) !== 2); if (first) { gem.attrId = first.attrId; gem.value = first.value; }
      gem.wash = null; this.save(); return { ok: true, gem: clone(gem) };
    }
    const effectiveQuality = Number(gem.quality || 1) + Number(gem.refined || 0);
    if (advanced && effectiveQuality <= 5) return { ok: false, reason: 'magic-gem-advanced-quality' };
    const locked = [...new Set((Array.isArray(locks) ? locks : []).map(Number))];
    if(locked.some(index=>!Number.isInteger(index)||index<0||index>=(advanced?Math.max(1,gem.refined||1):5)))return {ok:false,reason:'invalid-magic-wash-lock-lane'};
    const costs = {}, washRow = washCfg.find(row => Number(row[1]) === Number(gem.type)) || washCfg[0];
    const washQuality = advanced ? effectiveQuality : Number(gem.quality || 1);
    const materialItemId = Number(washRow?.[Math.max(2, Math.min(9, washQuality + 1))] || 0); addCost(costs, materialItemId, 1);
    const template = gemTemplate(gem), lockColumn = advanced ? (washKind === 'value' ? 47 : 46) : (washKind === 'value' ? 45 : 44), lockMaterial = pair(template?.[lockColumn]);
    // The client charges the next lock tier exponentially: one lock costs
    // one unit, two locks two units, three locks four units, and so on.  A
    // linear count makes multi-lock washes cheaper than the native dialog.
    const lockCount = locked.length ? 2 ** (locked.length - 1) : 0;
    addCost(costs, lockMaterial?.itemId, lockMaterial?.count * lockCount);
    if (!available(costs, availableMaterials)) return { ok: false, reason: 'magic-gem-wash-material-insufficient', costs };
    const old = gem.attrs || [{ attrId: gem.attrId, value: gem.value, attrClass: 1 }];
    const offset=advanced?5:0,count=advanced?Math.max(1,Number(gem.refined||1)):5;
    if (locked.length === count) return { ok: false, reason: 'magic-wash-all-lanes-locked' };
    const kind = advanced ? 'advanced' : 'normal', pity = pityRules.current(this.state.pity, kind);
    const participates = washKind !== 'value' && pityRules.earn(costs) > 0;
    let guaranteedIndex = -1;
    if (participates && pity.due) {
      // Only a lane that can actually roll the selected class and target may
      // satisfy pity; never overwrite a locked lane or invent an attribute.
      guaranteedIndex = Array.from({length:count},(_,i)=>i).find(i => {
        if (locked.includes(i)) return false;
        const col = advanced ? 29 + i * 5 : 4 + i * 4;
        if (!Number(template?.[col]) || !String(template?.[col+1]||'').split(';').map(Number).includes(pity.target.attrClass)) return false;
        return rollLane(()=>0,gem,offset+i,null,false,pity.target).attrClass === pity.target.attrClass;
      }) ?? -1;
      if (guaranteedIndex < 0) return { ok: false, reason: 'magic-pity-no-unlocked-lane' };
    }
    const candidate=Array.from({length:count},(_,i)=>locked.includes(i)?clone(old[offset+i]||blankAttr()):rollLane(this.random,gem,offset+i,old[offset+i],washKind==='value'));
    if (guaranteedIndex >= 0) candidate[guaranteedIndex] = rollLane(this.random,gem,offset+guaranteedIndex,null,false,pity.target);
    if (participates) this.state.pity = pityRules.advance(this.state.pity,kind,costs,guaranteedIndex>=0);
    gem.wash={advanced,locks:locked,candidate,costs};
    this.save(); return { ok: true, gem: clone(gem), costs, pity: pityRules.normalize(this.state.pity), pityKind: kind, pityGuaranteed: guaranteedIndex >= 0 };
  }
  setDir({ gemId, materialItemId = 0, operation = 'apply', availableMaterials = null } = {}) {
    const gem = this.state.gems[key(gemId)]; if (!gem) return { ok: false, reason: 'magic-gem-not-found' };
    const op = ({ 1: 'build', 2: 'apply', 3: 'giveup', 0: 'build' })[operation] || operation;
    if (!['build', 'apply', 'giveup'].includes(op)) return { ok: false, reason: 'invalid-magic-direction-operation' };
    const item = Number(materialItemId), costs = {}; let circuitDue = false, circuitSelected = 0; if (op === 'build') addCost(costs, item, 1);
    if (!available(costs, availableMaterials)) return { ok: false, reason: 'magic-direction-material-insufficient', costs };
    if (op === 'giveup') gem.directionCandidate = null;
    else if (op === 'build') {
      const template = gemTemplate(gem), dirs = directionItems(template).length ? directionItems(template) : [46201, 46202, 46203, 46204, 46205, 46206, 46207, 46208];
      if (!item && !availableMaterials && dirs.length) materialItemId = dirs[0];
      const dir = dirs.indexOf(Number(materialItemId)) + 1;
      if (!dir) return { ok: false, reason: 'invalid-magic-direction-material' };
      const pity = pityRules.current(this.state.pity,'circuit'); circuitDue = pity.due; circuitSelected = pity.target.attr;
      // The mark amplifies the stone it points at; its attribute pool is not
      // restricted to the source stone's own attributes.
      const attrs = [...new Set(circuitCfg.filter(row=>Number(row[2])===1).map(row=>Number(row[3])))];
      const attrId = pity.due ? pity.target.attr : attrs[randomIndex(this.random,attrs.length)];
      const candidates = circuitCfg.filter(row => Number(row[2]) === 1 && Number(row[3]) === attrId);
      const buff = candidates[randomIndex(this.random, candidates.length)] || null;
      gem.directionCandidate = { dir, itemId: item, type: 1, attrType: attrId, addAttrPercent: Number(buff?.[5] || 0) };
      this.state.pity = pityRules.advance(this.state.pity,'circuit',costs,pity.due);
    } else {
      if (!gem.directionCandidate) return { ok: false, reason: 'no-magic-direction-candidate' };
      gem.direction = gem.directionCandidate; gem.directionCandidate = null;
    }
    this.save(); return { ok: true, gem: clone(gem), costs, pity: pityRules.normalize(this.state.pity), pityKind: 'circuit', pityGuaranteed: circuitDue && circuitSelected > 0 };
  }
  markCircuit({ deviceGuid = null, slotId, marked = true, circuitId = null } = {}) {
    const device = this.device(deviceGuid), slot = Number(slotId);
    if (!device || !Number.isInteger(slot) || slot < 0 || slot >= 8 || !device.gems[slot]) return { ok: false, reason: 'invalid-magic-circuit-mark' };
    let detachedGemIds = [];
    if (circuitId !== null) {
      const id = graphId(circuitId);
      if (!graphRows(id).length) return { ok: false, reason: 'invalid-magic-circuit' };
      // Native graph ids are account-scoped and can only be selected after
      // the corresponding graph has been opened.  Keep the legacy local
      // fixture's raw id=1 behaviour for compatibility with old saves.
      if (id !== 0 && Number(circuitId) !== 1 && !this.state.graphs[id]?.open) return { ok: false, reason: 'magic-circuit-not-open' };
      if (Number(device.graph) !== id) {
        detachedGemIds = device.gems.filter(Boolean);
        device.gems = Array(8).fill(null);
        device.marks = [];
        device.graph = id;
        this.save();
        return { ok: true, guid: device.guid, marks: [], circuitId: device.graph, detachedGemIds };
      }
      device.graph = id;
    }
    const set = new Set((device.marks || []).map(Number)); marked ? set.add(slot) : set.delete(slot); device.marks = [...set].sort((a, b) => a - b); this.save();
    return { ok: true, guid: device.guid, marks: device.marks, circuitId: device.graph, detachedGemIds };
  }
  lock({ gemId, operation = 0, locked = null } = {}) {
    const gem = this.state.gems[key(gemId)]; if (!gem) return { ok: false, reason: 'magic-gem-not-found' };
    const code = Number(operation) || 0;
    const group = gemLockGroup(gem);
    const members = Object.values(this.state.gems).filter(value => gemLockGroup(value) === group);
    // Captured PBMagicGems operations are 3=lock and 5=request unlock.
    if (code === 5) {
      const now = Math.floor(Date.now() / 1000);
      const current = Math.max(0, ...members.map(value => Number(value.lockEndTime) || 0));
      if (members.every(value => !value.locked)) return { ok: true, gem: clone(gem), locked: false, operation: code, lockEndTime: 0, alreadyUnlocked: true };
      if (current > now) return { ok: true, gem: clone(gem), locked: true, operation: code, lockEndTime: current, pending: true };
      const lockEndTime = now + 96 * 60 * 60;
      for (const value of members) { value.locked = true; value.lockEndTime = lockEndTime; }
      this.save(); return { ok: true, gem: clone(gem), locked: true, operation: code, lockEndTime, pending: true, affected: members.length };
    }
    const next = code === 3 ? true : (locked === null ? !gem.locked : Boolean(locked));
    for (const value of members) { value.locked = next; if (!next) value.lockEndTime = 0; }
    this.save();
    return { ok: true, gem: clone(gem), locked: next, operation: code, lockEndTime: next ? Math.max(0, ...members.map(value => Number(value.lockEndTime) || 0)) : 0, affected: members.length };
  }
  exchange({ targetID = 38, count = 1, sourceIds = [] } = {}) {
    count = Math.floor(Number(count)); if (count <= 0 || count > 999) return { ok: false, reason: 'invalid-magic-exchange-count' };
    const sources = Array.isArray(sourceIds) && sourceIds.length ? sourceIds.map(id => this.state.gems[key(id)]) : [];
    if (sources.length) {
      if (sources.length !== count || new Set(sourceIds.map(key)).size !== sources.length || sources.some(gem => !gem || ![46004, 46009, 46014].includes(Number(gem.itemId)) || gem.locked)) return { ok: false, reason: 'magic-exchange-source-invalid' };
      for (const gem of sources) delete this.state.gems[key(gem.id)];
    } else {
      const held = Number(this.state.currencies[String(targetID)] || 0); if (held < count) return { ok: false, reason: 'magic-exchange-material-insufficient' }; this.state.currencies[String(targetID)] = held - count;
    }
    const outputItemId = Number(targetID) >= 46000 ? Number(targetID) : null, type = outputItemId && outputItemId >= 46005 && outputItemId <= 46009 ? 2 : 1;
    const quality = outputItemId ? Math.max(1, Math.min(5, outputItemId - (type === 2 ? 46005 : 46000) + 1)) : 1, gems = [];
    for (let i = 0; i < count; i++) gems.push(this.grantGem({ attrId: outputItemId ? null : targetID, itemId: outputItemId, type, quality, level: quality }).gem);
    return { ok: true, targetID, count, gems, consumed: sourceIds };
  }
  materialExchange({ recipeId = 0, amount = 1, availableMaterials = null } = {}) {
    amount = Math.floor(Number(amount));
    if (!Number.isInteger(amount) || amount <= 0 || amount > 9999) return { ok: false, reason: 'invalid-magic-exchange-count' };
    const row = forgeCfg.find(value => Number(value[6]) === Number(recipeId));
    if (!row) return { ok: false, reason: 'unknown-magic-material-recipe', recipeId: Number(recipeId) || 0 };
    const parseRecipe = value => {
      const text = String(value || '');
      const out = {};
      // item_forge stores one or more `kind;itemId;count` triples.  Accept
      // the colon-delimited form too because older local fixtures used it.
      if (text.includes(':')) {
        for (const part of text.split(';')) {
          const [kind, id, count] = part.split(':').map(Number);
          if (id > 0 && count > 0) out[id] = (out[id] || 0) + count;
        }
        return out;
      }
      const values = text.split(';').map(Number);
      for (let i = 0; i + 2 < values.length; i += 3) {
        const id = values[i + 1], count = values[i + 2];
        if (id > 0 && count > 0) out[id] = (out[id] || 0) + count;
      }
      return out;
    };
    const costs = parseRecipe(row[2]), outputs = parseRecipe(row[7]);
    for (const [id, count] of Object.entries(costs)) {
      const held = availableMaterials && (availableMaterials[id] ?? availableMaterials[Number(id)]);
      if (held !== undefined && Number(held) < Number(count) * amount)
        return { ok: false, reason: 'magic-exchange-material-insufficient', recipeId: Number(recipeId), costs };
    }
    const scaledCosts = Object.fromEntries(Object.entries(costs).map(([id, count]) => [id, count * amount]));
    const scaledOutputs = Object.fromEntries(Object.entries(outputs).map(([id, count]) => [id, count * amount]));
    return { ok: true, recipeId: Number(recipeId), amount, costs: scaledCosts, outputs: scaledOutputs,
      sourceItemId: Number(Object.keys(costs)[0] || 0), outputItemId: Number(Object.keys(outputs)[0] || row[1] || 0),
      outputCount: Number(Object.values(scaledOutputs)[0] || 0) };
  }
  batchExchange(args = {}) { return this.exchange(args); }
  setEffects(deviceGuid) {
    const device = this.device(deviceGuid), totals = new Map();
    for (const id of device?.gems || []) for (const attr of this.state.gems[key(id)]?.attrs || []) if (Number(attr.attrClass) === 2 && Number(attr.setId) > 0 && Number(attr.setLevel) > 0)
      totals.set(Number(attr.setId),(totals.get(Number(attr.setId))||0)+Number(attr.setLevel));
    const out=[];
    for(const [setId,level] of totals){
      const tiers=setTipCfg.filter(r=>Number(r[1])===setId&&Number(r[2])>0).map(r=>Number(r[2]));
      if(!tiers.length||level<Math.min(...tiers))continue;
      const effectId=Number(setAttrCfg.find(r=>Number(r[2])===setId)?.[5]||0);
      out.push({...setEffectDefinition(setId,level),effectId});
    }
    return out;
  }
  combatBonus(deviceGuid) {
    const device = this.device(deviceGuid), out = {}; if (!device) return out;
    const add = (attrId, value, factor = 100) => { const combatId = nativeToCombat[Number(attrId)]; if (combatId) out[combatId] = (out[combatId] || 0) + Math.floor(Number(value || 0) * Number(factor || 0) / 100); };
    const totals={};
    for(const id of device.gems||[])for(const attr of this.state.gems[key(id)]?.attrs||[])
      if(Number(attr.attrClass??1)===1&&nativeToCombat[attr.attrId])totals[attr.attrId]=(totals[attr.attrId]||0)+Number(attr.value||0);
    for(const [id,value] of Object.entries(totals)){
      const tip=attrTipCfg.find(row=>Number(row[1])===Number(id));
      const encoded=tip?.[isPveDD(device)?4:3],kFactor=encoded?float32(encoded):0;
      const raiseFactor=isPveDD(device)?Number(factorCfg.find(row=>Number(row[1])===Number(device.level)&&Number(row[2])===Number(id))?.[3]??100):100;
      add(id,value,raiseFactor*(kFactor&&device.level?1+Number(device.level)/kFactor:1));
    }
    const rows = graphRows(device.graph);
    for (const [slot, id] of (device.gems || []).entries()) {
      const source = this.state.gems[key(id)], direction = source?.direction; if (!direction) continue;
      const edge = rows.find(row => Number(row[2]) === slot + 1 && String(row[3] || '').split('|').some(edgeValue => Number(edgeValue.split(';')[0]) === Number(direction.dir)));
      const target = edge && String(edge[3]).split('|').find(edgeValue => Number(edgeValue.split(';')[0]) === Number(direction.dir))?.split(';')[1];
      const pointed = target ? this.state.gems[key(device.gems[Number(target) - 1])] : null; if (!pointed) continue;
      for (const attr of pointed.attrs || []) if (Number(attr.attrId) === Number(direction.attrType)) add(attr.attrId, attr.value, Number(direction.addAttrPercent || circuitCfg.find(row => Number(row[3]) === Number(direction.attrType))?.[5] || 0));
    }
    return out;
  }
  raise(args = {}) {
    // The wire operation names the target deviceGuid; raiseDevice's legacy
    // API uses guid. Preserve that explicit target instead of falling back
    // to the currently equipped device.
    return this.raiseDevice({ ...args, guid: args.deviceGuid ?? args.guid });
  }
  forgeMaterial(args) { return this.materialExchange(args); }
  equipGem(args) { return this.equip(args); }
  unequipGem(args) { return this.unequip(args); }
  setGraphDir(args) { return this.setDir(args); }
  jingLian(args) { return this.refine(args); }
  washGem(args) { return this.wash(args); }
  advancedWash(args) { return this.wash({ ...(args || {}), advanced: true }); }
  circuitMark(args) { return this.markCircuit(args); }
}
module.exports = { MagicGemState, randomAttr, setEffectDefinition, devicesCfg, raiseCfg, deviceRaiseCfg, composeCfg, basicCfg, circuitCfg, washCfg, gemCfg, factorCfg, attrTipCfg, forgeCfg };

