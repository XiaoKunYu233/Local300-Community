'use strict';
const fs = require('./persistence/state-files').io, path = require('path');
const clone = value => JSON.parse(JSON.stringify(value));
const clean = value => String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 16);
class ItemLockState {
  constructor({ file = path.join(__dirname, 'item-lock-state.json') } = {}) { this.file = file; this.state = this.read(); }
  read() { try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (!value || value.version !== 1 || typeof value.items !== 'object') throw Error('invalid-item-lock-state'); return value; } catch (e) { if (e.code !== 'ENOENT') throw e; return { version: 1, items: {}, updatedAt: Date.now() }; } }
  save() { this.state.updatedAt = Date.now(); fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.file); }
  lock(guid, locked = true) { const id = clean(guid); if (!id || id.length !== 16) return { ok: false, reason: 'invalid-item-guid' }; const item = this.state.items[id] ||= {}; item.locked = Boolean(locked); if (!item.locked) item.unlockAt = 0; this.save(); return { ok: true, guid: id, locked: item.locked, unlockAt: Number(item.unlockAt) || 0 }; }
  requestUnlock(guid, now = Date.now()) { const id = clean(guid); if (!id || id.length !== 16) return { ok: false, reason: 'invalid-item-guid' }; const item = this.state.items[id] ||= {}; if (!item.locked) return { ok: true, guid: id, locked: false, unlockAt: 0, alreadyUnlocked: true }; const nowSec = Math.floor(Number(now) / 1000), current = Number(item.unlockAt) || 0; if (current > nowSec) return { ok: true, guid: id, locked: true, unlockAt: current, pending: true }; if (current && current <= nowSec) { item.locked = false; item.unlockAt = 0; this.save(); return { ok: true, guid: id, locked: false, unlockAt: 0, unlocked: true }; } item.unlockAt = nowSec + 96 * 60 * 60; this.save(); return { ok: true, guid: id, locked: true, unlockAt: item.unlockAt, pending: true }; }
  get(guid) { const value = this.state.items[clean(guid)]; return value ? clone(value) : null; }
}
module.exports = { ItemLockState, cleanItemGuid: clean };
