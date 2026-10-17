'use strict';
const fs = require('./persistence/state-files').io;
const path = require('path');
const itemRows = require('./logs/cfg/charmitemlist.json');
const customizeRows = require('./logs/cfg/charmcustomize.json');
const godsendRows = require('./logs/cfg/charmexeffect.json');
const patterns = new Map();
for (const row of itemRows) patterns.set(Number(row[1]), row);
const colors = { red: 1, green: 2, blue: 3, yellow: 4, multi: 5 };
const colorName = { 1: 'red', 2: 'green', 3: 'blue', 4: 'yellow', 5: 'multi' };
const clone = value => JSON.parse(JSON.stringify(value));
const int = value => Number.isInteger(Number(value)) ? Number(value) : 0;
// Native clients address a rune by a persistent eight-byte onlyId.  The
// local harness still uses small numeric ids, so keep both forms losslessly.
const runeKey = value => {
  if (typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value)) return value.toLowerCase();
  const n = Number(value); return Number.isFinite(n) ? String(n) : String(value || '');
};
const runeId = value => {
  if (typeof value === 'string' && /^[0-9a-f]{16}$/i.test(value)) return value.toLowerCase();
  const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0;
};
// Page names are displayed directly by the native client.  A malformed
// fixed-width decode can otherwise persist a control byte (the old dev state
// had "\u0002"), which makes the page look blank and prevents later saves from
// being associated with a usable page name.
const normalizePageName = (value, fallback) => {
  const text = String(value ?? '').replace(/\0.*$/, '').trim();
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text.slice(0, 32);
};
// The native board contains 48 cells (equip_charm.lua and Oct 7 capture).
const SLOT_COUNT = 48;

// charmexeffect marks event/limited godsend rows with column 6.  Keep the
// names and ids from the client table so a level-V strengthen can return the
// same godsend identity the native client would display.
const GODSEND_ROWS = godsendRows
  .map(row => ({ id: int(row[1]), name: String(row[2] || ''), limited: Number(row[6]) === 1 }))
  .filter(row => row.id > 0 && row.name);
const GODSEND_BY_ID = new Map(GODSEND_ROWS.map(row => [row.id, row]));
const REGULAR_GODSEND_IDS = GODSEND_ROWS.filter(row => !row.limited).map(row => row.id);
const LIMITED_GODSEND_IDS = GODSEND_ROWS.filter(row => row.limited).map(row => row.id);
// These event/special godsend identities are selectable through dedicated
// rune items, but the native strengthen roll never awards them. Keep the
// exclusion explicit instead of inferring it from the limited flag: other
// limited godsend rows remain valid strengthen results when that pool is on.
const STRENGTHEN_BLOCKED_GODSEND_IDS = new Set([19, 25, 26, 27]);
const DEFAULT_GODSEND = Object.freeze({
  enabledLimited: false,
  // The client exposes one limited-pool activation.  It is consumed when
  // XReqCharmNotWant(0, 0) is accepted and remains active for 24 hours.
  limitedRemaining: 1,
  limitedExpiresAt: 0,
  // The captured configuration identifies the limited pool but does not
  // expose its split probability. Keep that value configurable until a
  // level-V native result gives us the exact server-side rate.
  limitedChance: 0.5,
  chance: 0.16,
  smallPity: 0,
  largePity: { regular: 0, limited: 0 },
  wish: { type: null, id: null },
  filterSlots: 2,
  filterBans: [],
  ownedGodsendIds: [],
});

// The limited pool is active only during the 24-hour window created by the
// explicit activation action.  An old state may contain enabledLimited=true
// without an expiry; that is an incomplete legacy flag and must not unlock
// limited godsend results by itself.
const limitedGodsendActive = source => Boolean(source?.enabledLimited && Number(source?.limitedExpiresAt) > Date.now());

function normalizeGodsendState(value) {
  const source = value && typeof value === 'object' ? value : {};
  const large = source.largePity && typeof source.largePity === 'object' ? source.largePity : {};
  const wish = source.wish && typeof source.wish === 'object' ? source.wish : {};
  const ownedGodsendIds = [...new Set((Array.isArray(source.ownedGodsendIds) ? source.ownedGodsendIds : [])
    .map(int).filter(id => id > 0 && id <= 0xffff))];
  // The client creates ten controls, while the server unlocks them by
  // collection progress.  Every three distinct godsend identities grant one
  // additional usable Ban slot, starting from the two base slots.
  const earnedFilterSlots = Math.max(2, Math.min(10, 2 + Math.floor(ownedGodsendIds.length / 3)));
  const filterSlots = Math.max(earnedFilterSlots, Math.min(10, int(source.filterSlots || DEFAULT_GODSEND.filterSlots)));
  const filterBans = Array.from({ length: filterSlots }, (_, index) => {
    const id = Array.isArray(source.filterBans) ? int(source.filterBans[index]) : 0;
    // Filter packets carry the persistent godsend id.  The local charmexeffect
    // table is incomplete on older builds, so an id that is not in that table
    // must still survive a save/reload cycle instead of being erased.
    return id > 0 && id <= 0xffff ? id : 0;
  });
  const type = wish.type === 'regular' || wish.type === 'limited' ? wish.type : null;
  const wishedId = int(wish.id);
  const validWish = type && (type !== 'limited' || limitedGodsendActive(source)) && GODSEND_BY_ID.get(wishedId) &&
    (type === 'limited' ? GODSEND_BY_ID.get(wishedId).limited : !GODSEND_BY_ID.get(wishedId).limited)
    ? wishedId : null;
  return {
    enabledLimited: Boolean(source.enabledLimited),
    limitedRemaining: Math.max(0, int(source.limitedRemaining === undefined ? DEFAULT_GODSEND.limitedRemaining : source.limitedRemaining)),
    limitedExpiresAt: Math.max(0, int(source.limitedExpiresAt)),
    limitedChance: Math.max(0, Math.min(1, Number.isFinite(Number(source.limitedChance)) ? Number(source.limitedChance) : DEFAULT_GODSEND.limitedChance)),
    chance: Math.max(0, Math.min(1, Number.isFinite(Number(source.chance)) ? Number(source.chance) : DEFAULT_GODSEND.chance)),
    smallPity: Math.max(0, Math.min(10, int(source.smallPity))),
    largePity: {
      regular: Math.max(0, Math.min(20, int(large.regular))),
      limited: Math.max(0, Math.min(20, int(large.limited))),
    },
    wish: { type: validWish ? type : null, id: validWish },
    filterSlots,
    filterBans,
    ownedGodsendIds,
  };
}

