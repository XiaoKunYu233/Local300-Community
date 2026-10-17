'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// SSummonerGrowthUp parser 9ba6d0 stores protobuf field 3 at row+0x20.
// Loader 528990 copies that member to the level map; c1d5a0 looks up level+1.
// This establishes the client's next-level display threshold, not award rules,
// experience carry-over, or permission to grant milestone items.
function parse(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 65535) {
    throw Error('Invalid growth catalog');
  }
  const levels = rows.map(row => {
    if (!row || !Number.isInteger(row['1']) || row['1'] < 1 || row['1'] > 65535 ||
        !Number.isInteger(row['3']) || row['3'] < 0 || row['3'] > 0x7fffffff) {
      throw Error('Invalid growth catalog row');
    }
    return Object.freeze({level: row['1'], requiredExperience: row['3']});
  }).sort((a, b) => a.level - b.level);
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].level !== i + 1 || (i === 0 ? levels[i].requiredExperience !== 0 : levels[i].requiredExperience <= 0)) {
      throw Error('Missing, duplicate, or invalid growth level');
    }
  }
  return Object.freeze({maxLevel: levels.length, levels: Object.freeze(levels)});
}

function load() {
  const bytes = fs.readFileSync(path.join(__dirname, 'logs/cfg/summonergrowthup.json'));
  return Object.freeze({...parse(JSON.parse(bytes)), sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex')});
}

function nextLevel(catalog, level) {
  if (!Number.isInteger(level) || level < 1 || level > catalog.maxLevel) throw Error('Growth level outside catalog');
  // No invented level 301 or zero-cost upgrade at the configured cap.
  return level === catalog.maxLevel ? null : catalog.levels[level];
}

module.exports = {parse, load, nextLevel};
