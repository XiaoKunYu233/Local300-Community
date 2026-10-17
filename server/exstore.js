'use strict';

const fs = require('./persistence/state-files').io;
const path = require('path');
const { containerOf } = require('./item-containers');

const clone = value => JSON.parse(JSON.stringify(value));
const hex = value => String(value || '').toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * Persistent model for the 17060-17067 dimensional bag.  The native list
 * record is a large fixed-width equipment record; keeping the item instance
 * here lets the economy layer enforce the two client rules that are already
 * proven in equip_farbag.lua: stackable items and safety-locked instances
 * cannot be stored.
 */
class ExStoreState {
  constructor({ file = path.join(__dirname, 'exstore-state.json'), capacity = 170 } = {}) {
    this.file = file; this.capacity = capacity; this.state = this.read();
  }
  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!value || value.version !== 1 || typeof value.items !== 'object') throw Error('invalid-exstore-state');
      value.capacity = Number(value.capacity) || this.capacity;
      value.items = value.items || {};
      return value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { version: 1, capacity: this.capacity, items: {}, updatedAt: Date.now() };
    }
  }
  save() {
    this.state.updatedAt = Date.now(); fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2)); fs.renameSync(tmp, this.file);
  }
  list() { return clone(this.state); }
  entries() { return Object.values(this.state.items).map(clone); }
  find(guid) { const id = hex(guid); return Object.values(this.state.items).find(item => hex(item.guid) === id) || null; }
  findSlot(slot) { return this.state.items[String(Number(slot))] || null; }
  canStore(item) {
    if (!item || !Number(item.itemId)) return { ok: false, reason: 'exstore-item-not-found' };
    if (Number(item.count || 1) > 1 || containerOf(Number(item.itemId)) !== 'slot') return { ok: false, reason: 'exstore-stackable-item' };
    if (item.locked || Number(item.unlockAt) > Math.floor(Date.now() / 1000) || Number(item.lockEndTime) > Math.floor(Date.now() / 1000)) return { ok: false, reason: 'exstore-locked-item' };
    return { ok: true };
  }
  put(item, slot = null) {
    const valid = this.canStore(item); if (!valid.ok) return valid;
    const existing = this.find(item.guid); if (existing) return { ok: false, reason: 'exstore-duplicate-item' };
    const used = new Set(Object.keys(this.state.items).map(Number));
    if (slot === null || slot === undefined) { slot = 0; while (used.has(slot) && slot < this.state.capacity) slot++; }
    slot = Number(slot); if (!Number.isInteger(slot) || slot < 0 || slot >= this.state.capacity || used.has(slot)) return { ok: false, reason: 'exstore-full' };
    this.state.items[String(slot)] = { ...clone(item), count: 1, exstoreSlot: slot };
    this.save(); return { ok: true, slot, item: clone(this.state.items[String(slot)]) };
  }
  take({ guid = null, slot = null } = {}) {
    const item = guid ? this.find(guid) : this.findSlot(slot);
    if (!item) return { ok: false, reason: 'exstore-item-not-found' };
    delete this.state.items[String(item.exstoreSlot)]; this.save();
    return { ok: true, item: clone(item), slot: Number(item.exstoreSlot) };
  }
  // The wire request contains an opaque native selector. Keep all 8-byte
  // candidates so a future capture can bind it to a concrete onlyId without
  // losing today's evidence.
  static selector(payload) {
    const p = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0), ids = [];
    for (let offset = 0; offset + 8 <= p.length; offset++) {
      const value = p.subarray(offset, offset + 8).toString('hex');
      if (!/^0+$/.test(value) && !/^f{16}$/i.test(value) && !ids.includes(value)) ids.push(value);
    }
    return { raw: p.toString('hex'), candidates: ids, count: p.length >= 2 ? p.readUInt16LE(0) : 0 };
  }
}

module.exports = { ExStoreState };