function template(color, level) {
  color = typeof color === 'string' ? colors[color] || 5 : int(color); level = int(level);
  const id = color === 5 ? 500 + level : color * 100 + level, row = patterns.get(id);
  if (!row) throw new RangeError('unknown-rune-template');
  const attrs = {};
  // Columns 7..41 are the displayed values.  Column 42 is the authoritative
  // native attribute list (for example red level 1 is value column 9 with
  // native id 30); it must not be treated as a passive/effect list.
  const valueColumns = { 7: 8, 8: 9, 9: 30, 10: 31, 11: 42, 12: 44, 13: 106, 14: 107, 15: 15, 16: 17, 17: 12, 18: 13, 19: 97, 20: 98, 21: 14, 22: 18, 23: 24, 24: 25, 25: 100, 26: 36, 27: 37, 28: 10, 29: 11, 30: 149, 31: 128, 32: 108, 33: 109, 34: 17, 35: 99, 36: 147, 37: 148, 38: 149, 39: 150, 40: 151, 41: 152 };
  const nativeIds = String(row[42] || '').split(/[;:,]/).map(Number).filter(Number.isFinite);
  const values = Object.entries(valueColumns).filter(([column]) => Number(row[column]));
  if (nativeIds.length === 1 && values.length === 1) attrs[nativeIds[0]] = Number(row[values[0][0]]);
  else for (const [column, attr] of values) attrs[attr] = Number(row[column]);
  return { itemId: id, color, colorName: colorName[color] || 'multi', level, name: String(row[2] || `符文${id}`), attrs, effects: [], nativeAttrIds: nativeIds, godsend: null, godsendId: null, godsendName: null, locked: false };
}

// The client renders attributes in the order in which they are unlocked.
// Keep that order in the serialized object as well, because the native list
// packet has no separate sort key and preserves insertion order on screen.
function attrUnlockLevel(attrId) {
  const id = Number(attrId);
  for (let level = 1; level <= 5; level++) {
    for (const color of [1, 2, 3, 4]) {
      try {
        if (Object.prototype.hasOwnProperty.call(template(color, level).attrs || {}, id)) return level;
      } catch {}
    }
  }
  return 99;
}

function orderedRuneAttrs(attrs) {
  const entries = Object.entries(attrs || {}).map(([id, value], index) => ({ id, value, index }));
  entries.sort((a, b) => attrUnlockLevel(a.id) - attrUnlockLevel(b.id) || a.index - b.index);
  return entries.map(entry => [entry.id, entry.value]);
}

function sortRuneAttrs(attrs) {
  return Object.fromEntries(orderedRuneAttrs(attrs));
}

// The item table stores cumulative values for each level.  Strengthening
// rolls only the lines introduced at the target level, so derive that delta
// instead of treating the whole cumulative row as a candidate pool.
function unlockedAttrs(color, level) {
  level = int(level);
  let current = {}, previous = {};
  try { current = template(color, level).attrs || {}; } catch {}
  if (level > 1) {
    try { previous = template(color, level - 1).attrs || {}; } catch {}
  }
  return Object.entries(current).filter(([attr, value]) => previous[attr] === undefined && Number(value) > 0);
}

