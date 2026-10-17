'use strict';

const fs = require('./persistence/state-files').io;
const path = require('path');

function normalizeGuid(guid) {
  const value = Buffer.isBuffer(guid) ? guid.toString('hex') : guid;
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/i.test(value) || /^0{16}$/i.test(value))
    throw new RangeError('equipment GUID must be eight nonzero bytes');
  return value.toLowerCase();
}

function validLevel(level) {
  return Number.isInteger(level) && level >= 0 && level <= 17;
}

// This file contains enhancement state only. The economy adapter must commit
// debits and the new state as one guarded transaction before replying success.
class EnhancementState {
  constructor(file) {
    if (!path.isAbsolute(file)) throw new TypeError('state file must be absolute');
    this.file = file;
    this.instances = {};
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data?.version !== 1 || !data.instances || typeof data.instances !== 'object' || Array.isArray(data.instances))
        throw new Error('invalid enhancement state');
      for (const [guid, value] of Object.entries(data.instances)) {
        if (normalizeGuid(guid) !== guid || !Number.isSafeInteger(value?.itemId) || value.itemId <= 0 ||
            !validLevel(value.level) || (value.blessing !== undefined &&
            (!Number.isSafeInteger(value.blessing) || value.blessing < 0 || value.blessing > 0xffffffff)))
          throw new Error(`invalid enhancement state for ${guid}`);
        this.instances[guid] = {itemId:value.itemId, level:value.level,
          ...(value.blessing === undefined ? {} : {blessing:value.blessing})};
      }
    }
  }

  get(guid, itemId) {
    const key = normalizeGuid(guid);
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new RangeError('invalid equipment item ID');
    const existing = this.instances[key];
    if (existing && existing.itemId !== itemId) throw new Error('equipment GUID identity changed');
    return existing?.level ?? 0;
  }

  getRecord(guid, itemId) {
    this.get(guid, itemId);
    return this.instances[normalizeGuid(guid)] || {itemId, level:0};
  }

  peek(guid, itemId) {
    this.get(guid,itemId);
    const row=this.instances[normalizeGuid(guid)];
    return row ? {...row} : null;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({version:1, instances:this.instances}));
  }

  // Atomic replacement of this one file. A caller doing resource/wallet debits
  // must supply the surrounding cross-file pending/rollback mechanism.
  set(guid, itemId, level, blessing) {
    const key = normalizeGuid(guid);
    this.get(key, itemId);
    if (!validLevel(level)) throw new RangeError('enhancement level must be 0..17');
    if (blessing !== undefined && (!Number.isSafeInteger(blessing) || blessing < 0 || blessing > 0xffffffff))
      throw new RangeError('invalid blessing value');
    const previous = this.instances[key];
    const next = {...this.instances, [key]:{itemId, level,
      ...((blessing ?? previous?.blessing) === undefined ? {} : {blessing:blessing ?? previous.blessing})}};
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(this.file), {recursive:true});
    try {
      fs.writeFileSync(temp, JSON.stringify({version:1, instances:next}));
      fs.renameSync(temp, this.file);
    } catch (error) {
      try { fs.rmSync(temp, {force:true}); } catch {}
      throw error;
    }
    this.instances = next;
  }
}

module.exports = {EnhancementState, normalizeGuid};
