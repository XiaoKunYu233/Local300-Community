'use strict';
const fs = require('./persistence/state-files').io;
const path = require('path');
const stageCfg = require('./logs/cfg/warsoulstage.json');
const nativeStageRows=new Map();for(const row of stageCfg){const key=[row[1],row[2],row[3]].map(Number).join(':');const entries=nativeStageRows.get(key)||[];entries.push(row);nativeStageRows.set(key,entries);}
const chapterLocks = require('./logs/cfg/warsoulinfo.json')[0];
const materialCfg = require('./logs/cfg/warsoulmaterial.json');
const succinctCfg = require('./logs/cfg/warsoulsuccinct.json');
const consumptionCfg = require('./logs/cfg/warsoulconsumption.json');
const clone = v => JSON.parse(JSON.stringify(v));
const n = v => Number.isInteger(Number(v)) ? Number(v) : 0;
const materialCosts = value => {
  const out = {};
  for (const part of String(value ?? '').split(';')) {
    const [itemId, count] = part.split(',').map(Number);
    if (Number.isInteger(itemId) && itemId > 0 && Number.isFinite(count) && count > 0) out[itemId] = (out[itemId] || 0) + count;
  }
  return out;
};
const materialsAvailable = (costs, inventory) => !inventory || Object.entries(costs).every(([id, count]) => {
  const held = typeof inventory.get === 'function' ? inventory.get(Number(id)) : inventory[id] ?? inventory[String(id)];
  return Number(held || 0) >= Number(count || 0);
});