class RuneState {
  constructor({ file = path.join(__dirname, 'rune-state.json'), random = Math.random } = {}) {
    this.file = file; this.random = random; this.state = this.read();
    // Loading combat snapshots is read-only. Persist normalization with the
    // next explicit mutation, never overwrite a newer lobby save on a read.
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!value || value.version !== 1 || !Array.isArray(value.pages)) throw Error('invalid-rune-state');
      value.pages.forEach((p, index) => {
        p.name = normalizePageName(p.name, `符文页${index + 1}`);
        p.slots = Array.from({ length: SLOT_COUNT }, (_, i) => p.slots?.[i] ?? null);
        // The local test account intentionally starts with every rune grid
        // slot open. Normalize old files to the same all-open policy.
        p.openSlots = Array.from({ length: SLOT_COUNT }, () => true);
      });
      value.tokens ??= {}; value.inventory ??= {}; value.nativeBoards ??= {};
      for (const rune of Object.values(value.inventory)) {
        if (!rune || typeof rune !== 'object') continue;
        if (rune.attrs && typeof rune.attrs === 'object') {
          rune.attrs = sortRuneAttrs(rune.attrs);
          // Repair pure-colour records produced by the old cumulative-pool
          // bug. Mixed runes intentionally keep their cross-colour lines.
          if (Number(rune.color) >= 1 && Number(rune.color) <= 4) {
            let expected = {};
            try { expected = template(rune.color, rune.level).attrs || {}; } catch {}
            const invalid = Object.keys(rune.attrs).some(attr => expected[attr] === undefined);
            if (invalid) rune.attrs = Object.keys(expected).length ? { ...expected } : rune.attrs;
          }
        }
        if (Array.isArray(rune.nativeAttrIds)) rune.nativeAttrIds = orderedRuneAttrs(rune.attrs || {}).map(([id]) => Number(id));
        const row = GODSEND_BY_ID.get(int(rune.godsendId));
        if (rune.godsend === undefined) rune.godsend = row ? { id: row.id, name: row.name, limited: row.limited } : null;
        if (rune.godsendId === undefined) rune.godsendId = row?.id || null;
        if (rune.godsendName === undefined) rune.godsendName = row?.name || null;
        // Item locks are instance-scoped.  unlockAt is the native absolute
        // Unix-second deadline returned by 11762; older saves only carried
        // the boolean and therefore remain locked until a new unlock request.
        rune.locked = Boolean(rune.locked);
        rune.unlockAt = Number.isFinite(Number(rune.unlockAt)) ? Math.max(0, Number(rune.unlockAt)) : 0;
      }
      const inventoryGodsendIds = Object.values(value.inventory || {}).map(rune => int(rune?.godsendId)).filter(id => id > 0);
      value.godsend = normalizeGodsendState({
        ...value.godsend,
        ownedGodsendIds: [...(value.godsend?.ownedGodsendIds || []), ...inventoryGodsendIds],
      });
      return value;
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return {
        version: 1, nextId: 1, currentPage: 0,
        pages: [{ name: '配置1', slots: Array(SLOT_COUNT).fill(null), openSlots: Array(SLOT_COUNT).fill(true), active: true }],
        inventory: {}, tokens: {}, fragments: 0, nativeBoards: {}, godsend: normalizeGodsendState(), updatedAt: Date.now()
      };
    }
  }
  save() { this.state.updatedAt = Date.now(); const tmp = `${this.file}.${process.pid}.tmp`; fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.file); }
  list() { return clone(this.state); }
  godsendInfo() { return clone(normalizeGodsendState(this.state.godsend)); }
  setGodsendOptions({ enabledLimited = this.state.godsend?.enabledLimited, limitedChance = this.state.godsend?.limitedChance, chance = this.state.godsend?.chance, limitedRemaining = this.state.godsend?.limitedRemaining, limitedExpiresAt = this.state.godsend?.limitedExpiresAt } = {}) {
    this.state.godsend = normalizeGodsendState({ ...this.state.godsend, enabledLimited, limitedChance, chance, limitedRemaining, limitedExpiresAt });
    if (!this.state.godsend.enabledLimited && this.state.godsend.wish.type === 'limited') this.state.godsend.wish = { type: null, id: null };
    this.save();
    return { ok: true, godsend: this.godsendInfo() };
  }
  activateLimitedGodsend() {
    const current = normalizeGodsendState(this.state.godsend);
    if (current.enabledLimited && current.limitedExpiresAt > Date.now()) {
      this.state.godsend = current;
      return { ok: true, godsend: this.godsendInfo(), alreadyEnabled: true };
    }
    if (current.limitedRemaining <= 0) return { ok: false, reason: 'limited-godsend-activation-insufficient', godsend: this.godsendInfo() };
    this.state.godsend = normalizeGodsendState({
      ...current,
      enabledLimited: true,
      limitedRemaining: current.limitedRemaining - 1,
      limitedExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    this.save();
    return { ok: true, godsend: this.godsendInfo(), activated: true };
  }
  wishGodsend({ type = 'regular', id } = {}) {
    const wished = GODSEND_BY_ID.get(int(id));
    // The old native determination request carries only an id. Infer the
    // pool from charmexeffect instead of treating every id as a regular wish.
    if (type === 'auto') type = wished?.limited ? 'limited' : 'regular';
    type = type === 'limited' ? 'limited' : type === 'regular' ? 'regular' : null;
    if (!type || !wished || (type === 'limited' && !wished.limited) || (type === 'regular' && wished.limited)) return { ok: false, reason: 'invalid-godsend-wish' };
    if (type === 'limited' && !limitedGodsendActive(this.state.godsend)) return { ok: false, reason: 'limited-godsend-disabled' };
    this.state.godsend = normalizeGodsendState({ ...this.state.godsend, wish: { type, id: wished.id } });
    this.save();
    return { ok: true, godsend: this.godsendInfo() };
  }
  clearGodsendWish() {
    this.state.godsend = normalizeGodsendState({ ...this.state.godsend, wish: { type: null, id: null } });
    this.save();
    return { ok: true, godsend: this.godsendInfo() };
  }
  setGodsendFilter({ index = 0, id = 0 } = {}) {
    const current = normalizeGodsendState(this.state.godsend);
    const slot = int(index), godsendId = int(id);
    if (slot < 1 || slot > current.filterSlots) return { ok: false, reason: 'invalid-godsend-filter-slot', godsend: this.godsendInfo(), index: slot, id: godsendId };
    if (godsendId < 0 || godsendId > 0xffff) return { ok: false, reason: 'invalid-godsend-filter-id', godsend: this.godsendInfo(), index: slot, id: godsendId };
    const filterBans = [...current.filterBans];
    filterBans[slot - 1] = godsendId;
    this.state.godsend = normalizeGodsendState({ ...current, filterBans });
    this.save();
    return { ok: true, godsend: this.godsendInfo(), index: slot, id: godsendId };
  }
  _randomUnit() {
    const value = Number(this.random());
    return Number.isFinite(value) ? Math.max(0, Math.min(.999999999, value)) : 0;
  }
  _randomGodsendId() {
    const g = this.state.godsend;
    const limitedActive = limitedGodsendActive(g);
    const useLimited = limitedActive && LIMITED_GODSEND_IDS.length && this._randomUnit() < g.limitedChance;
    const source = useLimited ? LIMITED_GODSEND_IDS : REGULAR_GODSEND_IDS;
    const pool = source.filter(id => !STRENGTHEN_BLOCKED_GODSEND_IDS.has(id));
    return pool[Math.min(pool.length - 1, Math.floor(this._randomUnit() * pool.length))];
  }
  _resolveGodsend() {
    this.state.godsend = normalizeGodsendState(this.state.godsend);
    const g = this.state.godsend;
    const wish = g.wish;
    const largeDue = wish.type && wish.id && g.largePity[wish.type] >= 20;
    const smallDue = g.smallPity >= 10;
    let id = null, trigger = 'none';
    if (largeDue && !STRENGTHEN_BLOCKED_GODSEND_IDS.has(Number(wish.id))) {
      // The active wish has priority over both the 16% roll and the small
      // pity. Its own counter is cleared only after that exact godsend lands.
      id = wish.id; trigger = 'large-pity';
    } else if (smallDue || this._randomUnit() < g.chance) {
      id = this._randomGodsendId();
      trigger = smallDue ? 'small-pity' : 'chance';
    }
    if (!id) {
      // Reaching ten arms the next attempt; it does not make the failed
      // attempt itself a guaranteed success.
      g.smallPity = Math.min(10, g.smallPity + 1);
      return { id: null, name: null, trigger: 'miss' };
    }
    g.smallPity = 0;
    if (wish.type && wish.id) {
      if (id === wish.id) g.largePity[wish.type] = 0;
      else g.largePity[wish.type] = Math.min(20, g.largePity[wish.type] + 1);
    }
    const row = GODSEND_BY_ID.get(id);
    if (!g.ownedGodsendIds.includes(id)) g.ownedGodsendIds.push(id);
    g.filterSlots = Math.max(2, Math.min(10, 2 + Math.floor(g.ownedGodsendIds.length / 3)));
    g.filterBans = Array.from({ length: g.filterSlots }, (_, index) => g.filterBans?.[index] || 0);
    return { id, name: row?.name || null, limited: Boolean(row?.limited), trigger };
  }
  renamePage(index, name) { index = int(index); if (!this.state.pages[index]) return { ok: false, reason: 'rune-page-not-found' }; const normalized = normalizePageName(name, ''); if (!normalized || normalized.length > 32) return { ok: false, reason: 'invalid-rune-page-name' }; this.state.pages[index].name = normalized; this.save(); return { ok: true, index, name: normalized }; }
  addPage(name = `配置${this.state.pages.length + 1}`) { if (this.state.pages.length >= 8) return { ok: false, reason: 'rune-page-limit' }; const normalized = normalizePageName(name, ''); if (!normalized || normalized.length > 32) return { ok: false, reason: 'invalid-rune-page-name' }; const page = { name: normalized, slots: Array(SLOT_COUNT).fill(null), openSlots: Array(SLOT_COUNT).fill(true), active: false }; this.state.pages.push(page); this.save(); return { ok: true, index: this.state.pages.length - 1, page: clone(page) }; }
  usePage(index) { index = int(index); if (!this.state.pages[index]) return { ok: false, reason: 'rune-page-not-found' }; this.state.pages.forEach((p, i) => { p.active = i === index; }); this.state.currentPage = index; this.save(); return { ok: true, index }; }
  lockRune({ runeId, locked = null } = {}) {
    const rune = this.state.inventory[runeKey(runeId)];
    if (!rune) return { ok: false, reason: 'rune-not-found' };
    const next = locked === null ? !rune.locked : Boolean(locked);
    rune.locked = next;
    if (!next) rune.unlockAt = 0;
    this.save();
    return { ok: true, rune: clone(rune), runeId: rune.id, locked: rune.locked, unlockAt: Number(rune.unlockAt) || 0 };
  }
  requestUnlockRune({ runeId, now = Date.now() } = {}) {
    const rune = this.state.inventory[runeKey(runeId)];
    if (!rune) return { ok: false, reason: 'rune-not-found' };
    const nowSeconds = Math.floor(Number(now) / 1000);
    const existing = Number(rune.unlockAt) || 0;
    if (!rune.locked) return { ok: true, rune: clone(rune), runeId: rune.id, locked: false, unlockAt: 0, alreadyUnlocked: true };
    if (existing > nowSeconds) return { ok: true, rune: clone(rune), runeId: rune.id, locked: true, unlockAt: existing, pending: true };
    if (existing > 0 && existing <= nowSeconds) {
      rune.locked = false; rune.unlockAt = 0; this.save();
      return { ok: true, rune: clone(rune), runeId: rune.id, locked: false, unlockAt: 0, unlocked: true };
    }
    rune.unlockAt = nowSeconds + 96 * 60 * 60;
    this.save();
    return { ok: true, rune: clone(rune), runeId: rune.id, locked: true, unlockAt: rune.unlockAt, pending: true };
  }
  resetPage(index = this.state.currentPage) { index = int(index); const p = this.state.pages[index]; if (!p) return { ok: false, reason: 'rune-page-not-found' }; p.slots = Array(SLOT_COUNT).fill(null); this.save(); return { ok: true, index }; }
  unlockSlot({ page = this.state.currentPage, index = 0 } = {}) {
    page = int(page); index = int(index); const p = this.state.pages[page];
    if (!p || index < 0 || index >= SLOT_COUNT) return { ok: false, reason: 'invalid-rune-slot' };
    p.openSlots = Array.from({ length: SLOT_COUNT }, () => true);
    this.save(); return { ok: true, page, index, opened: true, paymentSkipped: true };
  }
  ensureRune(id, { color = 1, level = 1 } = {}) {
    const normalized = runeId(id); if (!normalized) return null; const key = runeKey(normalized); if (this.state.inventory[key]) return this.state.inventory[key];
    let base;
    try { base = template(color, level); } catch { base = { itemId: normalized, color: 1, colorName: 'red', level: 1, name: `符文${normalized}`, attrs: {}, effects: [], godsend: null, godsendId: null, godsendName: null, locked: false }; }
    // Unknown native onlyIds can still be addressed by the live UI.  Keep a
    // neutral placeholder until the full item table is available instead of
    // rejecting the whole board update.
    if (typeof normalized === 'string') base = { itemId: normalized, color: 1, colorName: 'red', level: 1, name: `符文${normalized}`, attrs: {}, effects: [], godsend: null, godsendId: null, godsendName: null, locked: false };
    const rune = { ...base, id: normalized }; this.state.inventory[key] = rune;
    if (typeof normalized === 'number') this.state.nextId = Math.max(this.state.nextId || 1, normalized + 1);
    return rune;
  }
  slot({ page = this.state.currentPage, index, runeId: requestedId = null } = {}) {
    page = int(page); index = int(index); const p = this.state.pages[page];
    if (!p || index < 0 || index >= p.slots.length) return { ok: false, reason: 'invalid-rune-slot' };
    if (requestedId === null || requestedId === 0 || requestedId === '0') p.slots[index] = null;
    else { const rune = this.ensureRune(requestedId); if (!rune) return { ok: false, reason: 'rune-not-found' }; p.slots[index] = rune.id; }
    this.save(); return { ok: true, page, index, runeId: p.slots[index] };
  }
  grant({ color = 1, level = 1, count = 1, attrs = null } = {}) { count = int(count); if (count <= 0 || count > 9999) return { ok: false, reason: 'invalid-rune-count' }; const created = []; for (let i = 0; i < count; i++) { const base = template(color, level); if (attrs) base.attrs = { ...base.attrs, ...attrs }; const id = this.state.nextId++; this.state.inventory[String(id)] = { ...base, id }; created.push(clone(this.state.inventory[String(id)])); } this.save(); return { ok: true, runes: created }; }
  grantToken(tokenId, count = 1) { tokenId = int(tokenId); count = int(count); if (tokenId <= 0 || count <= 0) return { ok: false, reason: 'invalid-rune-token' }; this.state.tokens ??= {}; this.state.tokens[String(tokenId)] = (this.state.tokens[String(tokenId)] || 0) + count; this.save(); return { ok: true, tokenId, count: this.state.tokens[String(tokenId)] }; }
  removeInventory(id) { const key = runeKey(id); const rune = this.state.inventory[key]; if (!rune) return null; for (const page of this.state.pages) page.slots = page.slots.map(v => runeKey(v) === key ? null : v); delete this.state.inventory[key]; this.save(); return rune; }
  strengthen({ mainId, materialIds = [] } = {}) {
    const main = this.state.inventory[runeKey(mainId)];
    const ids = Array.isArray(materialIds) ? materialIds : [];
    const materials = ids.map(id => this.state.inventory[runeKey(id)]);
    if (!main || materials.length !== 3 || materials.some(r => !r)) return { ok: false, reason: 'rune-material-not-found' };
    if (new Set([runeKey(main.id), ...ids.map(runeKey)]).size !== 4) return { ok: false, reason: 'rune-material-mismatch' };
    if (main.level >= 5) return { ok: false, reason: 'rune-maximum-level' };
    // The native client only requires the three sacrifices to be the same
    // level as the main rune. Mixed colours are explicitly allowed by the
    // strengthen dialog. The resulting colour/bonus is server-rolled; keep
    // that roll in the state model instead of always copying the main colour.
    if (materials.some(r => r.level !== main.level)) return { ok: false, reason: 'rune-material-mismatch' };
    for (const r of materials) this.removeInventory(r.id);
    // A legacy response could leave a pure-colour icon with an attribute
    // from another colour. Treat that rune as mixed before calculating the
    // next result, otherwise its next raise keeps producing mismatched data.
    let originalColor = Number(main.color);
    if (originalColor >= 1 && originalColor <= 4) {
      let expected = {};
      try { expected = template(originalColor, main.level).attrs || {}; } catch {}
      if (Object.keys(main.attrs || {}).some(attr => expected[attr] === undefined)) originalColor = 5;
    }
    const nextLevel = main.level + 1;
    const materialColors = materials.map(r => Number(r.color)).filter(color => color >= 1 && color <= 4);
    const allSameColor = originalColor >= 1 && originalColor <= 4 && materialColors.length === 3 && materialColors.every(color => color === originalColor);
    const allMaterialsSamePureColor = materialColors.length === 3 && materialColors.every(color => color === materialColors[0]);
    // Keep the RNG injectable so replay/tests stay repeatable.
    const randomIndex = count => Math.min(count - 1, Math.floor(Math.max(0, Math.min(.999999, Number(this.random()) || 0)) * count));

    // Preserve the base rune's attribute identities while taking their
    // configured value at the new level.  A pure-colour raise then adds one
    // newly unlocked line from the difference between the two colour rows;
    // for example red III -> IV can only add critical damage, while green IV
    // -> V rolls either physical or magical damage reduction.  Mixed raises
    // draw one line from every pure-colour row at the target level.  They
    // never copy an entire colour row.
    let baseNext = {};
    try { baseNext = template(originalColor, nextLevel).attrs || {}; } catch {}
    const baseAttrs = Object.entries(main.attrs || {});
    // A mixed rune has no attribute row of its own.  Its existing lines still
    // advance with the level, using the matching line from the corresponding
    // pure-colour row (green HP 63 -> 99, red attack speed 2 -> 4, etc.).
    // Keeping the old numeric value here made a mixed II -> III result display
    // the right attribute ids but the wrong values.
    const targetPoolValues = {};
    if (originalColor === 5) {
      for (const color of [1, 2, 3, 4]) {
        let row = {};
        try { row = template(color, nextLevel).attrs || {}; } catch {}
        for (const [attr, value] of Object.entries(row)) {
          if (targetPoolValues[attr] === undefined) targetPoolValues[attr] = Number(value) || 0;
        }
      }
    }
    main.attrs = Object.fromEntries(baseAttrs.map(([attr, value]) => [
      attr,
      originalColor === 5
        ? (targetPoolValues[attr] === undefined ? Number(value) || 0 : targetPoolValues[attr])
        : (baseNext[attr] === undefined ? Number(value) || 0 : baseNext[attr])
    ]));
    // A mixed base with three pure sacrifices takes the new line from that
    // sacrifice colour. In every other mixed case all four colour pools are
    // eligible. A pure base with unlike sacrifices follows the same rule.
    // The three sacrifices determine the colour pool whenever they are all
    // the same pure colour.  This rule is independent of the base rune's
    // colour: a pure red base with three green sacrifices may produce only
    // the newly-unlocked green line (and therefore becomes mixed), while a
    // mixed base with three red sacrifices remains mixed but can only add a
    // red line.  Only genuinely mixed sacrifices use the full four-colour
    // random pool.
    const poolColors = allMaterialsSamePureColor
      ? [materialColors[0]]
      : [1, 2, 3, 4];
    const poolAttrs = [];
    for (const color of poolColors) {
      for (const [attr, value] of unlockedAttrs(color, nextLevel)) {
        if (main.attrs[attr] === undefined && Number(value) > 0 && !poolAttrs.some(([id]) => id === attr)) poolAttrs.push([attr, Number(value), color]);
      }
    }
    if (allSameColor) {
      const newlyUnlocked = unlockedAttrs(originalColor, nextLevel)
        .filter(([attr]) => main.attrs[attr] === undefined);
      if (newlyUnlocked.length) {
        const [attr, value] = newlyUnlocked[randomIndex(newlyUnlocked.length)];
        main.attrs[attr] = Number(value) || 0;
      }
    } else if (poolAttrs.length) {
      const [attr, value] = poolAttrs[randomIndex(poolAttrs.length)];
      main.attrs[attr] = Number(value) || 0;
    }

    // The colour is a consequence of the selected new line. A pure base
    // stays pure only when that line belongs to its own colour; a mixed base
    // remains mixed regardless of the sacrifice colours.
    const addedAttr = Object.keys(main.attrs || {}).find(attr => !Object.prototype.hasOwnProperty.call(Object.fromEntries(baseAttrs), attr));
    const addedColor = addedAttr === undefined ? originalColor : poolAttrs.find(([attr]) => String(attr) === String(addedAttr))?.[2] || originalColor;
    const targetColor = originalColor === 5 ? 5 : (addedColor === originalColor ? originalColor : 5);
    const next = template(targetColor, nextLevel);
    main.level = next.level; main.itemId = next.itemId; main.name = next.name;
    main.color = targetColor; main.colorName = next.colorName;
    // A newly generated normal rune with no usable base row still needs the
    // selected result row; this only affects unknown/multi legacy entries.
    if (!Object.keys(main.attrs).length) {
      const resultAttrs = targetColor === 5 ? Object.fromEntries(poolAttrs) : (next.attrs || {});
      main.attrs = { ...resultAttrs };
    }
    main.attrs = sortRuneAttrs(main.attrs);
    main.nativeAttrIds = orderedRuneAttrs(main.attrs).map(([id]) => Number(id));
    main.effects = [...new Set([...(main.effects || []), ...(next.effects || [])])];
    const godsend = nextLevel === 5 ? this._resolveGodsend() : { id: null, name: null };
    main.godsend = godsend.id ? { id: godsend.id, name: godsend.name, limited: Boolean(godsend.limited) } : null;
    main.godsendId = godsend.id;
    main.godsendName = godsend.name;
    this.save(); return { ok: true, rune: clone(main), consumed: materials.map(r => r.id) };
  }
  compose({ materialIds = [] } = {}) {
    const ids = Array.isArray(materialIds) ? materialIds : [];
    const materials = ids.map(id => this.state.inventory[runeKey(id)]);
    if (![3, 4, 5].includes(materials.length) || materials.some(r => !r) || new Set(ids.map(runeKey)).size !== ids.length) return { ok: false, reason: 'rune-compose-materials' };
    const level = materials[0].level;
    if (level >= 5 || materials.some(r => r.level !== level || r.color !== materials[0].color)) return { ok: false, reason: 'rune-compose-mismatch' };
    for (const r of materials) this.removeInventory(r.id);
    const result = this.grant({ color: materials[0].color, level: level + 1, count: 1 });
    return { ok: true, consumed: ids.map(id => runeId(id)), rune: result.runes[0] };
  }
  composeCount({ count = 1 } = {}) {
    count = int(count); if (count <= 0 || count > 999) return { ok: false, reason: 'invalid-rune-compose-count' };
    const results = [];
    for (let i = 0; i < count; i++) {
      const groups = new Map();
      for (const rune of Object.values(this.state.inventory)) { const key = `${rune.color}:${rune.level}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(rune.id); }
      const ids = [...groups.values()].find(list => list.length >= 3);
      if (!ids) break;
      const result = this.compose({ materialIds: ids.slice(0, 3) }); if (!result.ok) break; results.push(result.rune);
    }
    return results.length ? { ok: true, count: results.length, runes: results } : { ok: false, reason: 'rune-compose-materials' };
  }
  demolish({ id } = {}) {
    const rune = this.state.inventory[runeKey(id)];
    if (!rune) return { ok: false, reason: 'rune-not-found' };
    if (rune.level > 1) {
      // Demolish is a level decrement on the same native item instance. The
      // client keeps its onlyId and any page slot pointing at that item.
      const wasMixed = Number(rune.color) === 5;
      const lowerLevel = rune.level - 1;
      let lowerColor = Number(rune.color);
      // There is no standalone multi-colour level-I item. When a mixed
      // level-II rune is dismantled, recover the colour of its level-I base
      // line and return that ordinary level-I rune instead of throwing on a
      // nonexistent 501 template.
      if (wasMixed && lowerLevel === 1) {
        const baseAttr = orderedRuneAttrs(rune.attrs || {})
          .map(([attr]) => Number(attr))
          .find(attr => [1, 2, 3, 4].some(color => {
            try { return template(color, 1).attrs[attr] !== undefined; } catch { return false; }
          }));
        lowerColor = [1, 2, 3, 4].find(color => {
          try { return baseAttr !== undefined && template(color, 1).attrs[baseAttr] !== undefined; } catch { return false; }
        }) || 1;
      }
      const lower = template(lowerColor, lowerLevel);
      rune.level = lower.level; rune.itemId = lower.itemId; rune.name = lower.name;
      rune.color = lowerColor; rune.colorName = lower.colorName;
      if (wasMixed && lowerLevel > 1) {
        // Mixed runes have no standalone attribute row.  Keep only lines that
        // exist at the lower level and take their lower-level values; native
        // 5 -> 4, for example, drops the level-V-only line while retaining
        // the other identities with level-IV values.
        const lowerPool = {};
        for (const color of [1, 2, 3, 4]) {
          let attrs = {};
          try { attrs = template(color, rune.level).attrs || {}; } catch {}
          Object.assign(lowerPool, attrs);
        }
        rune.attrs = Object.fromEntries(Object.keys(rune.attrs || {})
          .filter(attr => lowerPool[attr] !== undefined)
          .map(attr => [attr, lowerPool[attr]]));
      } else {
        rune.attrs = { ...lower.attrs };
      }
      rune.attrs = sortRuneAttrs(rune.attrs);
      rune.nativeAttrIds = orderedRuneAttrs(rune.attrs).map(([id]) => Number(id));
      rune.effects = [...lower.effects];
      if (rune.level < 5) { rune.godsend = null; rune.godsendId = null; rune.godsendName = null; }
      this.save();
      return { ok: true, fragments: 0, returned: clone(rune) };
    }
    this.removeInventory(rune.id);
    const fragments = 5; this.state.fragments = Number(this.state.fragments || 0) + fragments; this.save(); return { ok: true, fragments };
  }
  exchangeNormal({ fragments = 20, availableFragments = null, count = 1 } = {}) { count = Math.max(1, int(count)); fragments = int(fragments); const unitCost = 20, held = availableFragments === null ? Number(this.state.fragments || 0) : Math.max(0, int(availableFragments)); const cost = unitCost * count; if (fragments !== unitCost || held < cost) return { ok: false, reason: 'rune-fragments-insufficient', required: cost, available: held }; this.state.fragments = Math.max(0, held - cost); const runes = []; for (let i = 0; i < count; i++) { const color = 1 + Math.floor(Math.max(0, Math.min(.999999, Number(this.random()) || 0)) * 4); runes.push(this.grant({ color, level: 1, count: 1 }).runes[0]); } return { ok: true, cost, count, rune: runes[0], runes }; }
  exchangeAdvanced({ tokenId, color = null, level = null, attributeIds = [], godsendId = null, availableTokenCount = null } = {}) {
    const token = int(tokenId), row = customizeRows.find(r => Number(r[1]) === token); this.state.tokens ??= {};
    const fromInventory = availableTokenCount !== null && availableTokenCount !== undefined;
    const held = fromInventory ? Math.max(0, int(availableTokenCount)) : Number(this.state.tokens[String(token)] || 0);
    if (!row || held < 1) return { ok: false, reason: 'rune-exchange-token-insufficient' };
    const targetLevel = int(level) || Number(row[3]) || 5, configuredColor = Number(row[2]) || 0;
    const selectedGodsendId = int(godsendId);
    const selectedGodsend = selectedGodsendId ? GODSEND_BY_ID.get(selectedGodsendId) : null;
    if (selectedGodsendId && !selectedGodsend) return { ok: false, reason: 'unknown-godsend', godsendId: selectedGodsendId };
    const requested = [...new Set((Array.isArray(attributeIds) ? attributeIds : []).map(Number).filter(id => Number.isInteger(id) && id > 0))];
    // The client sends the selected native attribute vector.  Column 6 in
    // charmcustomize is a display/configuration value for several token
    // families (including a probability string for 7741-7746), so it cannot
    // safely be treated as a universal allow-list. Preserve every requested
    // positive selector and let the rune templates resolve values where the
    // attribute is confirmed.
    const targetColor = color || (configuredColor || (requested.length > 1 ? 5 : 1 + Math.floor(Math.max(0, Math.min(.999999, Number(this.random()) || 0)) * 4)));
    if (targetLevel < 1 || targetLevel > 5 || targetColor < 1 || targetColor > 5) return { ok: false, reason: 'invalid-rune-exchange-target' };
    if (!fromInventory) this.state.tokens[String(token)] = held - 1;
    const result = this.grant({ color: targetColor, level: targetLevel, count: 1 }), rune = result.runes[0];
    if (selectedGodsend) {
      rune.godsendId = selectedGodsend.id;
      rune.godsendName = selectedGodsend.name;
      rune.godsend = clone(selectedGodsend);
    }
    if (requested.length) {
      const values = {};
      for (const attrId of requested) {
        let value = 0;
        for (const candidateColor of [1, 2, 3, 4]) {
          try { value = Math.max(value, Number(template(candidateColor, targetLevel).attrs[attrId] || 0)); } catch {}
        }
        values[attrId] = value || 1;
      }
      rune.attrs = values; rune.nativeAttrIds = orderedRuneAttrs(values).map(([id]) => Number(id)); rune.color = targetColor; rune.colorName = colorName[targetColor] || 'multi';
      this.state.inventory[runeKey(rune.id)] = rune; this.save();
    }
    return { ok: true, tokenId: token, rune: clone(rune), attributes: requested,
      godsendId: selectedGodsend?.id || null, godsend: selectedGodsend ? clone(selectedGodsend) : null,
      consumedTokenId: token, tokenSource: fromInventory ? 'inventory' : 'rune-state' };
  }
  setNativeBoard({ page = this.state.currentPage, runeId: requestedId, name = '', values = [], trailing = 0, layout = '' } = {}) {
    page = int(page); if (!this.state.pages[page]) return { ok: false, reason: 'rune-page-not-found' };
    if (layout === 'named48') {
      if (values.length !== SLOT_COUNT) return { ok: false, reason: 'invalid-rune-board' };
      // Values are ordinary u32 instance ids, not packed/shifted integers.
      const ids = values.map(v => Number(v) >>> 0);
      if (ids.some(id => id && !this.state.inventory[runeKey(id)]))
        return { ok: false, reason: 'rune-not-found' };
      // Current equip_charm.lua One/Two/Three/Four/Five tiles cover
      // 1/2/3/4/8 triangles. The board repeats one instance's onlyId for
      // each occupied triangle, not for additional copies of that rune.
      // Oct 7's level-II instances 2/3/4 each occupy exactly two cells.
      const areas = new Map([[1,1],[2,2],[3,3],[4,4],[5,8]]),counts = new Map();
      for (const id of ids) if (id) counts.set(id,(counts.get(id)||0)+1);
      for (const [id,count] of counts) {
        const expected = areas.get(this.state.inventory[runeKey(id)].level);
        if (!expected || count !== expected) return { ok: false, reason: 'invalid-rune-occupancy' };
      }
      const normalizedName = normalizePageName(name, '');
      if (normalizedName) this.state.pages[page].name = normalizedName;
      this.state.pages[page].slots = ids.map(id => id || null);
      this.state.nativeBoards ??= {};
      this.state.nativeBoards[String(page)] = { layout: 'named48', runeId: null, values: ids, trailing: 0 };
      this.save(); return { ok: true, page, values: ids };
    }
    const rune = this.ensureRune(requestedId); if (!rune) return { ok: false, reason: 'rune-not-found' };
    const slots = Array.from(values || []).slice(0, SLOT_COUNT).map(v => Number(v) || 0);
    // The native save carries the whole board as 48 level/occupancy words.
    // Reconstruct the affected rune's placements so subsequent loadouts see
    // the same page even when the server does not know the client's item row.
    const board = this.state.pages[page].slots;
    for (let i = 0; i < board.length; i++) if (runeKey(board[i]) === runeKey(rune.id)) board[i] = null;
    for (let i = 0; i < slots.length; i++) if (slots[i]) board[i] = rune.id;
    this.state.nativeBoards ??= {};
    this.state.nativeBoards[String(page)] = { runeId: rune.id, values: Array.from(values || []).map(v => Number(v) >>> 0), trailing: Number(trailing) || 0 };
    this.save(); return { ok: true, page, runeId: rune.id, values: this.state.nativeBoards[String(page)].values };
  }
  combatBonus(page = this.state.currentPage) { const p = this.state.pages[int(page)]; const out = {}; for (const id of new Set((p?.slots || []).filter(Boolean).map(runeKey))) { const rune = this.state.inventory[runeKey(id)]; for (const [attr, value] of Object.entries(rune?.attrs || {})) out[attr] = (out[attr] || 0) + value; } return out; }
  setSlot(args) { return this.slot(args); }
  activatePage(index) { return this.usePage(index); }
  clearPage(index = this.state.currentPage) { return this.resetPage(index); }
}

module.exports = {
  RuneState, template, unlockedAttrs, sortRuneAttrs, orderedRuneAttrs, patterns, customizeRows, SLOT_COUNT,
  godsendRows: GODSEND_ROWS, regularGodsendIds: REGULAR_GODSEND_IDS, limitedGodsendIds: LIMITED_GODSEND_IDS,
  strengthenBlockedGodsendIds: [...STRENGTHEN_BLOCKED_GODSEND_IDS],
};