class WarSoulState {
  constructor({ file = path.join(__dirname, 'war-soul-state.json'), random = Math.random } = {}) { this.file = file; this.random = random; this.state = this.read(); }
  read() {
    try {
      const loaded=JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const view=require('./player-war-soul-snapshot').forRead(loaded,this.file);
      this.frozenSnapshot=view.frozen;
      const v=view.state;
      if (!v || v.version !== 1 || typeof v.units !== 'object' || !Array.isArray(v.pages)) throw Error('invalid-war-soul-state');
      v.pages.forEach((p, index) => {
        p.units ??= {};
        // Legacy global-only saves belong to their selected plan. Explicit
        // empty level maps are empty plans and must never inherit that data.
        if (!p.levels) p.levels = index === Number(v.currentPage || 0)
          ? Object.fromEntries(Object.entries(v.units).map(([key, u]) => [key, n(u.level)])) : {};
        p.active ??= false;
      });
      // The native panel always exposes five saved configurations. Older
      // local fixtures only had the first page, so materialize the remaining
      // pages before serving rename/change requests.
      while (v.pages.length < 5) v.pages.push({ name: `战魂配置${v.pages.length + 1}`, units: {}, levels: {}, active: false });
      v.enhancementPages = Array.isArray(v.enhancementPages) ? v.enhancementPages : [];
      while (v.enhancementPages.length < 5) v.enhancementPages.push({
        name: `加护配置${v.enhancementPages.length + 1}`, opened: v.enhancementPages.length === 0,
        active: v.enhancementPages.length === 0, values: Array(12).fill(0), locked: []
      });
      v.enhancementPage = Math.max(0, Math.min(4, Number(v.enhancementPage) || 0));
      v.enhancementPages.forEach((p, i) => { p.name ??= `加护配置${i + 1}`; p.values = Array.isArray(p.values) ? p.values.slice(0, 12) : Array(12).fill(0); while (p.values.length < 12) p.values.push(0); p.locked = Array.isArray(p.locked) ? p.locked : []; p.opened = Boolean(p.opened ?? i === 0); p.active = i === v.enhancementPage; });
      v.materials ??= {}; v.materials.fragments ??= {};
      for (const page of v.pages) page.fragments ??= clone(v.materials.fragments);
      return v;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return { version: 1, currentPage: 0, pages: Array.from({ length: 5 }, (_, i) => ({ name: `战魂配置${i + 1}`, units: {}, levels: {}, active: i === 0 })), enhancementPage: 0, enhancementPages: Array.from({ length: 5 }, (_, i) => ({ name: `加护配置${i + 1}`, opened: i === 0, active: i === 0, values: Array(12).fill(0), locked: [] })), units: {}, sets: {}, materials: { fragments: {} }, updatedAt: Date.now() };
    }
  }
  save() { if(this.frozenSnapshot)throw Error('war-soul-storage-frozen');this.state.updatedAt = Date.now(); const tmp = `${this.file}.${process.pid}.tmp`; fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.file); }
  pageFragments(page = this.state.currentPage) {
    const target = this.state.pages[n(page)];
    if (!target) return null;
    target.fragments ??= clone(this.state.materials?.fragments || {});
    return target.fragments;
  }
  resolveUnit(unitId, category = 1) {
    const id = n(unitId), cat = n(category) || 1;
    if (!id) return null;
    const key = cat === 1 ? String(id) : `${cat}:${id}`;
    return this.state.units[key] || null;
  }
  pageUnitKey(unitId, category = 1) {
    const id = n(unitId), cat = n(category) || 1;
    return cat === 1 ? String(id) : `${cat}:${id}`;
  }
  pageAllocation(unitId, category = 1, page = this.state.currentPage) {
    const p = this.state.pages[n(page)], id = n(unitId), cat = n(category) || 1;
    if (!p || !p.units || !id) return {};
    const keys = cat === 1 ? [String(id), `1:${id}`] : [`${cat}:${id}`, String(id)];
    for (const key of keys) if (p.units[key] && typeof p.units[key] === 'object') return p.units[key];
    return {};
  }
  list() { return clone(this.state); }
  renamePage(index, name) { index = n(index); if (!this.state.pages[index]) return { ok: false, reason: 'war-soul-page-not-found' }; name = String(name || '').trim(); if (!name || name.length > 32) return { ok: false, reason: 'invalid-war-soul-page-name' }; this.state.pages[index].name = name; this.save(); return { ok: true, index, name }; }
  changePage(index) { index = n(index); if (!this.state.pages[index]) return { ok: false, reason: 'war-soul-page-not-found' }; this.state.pages.forEach((p, i) => { p.active = i === index; }); this.state.currentPage = index; this.save(); return { ok: true, index }; }
  renameEnhancementPage(index, name) { index = n(index); const p = this.state.enhancementPages?.[index]; if (!p) return { ok: false, reason: 'war-soul-enhancement-page-not-found' }; name = String(name || '').trim(); if (!name || Buffer.byteLength(name, 'utf8') > 15) return { ok: false, reason: 'invalid-war-soul-enhancement-page-name' }; p.name = name; this.save(); return { ok: true, page: index, name }; }
  openEnhancementPage(index) { index = n(index); const p = this.state.enhancementPages?.[index]; if (!p) return { ok: false, reason: 'war-soul-enhancement-page-not-found' }; p.opened = true; this.save(); return { ok: true, page: index }; }
  changeEnhancementPage(index) { index = n(index); const p = this.state.enhancementPages?.[index]; if (!p) return { ok: false, reason: 'war-soul-enhancement-page-not-found' }; p.opened = true; this.state.enhancementPage = index; this.state.enhancementPages.forEach((entry, i) => { entry.active = i === index; }); this.save(); return { ok: true, page: index }; }
  washEnhancementPage({ page = this.state.enhancementPage, index = 0, operationCode = 1 } = {}) { page = n(page); index = n(index); const p = this.state.enhancementPages?.[page]; if (!p || !p.opened || index >= p.values.length) return { ok: false, reason: 'war-soul-enhancement-page-not-found' }; if (operationCode === 2) { p.values[index] = 0; } else if (operationCode === 1 || operationCode === 0) { p.values[index] = Math.max(1, Math.floor(Number(this.random()) * 255) || 1); } else if (operationCode === 5) { p.values[index] = Math.max(1, p.values[index] || 1); } else if (operationCode === 6) { p.values[index] = 0; } else return { ok: false, reason: 'invalid-war-soul-enhancement-operation' }; this.save(); return { ok: true, page, index, value: p.values[index], operationCode }; }
  unit(unitId, category = 1) {
    const id = n(unitId), cat = n(category) || 1; if (!id) return null;
    const key = cat === 1 ? String(id) : `${cat}:${id}`;
    this.state.units[key] ??= { unitId: id, level: 0, exp: 0, category: cat, nodes: {}, entries: {} };
    const u = this.state.units[key]; u.unitId = id; u.category = cat; u.nodes ??= {}; u.entries ??= {}; return u;
  }
  stageRows(unitId, category = 1) {
    const id = n(unitId), cat = n(category) || 1;
    const rows = stageCfg.filter(r => Number(r[2]) === id && Number(r[1]) === cat);
    // Unknown legacy selectors retain their history but do not inherit a
    // different node's attributes, prices, refunds or chapter degree.
    return rows;
  }
  stageAttr(row) {
    // SWarSoulStage keeps character attributes in columns 5/6 and the
    // separate war-soul restraint/resistance values in columns 7/8.
    const attr = Number(row?.[5] || 0), value = Number(row?.[6] || 0);
    return attr ? { attr, value } : null;
  }
  stageSoul(row) { const id = Number(row?.[7] || 0), value = Number(row?.[8] || 0); return id ? { id, value } : null; }
  chapterDegree(page,category){
    const target=this.state.pages[page];if(!target)return null;
    let total=0;const seen=new Set();
    for(const [key,level]of Object.entries(target.levels||{})){
      const parts=key.split(':'),cat=parts.length===1?1:Number(parts[0]),unitId=Number(parts.at(-1));
      if(cat!==category)continue;
      if(!/^(?:[1-4]:)?[1-9][0-9]*$/.test(key)||seen.has(unitId)||!Number.isInteger(level)||level<0||level>5||!Number.isInteger(unitId)||unitId<1||unitId>1280)return null;
      seen.add(unitId);
      // Native 148a560/148a61e sums exact stage/index rows from rank 0
      // through the selected level. 544b4e maps protobuf field9 to +34;
      // field12 and GS are separate values, not substitutes for this sum.
      const rows=stageCfg.filter(row=>Number(row[1])===cat&&Number(row[2])===unitId);
      for(let rank=0;rank<=level;rank++){
        const found=rows.filter(row=>Number(row[3])===rank);
        if(found.length!==1||!Number.isSafeInteger(Number(found[0][9]))||Number(found[0][9])<0)return null;
        total+=Number(found[0][9]);if(!Number.isSafeInteger(total))return null;
      }
    }
    return total;
  }
  chapterUnlocked(page,category){
    if(!Number.isInteger(category)||category<1||category>4)return false;
    // Lua RefreshStageInfo adds each earlier chapter only after its own
    // threshold is met. Recalculate the edited page, never global or historical
    // maxima; a refund may relock later chapters without deleting their audit.
    let accumulated=0;
    for(let cat=1;cat<=category;cat++){
      const threshold=Number(chapterLocks[String(cat)]);
      if(!Number.isSafeInteger(threshold)||threshold<0||cat>1&&accumulated<threshold)return false;
      if(cat===category)return true;
      const degree=this.chapterDegree(page,cat);if(degree===null)return false;accumulated+=degree;
    }
    return false;
  }
  levelUpUnit({ unitId, count = 1, exp = 0, category = null, availableMaterials = null, currentLevel = null } = {}) {
    const id=Number(unitId),cat=category===null?1:Number(category);
    if(!Number.isInteger(id)||id<1||id>1280||!Number.isInteger(cat)||cat<1||cat>4)return {ok:false,reason:'war-soul-unit-not-found'};
    const rows=stageCfg.filter(row=>Number(row[1])===cat&&Number(row[2])===id);
    if(!rows.length)return {ok:false,reason:'war-soul-unit-not-found'};
    const gain = Math.max(0, Math.floor(Number(exp) || Number(count) || 0)); if (!gain) return { ok: false, reason: 'invalid-war-soul-material' };
    const max = Math.max(1, ...rows.map(r => Number(r[3]) || 0)),prior=this.resolveUnit(id,cat);
    const pageScoped = currentLevel !== null && currentLevel !== undefined;
    const startLevel = pageScoped ? Math.max(0, Math.min(max, n(currentLevel))) : Math.max(0, n(prior?.level));
    // The table's last column is nGS (score), not an experience price.  The
    // native panel consumes one material unit per level; callers that provide
    // a larger exp/count simply advance as many levels as available.
    const advance = Math.min(max - startLevel, gain), costs = {};
    for (let level = startLevel + 1; level <= startLevel + Math.max(0, advance); level++) {
      const row = rows.find(value => Number(value[3]) === level);
      for (const [itemId, amount] of Object.entries(materialCosts(row?.[4]))) costs[itemId] = (costs[itemId] || 0) + amount;
    }
    if (!materialsAvailable(costs, availableMaterials)) return { ok: false, reason: 'war-soul-material-insufficient', costs };
    const u=this.unit(id,cat);
    const nextLevel = startLevel + Math.max(0, advance);
    if (!pageScoped) {
      u.level = nextLevel;
      const page = this.state.pages[this.state.currentPage];
      if (page) { page.levels ??= {}; page.levels[this.pageUnitKey(u.unitId, u.category)] = nextLevel; }
    }
    else u.level = Math.max(n(u.level), nextLevel);
    u.exp = Math.max(0, gain - Math.max(0, advance));
    u.stats = {}; u.warSoulStats = {};
    for (const row of rows.filter(r => Number(r[3]) <= u.level)) {
      const pair = this.stageAttr(row); if (pair) u.stats[pair.attr] = Math.max(u.stats[pair.attr] || 0, pair.value);
      const soul = this.stageSoul(row); if (soul) u.warSoulStats[soul.id] = Math.max(u.warSoulStats[soul.id] || 0, soul.value);
    }
    this.save(); return { ok: true, unitId: u.unitId, level: nextLevel, exp: u.exp, category: u.category, costs };
  }
  bulkLevelUp({ unitIds = [], count = 1, mode = 0, stage = 0, category = null, page = this.state.currentPage, availableMaterials = null } = {}) {
    const requestedCategory=category===null?1:Number(category);
    if(!Number.isInteger(requestedCategory)||requestedCategory<1||requestedCategory>4||!Number.isInteger(Number(stage))||Number(stage)<0||Number(stage)>3)return {ok:false,reason:'invalid-war-soul-chapter'};
    page = n(page);
    stage = Math.max(0, n(stage));
    const targetPage = this.state.pages[page];
    if (!targetPage) return { ok: false, reason: 'war-soul-page-not-found' };
    if(!this.chapterUnlocked(page,requestedCategory))return {ok:false,reason:'war-soul-chapter-locked'};
    const ids = [...new Set((Array.isArray(unitIds) ? unitIds : []).map(n).filter(Boolean))];
    if (!ids.length) return { ok: false, reason: 'war-soul-unit-not-found' };
    if(ids.some(unitId=>!stageCfg.some(row=>Number(row[1])===requestedCategory&&Number(row[2])===unitId)))return {ok:false,reason:'war-soul-unit-not-found'};
    const held = availableMaterials && typeof availableMaterials === 'object'
      ? (typeof availableMaterials.get === 'function' ? Object.fromEntries(availableMaterials) : { ...availableMaterials }) : null;
    const results = [], costs = {};
    const selectedCategory = n(category) || 1;
    for (const unitId of ids) {
      let last = null;
      const key = this.pageUnitKey(unitId, selectedCategory);
      let pageLevel = Object.prototype.hasOwnProperty.call(targetPage.levels || {}, key)
        ? Math.max(0, n(targetPage.levels[key]))
        : 0;
      // The native 203-byte request carries the selected plan and chapter;
      // mode is serialized first, followed by edited page and chapter.
      // Lua uses mode 2 to finish the filtered entries up to five stars.
      const target = (Number(mode) >= 1 || ids.length > 1)
        ? 5
        : Math.max(1, Number(count) || 1);
      for (let step = 0; step < target; step++) {
        const result = this.levelUpUnit({ unitId, count: 1, category, currentLevel: pageLevel, availableMaterials: held });
        if (!result.ok) break;
        last = result;
        pageLevel = Math.max(0, n(result.level));
        for (const [itemId, amount] of Object.entries(result.costs || {})) {
          costs[itemId] = (costs[itemId] || 0) + amount;
          if (held) held[itemId] = Math.max(0, Number(held[itemId] || 0) - amount);
        }
        if (Number(result.level) >= 5) break;
      }
      if (last) {
        results.push(last);
        // Native 36267 carries the selected stage lane and unit selectors.
        // The 36273 snapshot records the selected node as a one-byte active
        // value, while the persistent model stores that same choice under
        // pages[n].units[unitId][stage].  Keep the global level-up result and
        // the saved page allocation in one atomic operation so a return to
        // the lobby cannot render an empty scheme after the client selected
        // nodes successfully.
        const nodeId = String(stage + 1);
        targetPage.units ??= {};
        targetPage.units[key] ??= {};
        targetPage.units[key][nodeId] = Math.max(1, n(targetPage.units[key][nodeId]) || 1);
        targetPage.levels ??= {};
        targetPage.levels[key] = Math.max(0, Math.min(255, Number(pageLevel) || 0));
        const resolved = this.resolveUnit(unitId, selectedCategory);
        if (resolved) { resolved.nodes ??= {}; resolved.nodes[nodeId] = targetPage.units[key][nodeId]; }
      }
    }
    if (!results.length) return { ok: false, reason: 'war-soul-material-insufficient', costs };
    this.save();
    return { ok: true, count: results.length, unitIds: results.map(result => result.unitId), results, costs };
  }
  resetPage(index = this.state.currentPage) { index = n(index); const p = this.state.pages[index]; if (!p) return { ok: false, reason: 'war-soul-page-not-found' }; p.units = {}; p.levels = {}; this.save(); return { ok: true, index }; }
  bulkReset({ mode = 0, unitIds = [], category = 1, page = this.state.currentPage } = {}) {
    if(!Number.isInteger(Number(category))||Number(category)<1||Number(category)>4)return {ok:false,reason:'invalid-war-soul-chapter'};
    page = n(page); const target = this.state.pages[page]; if (!target) return { ok: false, reason: 'war-soul-page-not-found' };
    const ids = [...new Set((Array.isArray(unitIds) ? unitIds : []).map(n).filter(Boolean))];
    const selectedCategory = n(category) || 1;
    // A plan reset (mode 0 with no selectors) is a whole-plan operation. It
    // must clear every chapter, otherwise later chapters remain unlocked in
    // the native snapshot after chapter 1 is reset.
    const categories = !ids.length && n(mode) === 0
      ? [1, 2, 3, 4]
      : [selectedCategory];
    const selected = ids.length ? ids : Object.entries(this.state.units)
      .filter(([key, value]) => categories.includes(Number(value?.category || 1)))
      .map(([, value]) => Number(value.unitId)).filter(Boolean);
    const refunds = {};
    const resetUnit = (unitId, cat) => {
      const key = this.pageUnitKey(unitId, cat);
      const u = this.state.units[key];
      const level = Math.max(0, n(target.levels?.[key]));
      if (u) {
        const rows = this.stageRows(u.unitId, u.category);
        for (let rank = 1; rank <= level; rank++)
          for (const [itemId, amount] of Object.entries(materialCosts(rows.find(row => Number(row[3]) === rank)?.[4])))
            refunds[itemId] = (refunds[itemId] || 0) + amount;
      }
      delete target.units[key]; delete target.levels?.[key];
      if (u) {
        u.level = Math.max(0, ...this.state.pages.map(p => n(p.levels?.[key])));
        u.exp = 0; u.stats = {}; u.warSoulStats = {}; u.nodes = {};
        for (const row of this.stageRows(u.unitId, u.category).filter(row => Number(row[3]) <= u.level)) {
          const pair = this.stageAttr(row); if (pair) u.stats[pair.attr] = Math.max(u.stats[pair.attr] || 0, pair.value);
          const soul = this.stageSoul(row); if (soul) u.warSoulStats[soul.id] = Math.max(u.warSoulStats[soul.id] || 0, soul.value);
        }
      }
    };
    for (const cat of categories) {
      const chapterIds = ids.length && cat === selectedCategory ? selected : Object.entries(this.state.units)
        .filter(([key, value]) => Number(value?.category || 1) === cat)
        .map(([, value]) => Number(value.unitId)).filter(Boolean);
      for (const unitId of chapterIds) resetUnit(unitId, cat);
    }
    // Resetting a complete earlier chapter invalidates the cumulative unlock
    // chain. Clear subsequent chapters as well, including their refunds.
    if (ids.length && ids.length >= 300 && selectedCategory < 4) {
      for (const cat of [selectedCategory + 1, selectedCategory + 2, selectedCategory + 3]) {
        if (cat > 4) break;
        const chapterIds = Object.entries(this.state.units).filter(([, value]) => Number(value?.category || 1) === cat).map(([, value]) => Number(value.unitId)).filter(Boolean);
        for (const unitId of chapterIds) resetUnit(unitId, cat);
      }
    }
    if (!ids.length && n(mode) === 0) { target.units = {}; target.levels = {}; }
    this.save();
    return { ok: true, page, mode: n(mode), unitIds: ids, count: selected.length, categories, refunds };
  }
  allocate({ page = this.state.currentPage, unitId, nodeId, value = 1, category = 1 } = {}) { const p = this.state.pages[n(page)], u = this.unit(unitId, n(category) || 1); if (!p || !u) return { ok: false, reason: 'war-soul-unit-not-found' }; nodeId = n(nodeId); value = n(value); const row = this.stageRows(u.unitId, u.category).find(item => Number(item[3]) === nodeId); if (!nodeId || !row || value <= 0 || value > u.level) return { ok: false, reason: 'invalid-war-soul-node' }; const key = this.pageUnitKey(unitId, category); p.units[key] ??= {}; p.units[key][String(nodeId)] = value; u.nodes[String(nodeId)] = value; this.save(); return { ok: true, page: n(page), unitId: u.unitId, category: u.category, nodeId, value }; }
  renameSet({ unitId, setId = 1, name } = {}) { const u = this.unit(unitId), id = n(setId); if (!u) return { ok: false, reason: 'war-soul-unit-not-found' }; if (id < 1 || id > 8) return { ok: false, reason: 'war-soul-set-limit' }; name = String(name || '').trim(); if (!name || name.length > 32) return { ok: false, reason: 'invalid-war-soul-set-name' }; u.entries[String(id)] ??= {}; u.entries[String(id)].name = name; this.save(); return { ok: true, unitId: u.unitId, setId: id, name }; }
  openSet({ unitId, setId = 1 } = {}) { const u = this.unit(unitId); if (!u) return { ok: false, reason: 'war-soul-unit-not-found' }; setId = n(setId); if (setId < 1 || setId > 8) return { ok: false, reason: 'war-soul-set-limit' }; const entry = u.entries[String(setId)] ??= {}; entry.name ??= `战魂套${setId}`; entry.locked ??= []; entry.attrs ??= []; entry.active = true; this.save(); return { ok: true, unitId: u.unitId, setId, entry: clone(entry) }; }
  lock({ unitId, setId = 1, index = 0, locked = true } = {}) { const u = this.unit(unitId), id = n(index); const e = u?.entries?.[String(n(setId))]; if (!e) return { ok: false, reason: 'war-soul-set-not-found' }; if (id < 0 || id >= 6) return { ok: false, reason: 'invalid-war-soul-lock' }; const set = new Set(e.locked || []); locked ? set.add(id) : set.delete(id); e.locked = [...set].sort((a, b) => a - b); this.save(); return { ok: true, locked: e.locked }; }
  wash({ unitId, setId = 1, operation = 'build' } = {}) { const u = this.unit(unitId); const e = u?.entries?.[String(n(setId))]; if (!e) return { ok: false, reason: 'war-soul-set-not-found' }; if (!['build', 'apply', 'cancel'].includes(operation)) return { ok: false, reason: 'invalid-war-soul-wash-operation' }; if (operation === 'build') { const preferred = succinctCfg.filter(r => Number(r[2]) === Number(u.category)); const pool = preferred.length ? preferred : succinctCfg; const row = pool[Math.floor((Number(this.random()) || 0) * Math.max(1, pool.length))] || succinctCfg[0]; e.candidate = { succinctId: Number(row?.[1] || 0), warSoulId: Number(row?.[2] || 0), statusId: Number(row?.[3] || 0), returnTicket: Number(row?.[12] || 0), type: Number(row?.[8] || 0), soulValue: String(row?.[9] || ''), text: String(row?.[4] || '') }; } else if (operation === 'apply') { if (!e.candidate) return { ok: false, reason: 'no-war-soul-candidate' }; e.attrs = [...(e.attrs || []).filter(a => a.succinctId !== e.candidate.succinctId), e.candidate]; delete e.candidate; } else delete e.candidate; this.save(); return { ok: true, entry: clone(e) }; }
  changeSet({ unitId, setId = 1 } = {}) { const u = this.unit(unitId); if (!u?.entries?.[String(n(setId))]) return { ok: false, reason: 'war-soul-set-not-found' }; for (const e of Object.values(u.entries)) e.active = false; u.entries[String(n(setId))].active = true; this.save(); return { ok: true, setId: n(setId) }; }
  burn({ unitId, setId = 1 } = {}) { const u = this.unit(unitId); const id = String(n(setId)); if (!u?.entries?.[id]) return { ok: false, reason: 'war-soul-set-not-found' }; const entry = u.entries[id]; const gain = Math.max(1, (entry.attrs || []).length) * 10; delete u.entries[id]; this.state.materials.warSoul = (this.state.materials.warSoul || 0) + gain; this.save(); return { ok: true, gain }; }
  transform({ unitId, setId = 1, targetUnitId } = {}) { const u = this.unit(unitId), target = this.unit(targetUnitId); const e = u?.entries?.[String(n(setId))]; if (!u || !target || !e) return { ok: false, reason: 'war-soul-transform-invalid' }; target.entries[String(n(setId))] = clone(e); delete u.entries[String(n(setId))]; this.save(); return { ok: true, sourceUnitId: u.unitId, targetUnitId: target.unitId, setId: n(setId) }; }
  combatBonus(unitId, setId = 1, page = this.state.currentPage, category = 1) {
    const id = n(unitId), u = this.resolveUnit(id, category), out = {};
    const level = n(this.state.pages[n(page)]?.levels?.[this.pageUnitKey(id, category)]);
    if (u) for (const row of this.stageRows(id, u.category).filter(row => Number(row[3]) <= level)) {
      const pair = this.stageAttr(row); if (pair) out[pair.attr] = Math.max(out[pair.attr] || 0, pair.value);
    }
    // Washed entries are native effect descriptors (effect/entry IDs), not
    // character attribute IDs. Keep them out of the numeric stat map; callers
    // can consume the descriptors through warSoulEffects().
    return out;
  }
  // The stage table stores four restraint channels (32..35) and four
  // resistance channels (45..48) separately from character attributes. They
  // feed the native war-soul damage multiplier and must stay out of the
  // ordinary attribute map.
  soulProfile(unitId, setId = 1, page = this.state.currentPage, category = 1) {
    const id = n(unitId), u = this.resolveUnit(id, category);
    if (!u) return { restraint: {}, resistance: {}, averageRestraint: 0, averageResistance: 0 };
    const rows = this.stageRows(id, u.category), values = {};
    const level = n(this.state.pages[n(page)]?.levels?.[this.pageUnitKey(id, category)]);
    for (const row of rows) if (Number(row[3]) <= level) {
      const soul = this.stageSoul(row); if (soul) values[soul.id] = Math.max(values[soul.id] || 0, soul.value);
    }
    const restraint = {}, resistance = {};
    for (const channel of [32, 33, 34, 35]) restraint[channel] = Number(values[channel] || 0);
    for (const channel of [45, 46, 47, 48]) resistance[channel] = Number(values[channel] || 0);
    const avg = group => Object.values(group).reduce((sum, value) => sum + value, 0) / 4;
    return { restraint, resistance, averageRestraint: avg(restraint), averageResistance: avg(resistance) };
  }
  effects(unitId, setId = 1, page = this.state.currentPage, category = 1) {
    const id = n(unitId), entry = this.resolveUnit(id, category)?.entries?.[String(n(setId))];
    const allocation = this.pageAllocation(id, category, page);
    return (Object.keys(allocation).length && entry?.active ? entry.attrs || [] : []).map(value => clone(value));
  }
  levelUp(args) { return this.levelUpUnit(args); }
  reset(args) { return this.resetPage(args); }
  change(args) { return this.changePage(args); }
}

// 36273 is a fixed native snapshot.  Controlled original-server captures show
// the per-entry activation byte at absolute frame offset 8031 + entry index:
// e.g. requests for 236/306 changed 8267, while 287/307 changed 8318/8338.
// Keep all other fields from the native template untouched until their wire
// meanings are confirmed.
function nativeMaterialBalances(frame, page = 0) {
  const out = {}, valid = new Set(materialCfg.map(row => Number(row?.[1])).filter(Boolean));
  if (!Buffer.isBuffer(frame)) return out;
  // 36273's verified material table is [materialId,count] pairs at payload
  // offset 4020 (12 bytes after the frame header).
  const start = 4032 + page * 9151;
  for (let offset = start; offset + 8 <= Math.min(frame.length, start + 4000); offset += 8) {
    const id = frame.readUInt32LE(offset), count = frame.readUInt32LE(offset + 4);
    if (!id && !count) break;
    if (valid.has(id)) out[id] = count;
  }
  return out;
}

function patchNativeRefreshFrame(frame, state) {
  if (!Buffer.isBuffer(frame)) return null;
  const out = Buffer.from(frame);
  // Oct 7: five 9151-byte plan records, each with a 15-byte GBK name
  // at frame offset 4017+n*9151. Rebuild every level lane, including zeros;
  // patching only present entries resurrected captured levels after reset.
  const page = Math.max(0, Math.min(4, Number(state?.currentPage) || 0));
  if (out.length > 12) out[12] = page;
  const pages = Array.isArray(state?.pages) ? state.pages : null;
  for (const plan of pages ? [0, 1, 2, 3, 4] : [page]) {
    const record = pages?.[plan];
    if (pages && 4017 + plan * 9151 + 15 <= out.length)
      require('./loadout-page-wire').nameBytes(record?.name, 15).copy(out, 4017 + plan * 9151);
    const units = pages ? record?.levels || {} : state?.units || {};
    const bases = Array.from({ length: 4 }, (_, chapter) => 8031 + plan * 9151 + chapter * 1284);
    for (const base of bases) {
      if (base + 1 < out.length) out.fill(0, base + 1, Math.min(base + 1281, out.length));
    }
    for (const [key, value] of Object.entries(units)) {
      const composite = /^([0-9]+):([0-9]+)$/.exec(key);
      const category = composite ? Number(composite[1]) : Number(value?.category || 1);
      const index = composite ? Number(composite[2]) : Number(key);
      const level = typeof value === 'object' ? Number(value?.level) || 0 : Number(value) || 0;
      if (!Number.isInteger(index) || index < 1 || index > 1280 || category < 1 || category > 4) continue;
      const offset = bases[category - 1] + index;
      if (offset < out.length) out[offset] = Math.max(0, Math.min(255, level));
    }
    for (const base of bases) {
      if (base + 1285 > out.length) continue;
      // bebe43/bebe90 supplies this word to SetTotalUnLockDegree. It is
      // the sum of exact field9 rank0..level values, not a node count.
      const category=bases.indexOf(base)+1;let degree=0;
      for(let index=1;index<=1280;index++){
        const level=out[base+index];if(!level)continue;
        for(let rank=0;rank<=level;rank++){
          const rows=nativeStageRows.get(`${category}:${index}:${rank}`)||[];
          if(rows.length!==1||!Number.isSafeInteger(Number(rows[0][9]))||Number(rows[0][9])<0)return null;
          degree+=Number(rows[0][9]);
        }
      }
      if(!Number.isSafeInteger(degree)||degree>0xffffffff)return null;
      out.writeUInt32LE(degree, base + 1281);
    }
  }
  // Each plan has its own 500-entry remaining-fragment table. The first
  // account table contains the collected stock, not a shared spending pool.
  function writeMaterials(start, fragments) {
    if (!fragments || start + 8 > out.length) return;
    const end = Math.min(out.length, start + 4000);
    out.fill(0, start, end);
    let offset = start;
    for (const [id, amount] of Object.entries(fragments).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (offset + 8 > end) break;
      out.writeUInt32LE(Number(id) >>> 0, offset);
      out.writeUInt32LE(Math.max(0, Number(amount) || 0) >>> 0, offset + 4);
      offset += 8;
    }
  }
  const stock = state?.materials?.fragments;
  if (stock && Object.keys(stock).length) writeMaterials(17, stock);
  for (let plan = 0; plan < 5; plan++) {
    const fragments = state?.pages?.[plan]?.fragments ?? stock;
    if (fragments && (state?.pages?.[plan]?.fragments || Object.keys(fragments).length))
      writeMaterials(4032 + plan * 9151, fragments);
  }
  return out;
}

module.exports = { WarSoulState, stageCfg, materialCfg, succinctCfg, consumptionCfg, nativeMaterialBalances, patchNativeRefreshFrame };
